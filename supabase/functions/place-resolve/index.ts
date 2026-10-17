import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
import { isPresent, json, reporting } from "../_shared/helpers.ts";
import { serveJev } from "../_shared/jev_function.ts";
import { pool } from "../_shared/pool.ts";
import { Wikidata, wikidata, WikidataItem } from "../_shared/wikidata.ts";
import { ENTITY_EXTRACT, JEV, PLACE_RESOLVE, WIKIDATA } from "../_shared/constants.ts";

// Links place entities to Wikidata, so where a place is comes from what it is,
// never from its name ("Palais de Tokyo" is in Paris). Code proposes, Jev
// only chooses. Per run, for up to PLACES_PER_RUN places never looked up
// (`places_to_resolve`, most mentioned first):
//  1. a place that already has a `wikidata_id` is read as is; any other is
//     searched on Wikidata by name (English and French), keeping items that are
//     located somewhere (_shared/wikidata.ts);
//  2. one Jev request asks, per place, which item the posts mentioning it mean
//     (each item described with the area and country it is in), or none;
//  3. a pick with p ≥ MATCH_MIN_P sets `wikidata_id` and, when empty, `country`
//     (ISO 3166-1). If another entity already has that item, the two are one
//     place: a `merge` is staged in `entity_edits` for review, not applied.
//  4. the item's area (P131, else its country) becomes the place's parent in
//     `entity_locations`: the entity with that item, else the place of that
//     name not yet linked (which takes the item), else a new place entity.
//     Parents are places like any other, so later runs place them in turn,
//     until a country, which has none.
// Every place looked at gets `entity_enrichment.wikidata_at`, picked or not.
//
// POST {} runs on the next places; POST {"entity_ids": [...]} on those.
// "dry_run": true reports the picks without writing.

const NONE = "none";

interface Place {
  id: string;
  name: string;
  wikidata_id: string | null;
  country: string | null;
}

interface Proposal {
  place: Place;
  mentions: string[];
  // Candidate items with their descriptions, or the one item already linked.
  items: { item: WikidataItem; text: string }[];
  linked: boolean;
}

