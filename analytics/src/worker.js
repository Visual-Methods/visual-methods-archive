const SOURCE = "cloudflare-web-analytics";
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const METHOD_PATHS = [
  "/method.html",
  "/method-002.html",
  "/method-003.html",
  "/method-004.html",
  "/method-005.html",
  "/method-006.html"
];

const DIMENSION_FIELDS = {
  path: "requestPath",
  country: "countryName",
  referrer: "refererHost",
  device: "deviceType",
  browser: "userAgentBrowser",
  os: "userAgentOS"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!dashboardAllowed(request, env)) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return html(DASHBOARD_HTML);
    }
    if (url.pathname === "/api/overview") {
      return json(await getOverview(env));
    }
    if (url.pathname === "/api/paths") {
      return json(await getPaths(env, url.searchParams));
    }
    if (url.pathname === "/api/monthly-dimensions") {
      return json(await getMonthlyDimensions(env, url.searchParams));
    }
    if (url.pathname === "/api/runs") {
      return json(await getRuns(env));
    }
    if (url.pathname === "/api/collect" && request.method === "POST") {
      const type = url.searchParams.get("type") || "realtime";
      return json(await runCollector(type, env));
    }
    if (url.pathname === "/api/seed-demo" && request.method === "POST") {
      return json(await seedDemo(env));
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleCron(controller.cron, env));
  }
};

async function handleCron(cron, env) {
  if (cron === "*/5 * * * *") return runCollector("realtime", env);
  if (cron === "10 0 * * *") return runCollector("daily", env);
  if (cron === "30 0 1 * *") return runCollector("monthly", env);
  return recordRun(env, {
    run_type: "unknown",
    status: "skipped",
    period_start: null,
    period_end: null,
    rows_written: 0,
    message: `No collector mapped for cron ${cron}`
  });
}

async function runCollector(type, env) {
  try {
    if (type === "realtime") return await collectRealtime(env);
    if (type === "daily") return await collectDaily(env);
    if (type === "monthly") return await collectMonthly(env);
    if (type === "demo") return await seedDemo(env);
    throw new Error(`Unknown collector type: ${type}`);
  } catch (err) {
    return await recordRun(env, {
      run_type: type,
      status: "failed",
      period_start: null,
      period_end: null,
      rows_written: 0,
      message: err.message || String(err)
    });
  }
}

async function collectRealtime(env) {
  const now = new Date();
  const end = truncateToMinute(now);
  const todayStart = startOfUtcDay(end);
  const last24Start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  const todayRows = await fetchDimensionRows(env, "path", todayStart, end);
  const last24Rows = await fetchDimensionRows(env, "path", last24Start, end);

  await replaceRealtimeRows(env, "today", todayStart, end, todayRows);
  await replaceRealtimeRows(env, "last24h", last24Start, end, last24Rows);

  return await recordRun(env, {
    run_type: "realtime",
    status: "ok",
    period_start: last24Start.toISOString(),
    period_end: end.toISOString(),
    rows_written: todayRows.length + last24Rows.length,
    sample_interval: maxSampleInterval([...todayRows, ...last24Rows]),
    message: "Updated today and last24h path snapshots"
  });
}

