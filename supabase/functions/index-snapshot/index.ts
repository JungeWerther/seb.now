import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeSnapshot, type RawSnapshot } from "../_shared/index_snapshot.ts";

// Builds the snapshot of the entity index the page keeps for itself (see
// 20261016210000_entity_index.sql) and uploads it, gzipped, to the public
// `index` bucket under a name of its own, so the CDN can keep it forever. Then
// records it in index_state, where index_diff points pages at it, and removes
// all but the newest KEEP_SNAPSHOTS (a page may still be fetching the one
// before). Does nothing when the index hasn't changed since the last snapshot.
//
// POST {} builds if needed; POST {"force": true} always builds.

const BUCKET = "index";
const PREFIX = "snapshots";
const KEEP_SNAPSHOTS = 3;
// Snapshot names never change content, so they can be cached for a year.
const CACHE_SECONDS = "31536000";

interface State {
  gen: number;
  snapshot_gen: number | null;
  snapshot_link_seq: number | null;
  snapshot_entity_seq: number | null;
  snapshot_pair_seq: number | null;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const force = req.method === "POST" && Boolean((await req.json().catch(() => ({}))).force);

  const { data: states, error: stateError } = await db.from("index_state").select("*");
  if (stateError) return json({ error: stateError.message }, 500);
  const state = states[0] as State;
  if (!force && state.snapshot_gen === state.gen) {
    const [links, entities, pairs] = await Promise.all(
      ["links", "entities", "link_entities"].map((table) =>
        db.from(table).select("seq").order("seq", { ascending: false }).limit(1)
      ),
    );
    const top = (r: typeof links) => (r.data?.[0]?.seq as number | undefined) ?? 0;
    if (
      !links.error && !entities.error && !pairs.error &&
      top(links) === state.snapshot_link_seq && top(entities) === state.snapshot_entity_seq &&
      top(pairs) === state.snapshot_pair_seq
    ) {
      return json({ skipped: true, gen: state.gen });
    }
  }

  const started = Date.now();
  const { data: raw, error } = await db.rpc("index_snapshot");
  if (error) return json({ error: error.message }, 500);
  const snapshot = encodeSnapshot(raw as RawSnapshot);
  const text = JSON.stringify(snapshot);
  const body = await gzip(text);
  const { gen, wm } = snapshot;
  const path = `${PREFIX}/${gen}-${wm.l}-${wm.e}-${wm.p}.json.gz`;

  const { error: uploadError } = await db.storage.from(BUCKET).upload(path, body, {
    contentType: "application/gzip",
    cacheControl: CACHE_SECONDS,
    upsert: true,
  });
  if (uploadError) return json({ error: uploadError.message }, 500);

  const { error: publishError } = await db.rpc("index_snapshot_published", {
    path,
    gen,
    link_seq: wm.l,
    entity_seq: wm.e,
    pair_seq: wm.p,
  });
  if (publishError) return json({ error: publishError.message }, 500);

  const { data: files } = await db.storage.from(BUCKET).list(PREFIX, {
    sortBy: { column: "created_at", order: "desc" },
    limit: 100,
  });
  const stale = (files ?? []).map((f) => `${PREFIX}/${f.name}`).filter((p) => p !== path).slice(KEEP_SNAPSHOTS - 1);
  if (stale.length) await db.storage.from(BUCKET).remove(stale);

  return json({
    path,
    gen,
    wm,
    entities: snapshot.entities.seq.length,
    links: snapshot.links.seq.length,
    json_bytes: text.length,
    gzip_bytes: body.length,
    removed: stale.length,
    ms: Date.now() - started,
  });
});
