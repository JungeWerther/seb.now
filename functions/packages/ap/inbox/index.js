// Proxies inbox deliveries (Follow, Undo, Like, Announce, ...) to the
// activitypub Supabase Edge Function. Stub-phase only: a `web: true`
// action auto-parses the JSON body into args rather than exposing it
// raw, which loses exact byte-for-byte fidelity real HTTP Signature
// verification needs later - fine for now since nothing verifies
// signatures yet, but revisit as `web: raw` (raw body/header access)
// once real inbox processing replaces the stub on the Supabase side.
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(args) {
  const payload = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("__ow_")) continue;
    payload[key] = value;
  }

  const res = await fetch(`${ACTIVITYPUB_FUNCTION_URL}/ap/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();

  return {
    statusCode: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
    body,
  };
}

exports.main = main;
