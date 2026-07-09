// Cloudflare Pages Function — POST /api/submit
// Receives the submission form (multipart/form-data) from submit.html:
//   - stores any uploaded files in an R2 bucket (binding: SUBMISSIONS)
//   - emails the editors a summary via Resend, with token-gated download links
//     served from your own domain (/api/file), so editors in any country can
//     open them without needing a third-party service.
//
// Cloudflare Pages → Settings:
//   • R2 binding:  variable name SUBMISSIONS  → your R2 bucket (create one first)
//   • Env vars (encrypt the secrets):
//       RESEND_API_KEY   — from resend.com (verify a sending domain)
//       FROM_EMAIL       — e.g. "Visual Methods <submissions@yourdomain>"
//       EDITOR_EMAIL     — where submissions are sent, e.g. wangzezhong2016@gmail.com
//       FILE_TOKEN       — a long random string; guards the /api/file download links
//       SITE_ORIGIN      — e.g. https://visualmethods.<yourdomain>  (for the links)

const MAX_FILES = 6;
const MAX_SIZE = 8 * 1024 * 1024; // 8 MB

export async function onRequestPost({ request, env }) {
  let form;
  try { form = await request.formData(); } catch { return json({ error: "Invalid submission." }, 400); }

  // Honeypot
  if ((form.get("company") || "").toString().trim()) return json({ ok: true });

  // Cloudflare Turnstile — enforced only once TURNSTILE_SECRET is set.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!(await verifyTurnstile(env, (form.get("turnstile") || "").toString(), ip))) {
    return json({ error: "Verification failed. Please complete the check and try again." }, 400);
  }

  const type = (form.get("type") || "method").toString();
  const name = (form.get("name") || "").toString().trim();
  const email = (form.get("email") || "").toString().trim();

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Please provide your name and a valid email." }, 400);
  }
  if (!["method", "variation", "reference"].includes(type)) {
    return json({ error: "Unknown submission type." }, 400);
  }

  const missingConfig = [];
  if (!env.RESEND_API_KEY) missingConfig.push("RESEND_API_KEY");
  if (!env.FROM_EMAIL) missingConfig.push("FROM_EMAIL");
  if (!env.EDITOR_EMAIL) missingConfig.push("EDITOR_EMAIL");
  if (!env.FILE_TOKEN) missingConfig.push("FILE_TOKEN");
  if (missingConfig.length) {
    console.log("Submission form missing configuration:", missingConfig.join(", "));
    return json({ error: "The submission form is not configured yet. Please email the editors for now." }, 503);
  }

  const id = new Date().toISOString().slice(0, 10) + "-" + crypto.randomUUID().slice(0, 8);

  // ── Store uploaded files in R2 (method / variation only) ──
  const stored = [];
  if (type === "method" || type === "variation") {
    const files = form.getAll("files").filter((f) => typeof f === "object" && f.size !== undefined);
    if (files.length > MAX_FILES) return json({ error: `Too many files (max ${MAX_FILES}).` }, 400);
    if (files.some((f) => f.size) && !env.SUBMISSIONS) {
      console.log("Submission form missing configuration: SUBMISSIONS");
      return json({ error: "File upload is not configured yet. Please email the editors for now." }, 503);
    }
    for (const f of files) {
      if (!f.size) continue;
      if (f.size > MAX_SIZE) return json({ error: `"${f.name}" is larger than 8 MB.` }, 400);
      const okType = /^image\//.test(f.type) || f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      if (!okType) return json({ error: "Only images and PDFs are allowed." }, 400);
      const key = `submissions/${id}/${safeName(f.name)}`;
      await env.SUBMISSIONS.put(key, f.stream(), { httpMetadata: { contentType: f.type || "application/octet-stream" } });
      stored.push({ key, name: f.name, size: f.size });
    }
  }

  // ── Build the notification email ──
  const origin = (env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
  const link = (key) => `${origin}/api/file?key=${encodeURIComponent(key)}&token=${encodeURIComponent(env.FILE_TOKEN || "")}`;

  const rows = [];
  const add = (k, v) => { if (v) rows.push([k, v]); };
  add("Type", type);
  add("Name", name);
  add("Affiliation", form.get("affiliation"));
  add("Email", email);
  if (type === "method") {
    add("Method name", form.get("method_name"));
    add("Source", form.get("source"));
    add("Description / steps", form.get("description"));
  } else if (type === "variation") {
    add("Builds on method", form.get("base_method"));
    add("What is different", form.get("difference"));
    add("Context", form.get("context"));
    add("Related paper", form.get("rel_paper"));
  } else {
    add("Method used", form.get("ref_method"));
    add("Citation", form.get("citation"));
    add("DOI / link", form.get("doi"));
  }
  if (type === "method" || type === "variation") {
    add("Pasted links", form.get("links"));
    add("Agreed to terms", form.get("agree"));
    add("CC BY opt-in", form.get("ccby"));
  }

  const textLines = rows.map(([k, v]) => `${k}:\n${String(v).trim()}\n`);
  if (stored.length) {
    textLines.push("Files:");
    stored.forEach((s) => textLines.push(`  ${s.name} (${(s.size / 1024).toFixed(0)} KB) -> ${link(s.key)}`));
  }
  const text = `New Visual Methods submission (${type})\nID: ${id}\n\n` + textLines.join("\n");

  const htmlBody =
    `<h2 style="font-family:Georgia,serif">New submission &mdash; ${escapeHtml(type)}</h2>` +
    `<p style="color:#666;font-size:13px">ID ${escapeHtml(id)}</p>` +
    rows.map(([k, v]) => `<p style="margin:0 0 12px"><strong>${escapeHtml(k)}</strong><br>${escapeHtml(String(v)).replace(/\n/g, "<br>")}</p>`).join("") +
    (stored.length
      ? `<p style="margin:16px 0 4px"><strong>Files</strong></p><ul>` +
        stored.map((s) => `<li><a href="${link(s.key)}">${escapeHtml(s.name)}</a> (${(s.size / 1024).toFixed(0)} KB)</li>`).join("") +
        `</ul>`
      : "");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [env.EDITOR_EMAIL],
      reply_to: email,
      subject: `Visual Methods submission: ${type} — ${name}`,
      text,
      html: htmlBody,
    }),
  });
  if (!r.ok) {
    // Files are already saved in R2, so don't fail the user — but report to logs.
    console.log("Resend error", r.status, await r.text().catch(() => ""));
    return json({ error: "We saved your files but could not send the notification. Please email the editors so they can pick it up." }, 502);
  }

  return json({ ok: true, id });
}

export async function onRequest({ request }) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
}

// Returns true when Turnstile is not configured (so the form keeps working
// before you set it up), otherwise verifies the token with Cloudflare.
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const d = await r.json().catch(() => ({ success: false }));
  return !!d.success;
}

function safeName(n) {
  return String(n).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
