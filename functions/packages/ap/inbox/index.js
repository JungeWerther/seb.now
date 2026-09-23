// Proxies inbox deliveries (Follow, Undo, Like, Announce, ...) to the
// activitypub Supabase Edge Function, forwarding the raw request body
// unchanged - real HTTP Signature verification needs byte-for-byte
// fidelity, which `web: raw` preserves (unlike `web: true`'s
// auto-parsed-into-params body).
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(args) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ probe: "reached main", argsKeys: Object.keys(args || {}) }),
  };
}

exports.main = main;
