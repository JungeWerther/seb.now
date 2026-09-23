// Proxies the ActivityPub actor document request to the activitypub
// Supabase Edge Function.
const ACTIVITYPUB_FUNCTION_URL = "https://yoxrhqlzsqwfjmsjpari.supabase.co/functions/v1/activitypub";

async function main(_args) {
  const res = await fetch(`${ACTIVITYPUB_FUNCTION_URL}/ap/actor`, { method: "GET" });
  const body = await res.text();

  return {
    statusCode: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/activity+json" },
    body,
  };
}

exports.main = main;