interface Pick {
  place: Place;
  item: WikidataItem | null;
  p: number | null;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { "User-Agent": WIKIDATA.USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(WIKIDATA.FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  return await res.json();
}

async function placesById(db: SupabaseClient, ids: string[]): Promise<Place[]> {
  // Only places: an explicit id of a person or a work is skipped, never placed.
  const { data, error } = await db.from("entities").select("id, name, wikidata_id, country").in("id", ids).eq("kind", "place");
  if (error) throw new Error(error.message);
  return data as Place[];
}

async function nextPlaces(db: SupabaseClient): Promise<Place[]> {
  const { data, error } = await db.rpc("places_to_resolve", { max_results: PLACE_RESOLVE.PLACES_PER_RUN });
  if (error) throw new Error(error.message);
  const ids = (data as { id: string }[]).map((r) => r.id);
  return ids.length ? placesById(db, ids) : [];
}

// The titles of the posts that mention a place most surely, for context.
async function mentionsOf(db: SupabaseClient, placeId: string): Promise<string[]> {
  const { data, error } = await db.from("link_entities").select("surface, links(title)")
    .eq("entity_id", placeId).order("p", { ascending: false }).limit(PLACE_RESOLVE.CONTEXT_MENTIONS);
  if (error) throw new Error(error.message);
  return (data as unknown as { surface: string | null; links: { title: string } | null }[])
    .flatMap((m) => m.links ? [m.surface ? `"${m.surface}" in: ${m.links.title}` : m.links.title] : []);
}

async function propose(db: SupabaseClient, wd: Wikidata, place: Place): Promise<Proposal> {
  const linkedItem = place.wikidata_id ? await wd.item(place.wikidata_id) : null;
  const found = linkedItem ? [linkedItem] : await wd.search(place.name);
  const items = await Promise.all(found.map(async (item) => ({ item, text: await wd.describe(item) })));
  return { place, mentions: await mentionsOf(db, place.id), items, linked: linkedItem !== null };
}

function question(proposal: Proposal): ChoiceQuestion {
  return {
    type: "choice",
    instructions: {
      place: proposal.place.name,
      mentioned_in: proposal.mentions,
      question: "Which of these Wikidata items is the place `place` that these posts mention? If none of them is, say so.",
    },
    criteria: {
      ...Object.fromEntries(proposal.items.map(({ item, text }) => [item.id, text])),
      [NONE]: "None of these: another place of that name, or not a real place.",
    },
  };
}

// One Jev request for every place with candidates; a linked place is taken as is.
async function choose(jev: JevClient, proposals: Proposal[]): Promise<Pick[]> {
  const asked = proposals.filter((p) => !p.linked && p.items.length);
  const answers = asked.length
    ? (await jev.ask({}, Object.fromEntries(asked.map((p, i) => [`p${i}`, question(p)])))).answers
    : {};
  return proposals.map((proposal) => {
    if (proposal.linked) return { place: proposal.place, item: proposal.items[0].item, p: 1 };
    const i = asked.indexOf(proposal);
    if (i < 0) return { place: proposal.place, item: null, p: null };
    const answer = answers[`p${i}`];
    const p = answer.probabilities[answer.choice] ?? 0;
    const item = answer.choice !== NONE && p >= PLACE_RESOLVE.MATCH_MIN_P
      ? proposal.items.find(({ item }) => item.id === answer.choice)?.item ?? null
      : null;
    return { place: proposal.place, item, p: item ? p : null };
  });
}

async function entityWithItem(db: SupabaseClient, qid: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db.from("entities").select("id, name").eq("wikidata_id", qid).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// The place entity for an item: the one that has it, else the unlinked place of
// that name (which takes it), else a new one.
async function placeFor(db: SupabaseClient, wd: Wikidata, qid: string): Promise<string | null> {
  const linked = await entityWithItem(db, qid);
  if (linked) return linked.id;
  const item = await wd.item(qid);
  if (!item?.label) return null;
  const { data: named, error } = await db.from("entities").select("id, wikidata_id")
    .eq("kind", "place").ilike("name", item.label.replace(/[%_\\]/g, "\\$&"));
  if (error) throw new Error(error.message);
  const same = (named as { id: string; wikidata_id: string | null }[])[0];
  if (same && !same.wikidata_id) {
    const { error: claimError } = await db.from("entities").update({ wikidata_id: qid }).eq("id", same.id);
    if (claimError) throw new Error(claimError.message);
    // A no-match lookup recorded before it had an item is void: look it up again.
    const { error: resetError } = await db.from("entity_enrichment").delete().eq("entity_id", same.id);
    if (resetError) throw new Error(resetError.message);
    return same.id;
  }
  // Another place already has the name (names are unique per kind): this one is
  // named with what tells it apart.
  const name = same ? `${item.label} (${item.description ?? qid})` : item.label;
  const { data: created, error: insertError } = await db.from("entities")
    .insert({ name, kind: "place", wikidata_id: qid, country: await wd.isoOf(item) })
    .select("id").single();
  if (insertError) throw new Error(insertError.message);
  return created.id;
}

async function save(db: SupabaseClient, wd: Wikidata, { place: queued, item, p }: Pick) {
  // Re-read: an earlier save in this run may have linked this place as a parent.
  const [place] = await placesById(db, [queued.id]);
  if (!place) return { place: queued.name, skipped: "gone" };
  const outcome: Record<string, unknown> = { place: place.name, item: item?.id ?? null, p };
  if (item) {
    const holder = item.id !== place.wikidata_id ? await entityWithItem(db, item.id) : null;
    if (holder) {
      const batch = `${PLACE_RESOLVE.MERGE_BATCH_PREFIX}-${new Date().toISOString().slice(0, 10)}`;
      const { error } = await db.from("entity_edits").insert({
        batch, op: "merge", entity_id: place.id, entity_name: place.name, into_id: holder.id, into_name: holder.name,
        reason: `same Wikidata item ${item.id}`, decided_by: "jev", p,
      });
      if (error) throw new Error(error.message);
      outcome.staged_merge_into = holder.name;
    } else {
      const iso = place.country ? null : await wd.isoOf(item);
      const { error } = await db.from("entities").update({ wikidata_id: item.id, ...(iso ? { country: iso } : {}) }).eq("id", place.id);
      if (error) throw new Error(error.message);
      const parentId = item.parent ? await placeFor(db, wd, item.parent) : null;
      if (parentId && parentId !== place.id) {
        const { error: locationError } = await db.from("entity_locations")
          .upsert({ entity_id: place.id, parent_id: parentId, labeled_by: "wikidata", p: p ?? 1 });
        // A cycle in Wikidata's own claims is refused by the table and leaves the
        // place unplaced; any other failure is an error, and the place is retried.
        if (locationError && !/would make a cycle/.test(locationError.message)) throw new Error(locationError.message);
        outcome.parent = locationError ? `refused: ${locationError.message}` : (await wd.item(item.parent!))?.label;
      }
    }
  }
  const { error } = await db.from("entity_enrichment")
    .upsert({ entity_id: place.id, wikidata_at: new Date().toISOString(), wikidata_p: item ? p : null });
  if (error) throw new Error(error.message);
  return outcome;
}

function entityIds(body: Record<string, unknown>): string[] | null | undefined {
  const ids = body.entity_ids;
  if (ids === undefined) return null;
  return Array.isArray(ids) && ids.length <= PLACE_RESOLVE.MAX_ENTITY_IDS && ids.every((id) => typeof id === "string")
    ? ids
    : undefined;
}

Deno.serve(serveJev({
  fn: "place-resolve",
  model: JEV.MODEL,
  maxLinkIds: ENTITY_EXTRACT.MAX_LINK_IDS,
}, async ({ db, jev, dryRun, body, report }) => {
  const ids = entityIds(body);
  if (ids === undefined) return json({ error: `entity_ids must be at most ${PLACE_RESOLVE.MAX_ENTITY_IDS} ids` }, 400);
  const places = ids ? await placesById(db, ids) : await nextPlaces(db);
  const wd = wikidata(fetchJson);
  const proposals = (await pool(places, PLACE_RESOLVE.FETCH_CONCURRENCY,
    reporting(report, (place: Place) => ({ entity_id: place.id, step: "propose" }), (place) => propose(db, wd, place))))
    .filter(isPresent);
  const picks = await choose(jev, proposals);
  const results = dryRun
    ? picks.map(({ place, item, p }) => ({ place: place.name, item: item?.id ?? null, label: item?.label ?? null, p }))
    : (await pool(picks, 1, reporting(report, (pick: Pick) => ({ entity_id: pick.place.id, step: "save" }), (pick) => save(db, wd, pick))))
      .filter(isPresent);
  return {
    places: places.length,
    picked: picks.filter((p) => p.item).length,
    results,
  };
}));
