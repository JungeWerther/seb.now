// Proxies inbox deliveries (Follow, Undo, Like, Announce, ...) to the
// activitypub Supabase Edge Function, forwarding the raw request body
// unchanged - real HTTP Signature verification needs byte-for-byte
// fidelity, which `web: raw` preserves (unlike `web: true`'s
// auto-parsed-into-params body). The Date/Digest/Signature headers are
// forwarded too, unmodified - the Supabase function verifies against the
// exact bytes the sender signed, and (request-target)/host are
// reconstructed there against seb.now/ap/inbox (what senders actually
// signed), not this internal proxy path.
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(args) {
  const http = args.http || {};
  let body = http.body || "";
  if (http.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }

  const incomingHeaders = http.headers || {};
  const forwardHeaders = { "Content-Type": "application/json" };
  for (const name of ["date", "digest", "signature"]) {
    if (incomingHeaders[name]) forwardHeaders[name] = incomingHeaders[name];
  }

  const res = await fetch(`${ACTIVITYPUB_FUNCTION_URL}/ap/inbox`, {
    method: "POST",
    headers: forwardHeaders,
    body,
  });
  const responseBody = await res.text();

  return {
    statusCode: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
    body: responseBody,
  };
}

exports.main = main;
