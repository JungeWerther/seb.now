import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { serviceClient } from "../_shared/clients.ts";
import { encodeSnapshot, type RawSnapshot } from "../_shared/index_snapshot.ts";
import { INDEX_SNAPSHOT } from "../_shared/constants.ts";
import { jsonResponses } from "../_shared/helpers.ts";

// Builds the snapshot of the entity index the page keeps for itself (see
// 20261016210000_entity_index.sql) and uploads it, gzipped, to the public
// `index` bucket under a name of its own, so the CDN can keep it forever. Then
// records it in index_state, where index_diff points pages at it, and removes
// all but the newest KEEP_SNAPSHOTS (a page may still be fetching the one
// before). Builds when gen moved on since the latest snapshot; otherwise only
// when something was added and the snapshot is older than MAX_AGE_MS or over
// MAX_NEW_PAIRS mentions behind, since pages catch up with index_diff.
//
// POST {} builds if needed; POST {"force": true} always builds.

interface State {
  gen: number;
  snapshot_gen: number | null;
  snapshot_link_seq: number | null;
  snapshot_entity_seq: number | null;
  snapshot_pair_seq: number | null;
  snapshot_at: string | null;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const json = jsonResponses();

Deno.serve(async (req: Request) => {
  const db = serviceClient();
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
    if (!links.error && !entities.error && !pairs.error) {
      const added = top(links) !== state.snapshot_link_seq || top(entities) !== state.snapshot_entity_seq ||
        top(pairs) !== state.snapshot_pair_seq;
      const age = state.snapshot_at ? Date.now() - Date.parse(state.snapshot_at) : Infinity;
      const newPairs = top(pairs) - (state.snapshot_pair_seq ?? 0);
      if (!added || (age < INDEX_SNAPSHOT.MAX_AGE_MS && newPairs < INDEX_SNAPSHOT.MAX_NEW_PAIRS)) {
        return json({ skipped: true, gen: state.gen, added, age_ms: age, new_pairs: newPairs });
      }
    }
  }

  const started = Date.now();
  const { data: raw, error } = await db.rpc("index_snapshot");
  if (error) return json({ error: error.message }, 500);
  const snapshot = encodeSnapshot(raw as RawSnapshot);
  const text = JSON.stringify(snapshot);
  const body = await gzip(text);
  const { gen, wm } = snapshot;
  const path = `${INDEX_SNAPSHOT.PREFIX}/${gen}-${wm.l}-${wm.e}-${wm.p}.json.gz`;

  const { error: uploadError } = await db.storage.from(INDEX_SNAPSHOT.BUCKET).upload(path, body, {
    contentType: "application/gzip",
    cacheControl: INDEX_SNAPSHOT.CACHE_SECONDS,
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

  const { data: files } = await db.storage.from(INDEX_SNAPSHOT.BUCKET).list(INDEX_SNAPSHOT.PREFIX, {
    sortBy: { column: "created_at", order: "desc" },
    limit: 100,
  });
  const stale = (files ?? []).map((f) => `${INDEX_SNAPSHOT.PREFIX}/${f.name}`).filter((p) => p !== path).slice(INDEX_SNAPSHOT.KEEP_SNAPSHOTS - 1);
  if (stale.length) await db.storage.from(INDEX_SNAPSHOT.BUCKET).remove(stale);

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