async function collectDaily(env) {
  const now = new Date();
  const end = startOfUtcDay(now);
  const start = addDays(end, -1);
  const date = isoDate(start);

  const rows = await fetchDimensionRows(env, "path", start, end);
  const summary = summarizeRows(rows);
  const finalizedAt = new Date().toISOString();

  await env.ANALYTICS_DB.prepare(
    `INSERT OR REPLACE INTO traffic_daily_summary
      (date, visits, page_views, sample_interval, source, finalized_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(date, summary.visits, summary.page_views, maxSampleInterval(rows), SOURCE, finalizedAt).run();

  await replaceDailyPathRows(env, date, rows, finalizedAt);

  return await recordRun(env, {
    run_type: "daily",
    status: "ok",
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    rows_written: rows.length + 1,
    sample_interval: maxSampleInterval(rows),
    message: `Finalized daily data for ${date}`
  });
}

async function collectMonthly(env) {
  const now = new Date();
  const currentMonth = startOfUtcMonth(now);
  const previousMonth = addMonths(currentMonth, -1);
  const month = isoMonth(previousMonth);
  const finalizedAt = new Date().toISOString();

  const summary = await env.ANALYTICS_DB.prepare(
    `SELECT COALESCE(SUM(visits), 0) AS visits,
            COALESCE(SUM(page_views), 0) AS page_views
       FROM traffic_daily_summary
      WHERE date >= ? AND date < ?`
  ).bind(isoDate(previousMonth), isoDate(currentMonth)).first();

  await env.ANALYTICS_DB.prepare(
    `INSERT OR REPLACE INTO traffic_monthly_summary
      (month, visits, page_views, source, finalized_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(month, summary.visits || 0, summary.page_views || 0, SOURCE, finalizedAt).run();

  await env.ANALYTICS_DB.prepare("DELETE FROM traffic_monthly_path WHERE month = ?").bind(month).run();
  await env.ANALYTICS_DB.prepare(
    `INSERT INTO traffic_monthly_path
      (month, path, visits, page_views, source, finalized_at)
     SELECT ?, path, SUM(visits), SUM(page_views), ?, ?
       FROM traffic_daily_path
      WHERE date >= ? AND date < ?
      GROUP BY path`
  ).bind(month, SOURCE, finalizedAt, isoDate(previousMonth), isoDate(currentMonth)).run();

  let dimensionRows = 0;
  for (const dimension of ["country", "referrer", "device", "browser", "os"]) {
    try {
      const rows = await fetchDimensionRows(env, dimension, previousMonth, currentMonth);
      await replaceMonthlyDimensionRows(env, month, dimension, rows, finalizedAt);
      dimensionRows += rows.length;
    } catch (err) {
      await recordRun(env, {
        run_type: `monthly-${dimension}`,
        status: "failed",
        period_start: previousMonth.toISOString(),
        period_end: currentMonth.toISOString(),
        rows_written: 0,
        message: err.message || String(err)
      });
    }
  }

  return await recordRun(env, {
    run_type: "monthly",
    status: "ok",
    period_start: previousMonth.toISOString(),
    period_end: currentMonth.toISOString(),
    rows_written: dimensionRows + 2,
    message: `Finalized monthly data for ${month}`
  });
}

async function fetchDimensionRows(env, dimension, start, end) {
  const field = DIMENSION_FIELDS[dimension];
  if (!field) throw new Error(`Unsupported analytics dimension: ${dimension}`);
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const siteTag = env.CF_WEB_ANALYTICS_SITE_TAG;
  if (!token || !accountId || !siteTag) {
    throw new Error("Missing CF_API_TOKEN, CF_ACCOUNT_ID, or CF_WEB_ANALYTICS_SITE_TAG");
  }

  const query = `
    query VisualMethodsWebAnalytics($accountTag: string, $siteTag: string, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          rumPageloadEventsAdaptiveGroups(
            limit: 1000
            filter: { siteTag: $siteTag, datetime_geq: $start, datetime_lt: $end }
            orderBy: [count_DESC]
          ) {
            dimensions { ${field} }
            count
            sum { visits }
            avg { sampleInterval }
          }
        }
      }
    }`;

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        siteTag,
        start: start.toISOString(),
        end: end.toISOString()
      }
    })
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    const message = payload.errors ? payload.errors.map(e => e.message).join("; ") : response.statusText;
    throw new Error(`Cloudflare GraphQL query failed: ${message}`);
  }

  const groups = payload.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
  return groups
    .map(group => ({
      value: normalizeDimensionValue(group.dimensions?.[field], dimension),
      visits: toInt(group.sum?.visits),
      page_views: toInt(group.count),
      sample_interval: toNumber(group.avg?.sampleInterval)
    }))
    .filter(row => row.value && (row.visits > 0 || row.page_views > 0));
}

