// Cloudflare Pages Function — GET /api/file?key=...&token=...
// Streams a stored submission file from R2, guarded by FILE_TOKEN, so the
// editors can download attachments from your own domain (works from any
// country) without making the R2 bucket public.
//
// Requires: R2 binding SUBMISSIONS, env var FILE_TOKEN (same value used in submit.js).

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const token = url.searchParams.get("token") || "";

  if (!env.FILE_TOKEN || token !== env.FILE_TOKEN) {
    return new Response("Not authorized.", { status: 403 });
  }
  if (!key.startsWith("submissions/")) {
    return new Response("Not found.", { status: 404 });
  }
  if (!env.SUBMISSIONS) {
    return new Response("Storage not configured.", { status: 500 });
  }

  const obj = await env.SUBMISSIONS.get(key);
  if (!obj) return new Response("Not found.", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  const filename = key.split("/").pop();
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  headers.set("Cache-Control", "private, no-store");

  return new Response(obj.body, { headers });
}

export async function onRequest({ request }) {
  if (request.method !== "GET") return new Response("Method not allowed.", { status: 405 });
}
