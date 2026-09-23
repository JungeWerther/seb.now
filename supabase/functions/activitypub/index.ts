import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Stub backend for the DO Functions proxy at seb.now/.well-known/webfinger,
// seb.now/ap/actor, seb.now/ap/inbox. Real ActivityPub logic (Fedify:
// actor identity, WebFinger resolution, HTTP Signature verification,
// followers table, outbound delivery) isn't built yet - this only proves
// the proxy chain (DO Functions -> here) actually routes end to end.
const KNOWN_PATHS = new Set(["/.well-known/webfinger", "/ap/actor", "/ap/inbox"]);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve((req: Request) => {
  const path = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?activitypub/, "") || "/";

  if (!KNOWN_PATHS.has(path)) {
    return json({ error: "not_found", path }, 404);
  }

  return json({ error: "not_implemented", path, message: "ActivityPub actor is not live yet" }, 501);
});