async function replaceRealtimeRows(env, windowKey, start, end, rows) {
  const now = new Date().toISOString();
  await env.ANALYTICS_DB.prepare("DELETE FROM traffic_realtime_path WHERE window_key = ?").bind(windowKey).run();
  if (!rows.length) return;
  await env.ANALYTICS_DB.batch(rows.map(row => env.ANALYTICS_DB.prepare(
    `INSERT INTO traffic_realtime_path
      (window_key, path, window_start, window_end, visits, page_views, sample_interval, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(windowKey, row.value, start.toISOString(), end.toISOString(), row.visits, row.page_views, row.sample_interval, SOURCE, now)));
}

async function replaceDailyPathRows(env, date, rows, finalizedAt) {
  await env.ANALYTICS_DB.prepare("DELETE FROM traffic_daily_path WHERE date = ?").bind(date).run();
  if (!rows.length) return;
  await env.ANALYTICS_DB.batch(rows.map(row => env.ANALYTICS_DB.prepare(
    `INSERT INTO traffic_daily_path
      (date, path, visits, page_views, sample_interval, source, finalized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(date, row.value, row.visits, row.page_views, row.sample_interval, SOURCE, finalizedAt)));
}

async function replaceMonthlyDimensionRows(env, month, dimension, rows, finalizedAt) {
  await env.ANALYTICS_DB.prepare(
    "DELETE FROM traffic_monthly_dimension WHERE month = ? AND dimension_type = ?"
  ).bind(month, dimension).run();
  if (!rows.length) return;
  await env.ANALYTICS_DB.batch(rows.map(row => env.ANALYTICS_DB.prepare(
    `INSERT INTO traffic_monthly_dimension
      (month, dimension_type, dimension_value, visits, page_views, sample_interval, source, finalized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(month, dimension, row.value, row.visits, row.page_views, row.sample_interval, SOURCE, finalizedAt)));
}

async function getOverview(env) {
  const realtime = await env.ANALYTICS_DB.prepare(
    `SELECT window_key, SUM(visits) AS visits, SUM(page_views) AS page_views, MAX(updated_at) AS updated_at
       FROM traffic_realtime_path
      GROUP BY window_key`
  ).all();
  const daily = await env.ANALYTICS_DB.prepare(
    "SELECT date, visits, page_views FROM traffic_daily_summary ORDER BY date DESC LIMIT 45"
  ).all();
  const monthly = await env.ANALYTICS_DB.prepare(
    "SELECT month, visits, page_views FROM traffic_monthly_summary ORDER BY month DESC LIMIT 18"
  ).all();
  const allTime = await env.ANALYTICS_DB.prepare(
    "SELECT COALESCE(SUM(visits), 0) AS visits, COALESCE(SUM(page_views), 0) AS page_views FROM traffic_monthly_summary"
  ).first();
  return {
    site: env.SITE_NAME || "Visual Methods",
    host: env.SITE_HOST || "visualmethods.pages.dev",
    realtime: realtime.results || [],
    daily: (daily.results || []).reverse(),
    monthly: (monthly.results || []).reverse(),
    all_time: allTime || { visits: 0, page_views: 0 }
  };
}

async function getPaths(env, params) {
  const period = params.get("period") || "realtime";
  const limit = Math.min(Math.max(toInt(params.get("limit")) || 25, 1), 100);

  if (period === "daily") {
    const date = params.get("date") || isoDate(addDays(startOfUtcDay(new Date()), -1));
    return await queryRows(env,
      "SELECT path, visits, page_views FROM traffic_daily_path WHERE date = ? ORDER BY page_views DESC LIMIT ?",
      [date, limit],
      { period, date }
    );
  }
  if (period === "monthly") {
    const month = params.get("month") || await latestMonth(env, "traffic_monthly_path") || isoMonth(addMonths(startOfUtcMonth(new Date()), -1));
    return await queryRows(env,
      "SELECT path, visits, page_views FROM traffic_monthly_path WHERE month = ? ORDER BY page_views DESC LIMIT ?",
      [month, limit],
      { period, month }
    );
  }

  const windowKey = params.get("window") || "today";
  return await queryRows(env,
    `SELECT path, visits, page_views, window_start, window_end, updated_at
       FROM traffic_realtime_path
      WHERE window_key = ?
      ORDER BY page_views DESC
      LIMIT ?`,
    [windowKey, limit],
    { period: "realtime", window: windowKey }
  );
}

async function getMonthlyDimensions(env, params) {
  const month = params.get("month") || await latestMonth(env, "traffic_monthly_dimension") || isoMonth(addMonths(startOfUtcMonth(new Date()), -1));
  const dimension = params.get("dimension") || "country";
  return await queryRows(env,
    `SELECT dimension_value AS value, visits, page_views
       FROM traffic_monthly_dimension
      WHERE month = ? AND dimension_type = ?
      ORDER BY page_views DESC
      LIMIT 25`,
    [month, dimension],
    { month, dimension }
  );
}

async function latestMonth(env, table) {
  const result = await env.ANALYTICS_DB.prepare(`SELECT MAX(month) AS month FROM ${table}`).first();
  return result?.month || null;
}

async function getRuns(env) {
  return await queryRows(env,
    `SELECT run_type, status, rows_written, period_start, period_end, message, created_at
       FROM collector_runs
      ORDER BY created_at DESC
      LIMIT 20`,
    [],
    {}
  );
}

async function queryRows(env, sql, bindings, meta) {
  const stmt = env.ANALYTICS_DB.prepare(sql);
  const result = await stmt.bind(...bindings).all();
  return { ...meta, rows: result.results || [] };
}

async function recordRun(env, run) {
  const payload = {
    run_type: run.run_type,
    status: run.status,
    source: run.source || SOURCE,
    period_start: run.period_start || null,
    period_end: run.period_end || null,
    rows_written: run.rows_written || 0,
    sample_interval: run.sample_interval || null,
    message: run.message || null
  };
  await env.ANALYTICS_DB.prepare(
    `INSERT INTO collector_runs
      (id, run_type, status, source, period_start, period_end, rows_written, sample_interval, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    payload.run_type,
    payload.status,
    payload.source,
    payload.period_start,
    payload.period_end,
    payload.rows_written,
    payload.sample_interval,
    payload.message
  ).run();
  return payload;
}

async function seedDemo(env) {
  const now = new Date();
  const finalizedAt = now.toISOString();
  const todayStart = startOfUtcDay(now);
  const paths = METHOD_PATHS.map((path, index) => ({
    value: path,
    visits: 30 + index * 7,
    page_views: 48 + index * 11,
    sample_interval: 1
  }));
  await replaceRealtimeRows(env, "today", todayStart, now, paths);
  await replaceRealtimeRows(env, "last24h", new Date(now.getTime() - 86400000), now, paths.map((row, index) => ({
    ...row,
    visits: row.visits + 8 + index,
    page_views: row.page_views + 14 + index
  })));

  for (let i = 14; i >= 1; i--) {
    const day = addDays(todayStart, -i);
    const date = isoDate(day);
    const dayRows = paths.map((row, index) => ({
      ...row,
      visits: row.visits + ((14 - i) * 2) + index,
      page_views: row.page_views + ((14 - i) * 3) + index
    }));
    const summary = summarizeRows(dayRows);
    await env.ANALYTICS_DB.prepare(
      `INSERT OR REPLACE INTO traffic_daily_summary
        (date, visits, page_views, sample_interval, source, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(date, summary.visits, summary.page_views, 1, "demo", finalizedAt).run();
    await replaceDailyPathRows(env, date, dayRows, finalizedAt);
  }

  const month = isoMonth(todayStart);
  await env.ANALYTICS_DB.prepare(
    `INSERT OR REPLACE INTO traffic_monthly_summary
      (month, visits, page_views, source, finalized_at)
     SELECT ?, SUM(visits), SUM(page_views), ?, ?
       FROM traffic_daily_summary`
  ).bind(month, "demo", finalizedAt).run();
  await env.ANALYTICS_DB.prepare("DELETE FROM traffic_monthly_path WHERE month = ?").bind(month).run();
  await env.ANALYTICS_DB.prepare(
    `INSERT INTO traffic_monthly_path
      (month, path, visits, page_views, source, finalized_at)
     SELECT ?, path, SUM(visits), SUM(page_views), ?, ?
       FROM traffic_daily_path
      GROUP BY path`
  ).bind(month, "demo", finalizedAt).run();

  await replaceMonthlyDimensionRows(env, month, "country", [
    { value: "United States", visits: 180, page_views: 260, sample_interval: 1 },
    { value: "Canada", visits: 92, page_views: 130, sample_interval: 1 },
    { value: "China", visits: 74, page_views: 101, sample_interval: 1 },
    { value: "France", visits: 41, page_views: 62, sample_interval: 1 }
  ], finalizedAt);

  return await recordRun(env, {
    run_type: "demo",
    status: "ok",
    rows_written: 14 * paths.length + paths.length * 2,
    message: "Seeded local demo analytics data"
  });
}

function dashboardAllowed(request, env) {
  const url = new URL(request.url);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (isLocal) return true;
  if (env.DASHBOARD_ENABLED === "true") return true;
  const token = env.DASHBOARD_TOKEN;
  if (!token) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${token}` || url.searchParams.get("token") === token;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

function html(content) {
  return new Response(content, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function summarizeRows(rows) {
  return rows.reduce((acc, row) => {
    acc.visits += row.visits || 0;
    acc.page_views += row.page_views || 0;
    return acc;
  }, { visits: 0, page_views: 0 });
}

function maxSampleInterval(rows) {
  const values = rows.map(row => row.sample_interval).filter(v => typeof v === "number" && Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

function normalizeDimensionValue(value, dimension) {
  if (!value) return dimension === "referrer" ? "(direct)" : "(unknown)";
  if (dimension === "path") {
    try {
      const path = value.startsWith("http") ? new URL(value).pathname : value;
      return path === "/" ? "/" : path;
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function truncateToMinute(date) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  return d;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function addMonths(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoMonth(date) {
  return date.toISOString().slice(0, 7);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visual Methods Analytics</title>
  <style>
    :root{--bg:#f7f4eb;--panel:#fffdf7;--ink:#161616;--muted:#6f6a60;--line:#d9d2c3;--accent:#2e7290;--accent2:#ac5832}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{padding:28px 32px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:24px;align-items:flex-end}
    h1{font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1;margin:0} .sub{color:var(--muted);max-width:620px;margin-top:8px}
    main{padding:28px 32px 48px;max-width:1360px;margin:auto}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px}
    button,select{border:1px solid var(--ink);background:transparent;color:var(--ink);padding:8px 12px;border-radius:2px;font:inherit;cursor:pointer}
    button:hover{background:var(--ink);color:var(--bg)} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.card{border:1px solid var(--line);background:var(--panel);padding:18px;border-radius:2px}
    .metric{font-family:Georgia,serif;font-size:36px;line-height:1}.label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
    .two{display:grid;grid-template-columns:1.25fr .75fr;gap:16px;margin-top:16px}.barrow{display:grid;grid-template-columns:minmax(160px,1fr) 3fr auto;gap:12px;align-items:center;margin:9px 0}.bar{height:10px;background:#e6dfd0;position:relative}.bar span{display:block;height:100%;background:var(--accent)}
    table{width:100%;border-collapse:collapse}td,th{padding:8px 0;border-bottom:1px solid var(--line);text-align:left}th{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-weight:500}
    .status-ok{color:#28704f}.status-failed{color:#9b3a2b}.small{font-size:12px;color:var(--muted)}@media(max-width:900px){.grid,.two{grid-template-columns:1fr}header{display:block}}
  </style>
</head>
<body>
  <header>
    <div><h1>Visual Methods Analytics</h1><div class="sub">Local dashboard for Cloudflare D1 snapshots. It is private by default and intended to run with wrangler dev.</div></div>
    <div class="small" id="host"></div>
  </header>
  <main>
    <div class="toolbar">
      <button id="refresh">Refresh</button>
      <button id="collectRealtime">Run realtime collector</button>
      <button id="seedDemo">Seed demo data</button>
      <select id="pathPeriod"><option value="realtime">Today snapshot</option><option value="monthly">Monthly paths</option></select>
    </div>
    <section class="grid">
      <div class="card"><div class="label">Today visits</div><div class="metric" id="todayVisits">0</div></div>
      <div class="card"><div class="label">Today page views</div><div class="metric" id="todayPageViews">0</div></div>
      <div class="card"><div class="label">All-time visits</div><div class="metric" id="allVisits">0</div></div>
      <div class="card"><div class="label">All-time page views</div><div class="metric" id="allPageViews">0</div></div>
    </section>
    <section class="two">
      <div class="card"><div class="label">Path page views</div><div id="paths"></div></div>
      <div class="card"><div class="label">Monthly country breakdown</div><div id="countries"></div></div>
    </section>
    <section class="two">
      <div class="card"><div class="label">Daily trend</div><div id="daily"></div></div>
      <div class="card"><div class="label">Recent collector runs</div><div id="runs"></div></div>
    </section>
  </main>
  <script>
    const fmt = new Intl.NumberFormat();
    document.getElementById('refresh').onclick = load;
    document.getElementById('pathPeriod').onchange = loadPaths;
    document.getElementById('collectRealtime').onclick = async () => { await post('/api/collect?type=realtime'); await load(); };
    document.getElementById('seedDemo').onclick = async () => { await post('/api/seed-demo'); await load(); };
    async function get(url){ const r = await fetch(url); if(!r.ok) throw new Error(await r.text()); return r.json(); }
    async function post(url){ const r = await fetch(url, {method:'POST'}); if(!r.ok) alert(await r.text()); return r.json(); }
    function text(id, value){ document.getElementById(id).textContent = fmt.format(value || 0); }
    function bars(el, rows, nameKey='path'){
      const max = Math.max(1, ...rows.map(r => r.page_views || 0));
      el.innerHTML = rows.length ? rows.map(r => '<div class="barrow"><span>'+escapeHtml(r[nameKey] || r.value || '')+'</span><div class="bar"><span style="width:'+((r.page_views||0)/max*100)+'%"></span></div><b>'+fmt.format(r.page_views||0)+'</b></div>').join('') : '<p class="small">No data yet.</p>';
    }
    function table(el, rows){
      el.innerHTML = rows.length ? '<table><thead><tr><th>Run</th><th>Status</th><th>Rows</th></tr></thead><tbody>'+rows.map(r => '<tr><td>'+escapeHtml(r.run_type)+'</td><td class="status-'+escapeHtml(r.status)+'">'+escapeHtml(r.status)+'</td><td>'+fmt.format(r.rows_written||0)+'</td></tr>').join('')+'</tbody></table>' : '<p class="small">No runs yet.</p>';
    }
    async function load(){
      const overview = await get('/api/overview');
      document.getElementById('host').textContent = overview.host;
      const today = (overview.realtime || []).find(r => r.window_key === 'today') || {};
      text('todayVisits', today.visits); text('todayPageViews', today.page_views);
      text('allVisits', overview.all_time.visits); text('allPageViews', overview.all_time.page_views);
      bars(document.getElementById('daily'), (overview.daily || []).map(r => ({path:r.date, page_views:r.page_views})).slice(-20));
      await Promise.all([loadPaths(), loadCountries(), loadRuns()]);
    }
    async function loadPaths(){
      const period = document.getElementById('pathPeriod').value;
      const url = period === 'monthly' ? '/api/paths?period=monthly&limit=20' : '/api/paths?window=today&limit=20';
      const data = await get(url);
      bars(document.getElementById('paths'), data.rows || []);
    }
    async function loadCountries(){
      const data = await get('/api/monthly-dimensions?dimension=country');
      bars(document.getElementById('countries'), data.rows || [], 'value');
    }
    async function loadRuns(){ const data = await get('/api/runs'); table(document.getElementById('runs'), data.rows || []); }
    function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    load().catch(err => alert(err.message));
  </script>
</body>
</html>`;
