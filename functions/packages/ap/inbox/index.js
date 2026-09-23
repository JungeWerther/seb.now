// Proxies inbox deliveries (Follow, Undo, Like, Announce, ...) to the
// activitypub Supabase Edge Function, forwarding the raw request body
// unchanged - real HTTP Signature verification needs byte-for-byte
// fidelity, which `web: raw` preserves (unlike `web: true`'s
// auto-parsed-into-params body).
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(args) {
  const http = args.http || {};
  const results = {};
  try {
    const url = `${ACTIVITYPUB_FUNCTION_URL}/ap/inbox`;
    results.step1_url = url;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: http.body || "",
    });
    results.step2_status = res.status;
    try {
      results.step3_contentType = res.headers.get("content-type");
    } catch (e) {
      results.step3_error = String(e);
    }
    try {
      results.step4_body = await res.text();
    } catch (e) {
      results.step4_error = String(e);
    }
  } catch (e) {
    results.step2_error = String(e);
    results.step2_stack = e && e.stack;
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results),
  };
}

exports.main = main;
