// Cloudflare Pages Function — POST /api/subscribe
// Deploys automatically with the site (Cloudflare Pages). Same origin as the
// page, so no CORS needed. The website form posts {name, email} here; this
// forwards to Buttondown (default) or MailerLite, which owns the list, sends the
// double opt-in confirmation, and manages one-click unsubscribe.
//
// Set the API key as an ENCRYPTED environment variable in the Cloudflare dashboard:
//   Pages project → Settings → Environment variables → add BUTTONDOWN_API_KEY
// (Never commit the key to the repo.)

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const email = String(body.email || "").trim().toLowerCase();
  const name  = String(body.name  || "").trim();

  // Honeypot: real users leave `company` empty. Pretend success, send nothing.
  if (body.company) return json({ ok: true });

  // Server-side email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  // Cloudflare Turnstile — enforced only once TURNSTILE_SECRET is set.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!(await verifyTurnstile(env, String(body.turnstile || ""), ip))) {
    return json({ error: "Verification failed. Please complete the check and try again." }, 400);
  }

  if (!env.BUTTONDOWN_API_KEY) {
    console.log("Newsletter signup missing configuration: BUTTONDOWN_API_KEY");
    return json({ error: "Newsletter signup is not configured yet." }, 503);
  }

  // ── Buttondown ──────────────────────────────────────────────────────────
  // Double opt-in is ON BY DEFAULT and cannot be disabled globally. Do NOT send
  // `type: "regular"` here: per Buttondown's docs that opts this subscriber OUT
  // of double opt-in. Omitting it means they get the confirmation email and stay
  // `unactivated` until they click it.
  // We pass ip_address so Buttondown's spam firewall judges the real visitor.
  // Without it, all our calls come from a few Cloudflare IPs and can be flagged.
  const res = await fetch("https://api.buttondown.email/v1/subscribers", {
    method: "POST",
    headers: {
      "Authorization": `Token ${env.BUTTONDOWN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: email,
      metadata: name ? { name } : undefined,
      tags: ["website"],
      ip_address: ip || undefined,
    }),
  });

  // ── MailerLite (alternative) — comment out Buttondown above, use this instead.
  // Set env vars MAILERLITE_TOKEN and MAILERLITE_GROUP_ID; enable double opt-in.
  // const res = await fetch("https://connect.mailerlite.com/api/subscribers", {
  //   method: "POST",
  //   headers: {
  //     "Authorization": `Bearer ${env.MAILERLITE_TOKEN}`,
  //     "Content-Type": "application/json",
  //     "Accept": "application/json",
  //   },
  //   body: JSON.stringify({ email, fields: { name }, groups: [env.MAILERLITE_GROUP_ID] }),
  // });

  if (res.ok) return json({ ok: true });
  // 400/409 usually means "already subscribed" — treat as success so we never
  // reveal whether an address is on the list.
  if (res.status === 400 || res.status === 409) return json({ ok: true });
  return json({ error: "Could not subscribe right now. Please try again later." }, 502);
}

// Reject non-POST methods cleanly.
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
