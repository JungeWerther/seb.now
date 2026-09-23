// Proxies inbox deliveries (Follow, Undo, Like, Announce, ...) to the
// activitypub Supabase Edge Function, forwarding the raw request body
// unchanged - real HTTP Signature verification needs byte-for-byte
// fidelity, which `web: raw` preserves (unlike `web: true`'s
// auto-parsed-into-params body).
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(args) {
  try {
    const http = args.http || {};
    let body = http.body || "";
    if (http.isBase64Encoded) {
      body = Buffer.from(body, "base64").toString("utf8");
    }

    const res = await fetch(`${ACTIVITYPUB_FUNCTION_URL}/ap/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const responseBody = await res.text();

    return {
      statusCode: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
      body: responseBody,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debug_error: String(e), debug_stack: e && e.stack }),
    };
  }
}

exports.main = main;
