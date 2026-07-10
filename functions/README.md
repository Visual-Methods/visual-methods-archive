# Cloudflare Pages Functions

These run automatically with the site on Cloudflare Pages (same domain, no CORS,
no separate deploy). Configure them in **Pages project → Settings**.

## `/api/subscribe` — newsletter (Buttondown/MailerLite)

Env var (encrypted):
- `BUTTONDOWN_API_KEY` — Buttondown → Settings → API.

The form lets visitors choose one or both update topics. The function stores
those preferences as Buttondown tags:
- `new-methods`
- `publications-events`

All website subscribers also keep the `website` tag.
The Buttondown request uses collision behavior `add`, so an existing subscriber
can submit the form again to add newly selected topic tags without overwriting
other subscriber data.

**Double opt-in:** there is no toggle to turn on. Buttondown applies double opt-in
by default and it cannot be disabled globally; new subscribers get a confirmation
email and stay `unactivated` until they click it. The only way to bypass it is to
send `type: "regular"` when creating a subscriber, which this function deliberately
does **not** do.

**Spam firewall:** the function forwards the visitor's `ip_address`. Buttondown's
docs warn that without it, API calls from a small set of IPs (Cloudflare's) can be
flagged as suspicious and the subscribers blocked. Keep that field.

## `/api/submit` and `/api/file` — method submissions

The submit form uploads files through your own domain to an R2 bucket, and emails
you a summary with token-gated download links (works from any country, incl. China,
as long as the site is reachable).

1. **Create an R2 bucket** (R2 → Create bucket), e.g. `vm-submissions`.
2. **Bind it to Pages:** Settings → Functions → R2 bucket bindings →
   variable name **`SUBMISSIONS`** → your bucket.
3. **Email via Resend:** create a resend.com account, verify a sending domain,
   get an API key.
4. **Env vars** (mark the secrets as encrypted):
   - `RESEND_API_KEY` — from Resend
   - `FROM_EMAIL` — a verified sender, e.g. `Visual Methods <submissions@yourdomain>`
   - `EDITOR_EMAIL` — where submissions arrive, e.g. `wangzezhong2016@gmail.com`
   - `FILE_TOKEN` — a long random string (guards the `/api/file` download links)
   - `SITE_ORIGIN` — your live origin, e.g. `https://visualmethods.<yourdomain>`
5. **Deploy:** for this Pages project, push to GitHub first, then deploy manually
   with Wrangler, e.g. `wrangler pages deploy <deploy-folder> --project-name visualmethods --branch main`.

The function refuses real submissions until Resend, `FILE_TOKEN`, and any required
R2 upload binding are configured, so visitors do not see a false "success" state
while setup is incomplete.

## Cloudflare Turnstile (bot protection, both forms)

Turnstile is wired into `subscribe.html` and `submit.html` and verified server-side.
It is **off until you configure it**, so nothing breaks before setup.

1. Cloudflare dashboard → **Turnstile** → Add site → your domain. You get a
   **Site key** (public) and a **Secret key**.
2. Paste the Site key into the `TURNSTILE_SITEKEY` const near the top of the
   `<script>` in **both** `subscribe.html` and `submit.html`.
3. Add Pages env var (encrypted): `TURNSTILE_SECRET` = your Secret key.
4. Push. The widget now renders and the server rejects submissions without a
   valid token.

Rollout is safe in both directions: with no Site key the widget never loads (no
third-party request at all); with no `TURNSTILE_SECRET` the server skips
verification. Turn both on together.

> China note: the widget loads from `challenges.cloudflare.com`. If you find it
> slow or unreachable for your audience, clear `TURNSTILE_SITEKEY` and
> `TURNSTILE_SECRET` to fall back to the honeypot, which stays active either way.

### Notes
- No subscriber or submission data is ever stored in this repo. Files live in R2;
  the editor notification email links back to `/api/file` (token-protected).
- Limits enforced: 6 files, 8 MB each, images or PDF. Larger files: submitters
  paste a link instead.
- The old top-level `worker/` folder (standalone Worker) is **not needed** on
  Cloudflare Pages — these Pages Functions replace it.
