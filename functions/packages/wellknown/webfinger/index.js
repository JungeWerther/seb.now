// Proxies WebFinger lookups (?resource=acct:seb@seb.now) to the
// activitypub Supabase Edge Function. Must live at this exact path on
// seb.now itself - WebFinger resolution for an acct: handle is defined
// as a request to https://<host>/.well-known/webfinger on that same host,
// so this can't be relocated to a subdomain or the Supabase URL directly.
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(args) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("__ow_")) continue;
    query.set(key, value);
  }
  const qs = query.toString();
  const target = `${ACTIVITYPUB_FUNCTION_URL}/.well-known/webfinger${qs ? `?${qs}` : ""}`;

  const res = await fetch(target, { method: "GET" });
  const body = await res.text();

  return {
    statusCode: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
    body,
  };
}

exports.main = main;
