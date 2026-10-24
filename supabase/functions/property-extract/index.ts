import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
import { isPresent, type Report, reporting, sumBy } from "../_shared/helpers.ts";
import { linksToEnrich, markEnriched } from "../_shared/enrich.ts";
import { serveJev } from "../_shared/jev_function.ts";
import { pool } from "../_shared/pool.ts";
import { JEV, PROPERTY_EXTRACT } from "../_shared/constants.ts";
import { descriptors } from "./descriptors.ts";

// Proposes properties of the entities a link mentions, from the words its title
// describes them with ("British AI neocloud Nscale"). compromise finds those
// words for free (descriptors.ts), so a link without any costs no Jev call.
// Then one Jev request asks, per word, which facet it gives (domain, origin,
// stage, type, evaluation or other); neighbouring words with the same facet
// merge ("AI" + "voice" → domain "AI voice"). A second request maps each domain
// phrase onto a topic, so it is queryable by topic path: one of the link's own
// leaf labels, or a top-level topic when none of those fits ("AI" on a link
// labelled only business.startups_funding), without walking the tree again.
// Properties land in `entity_properties` (labeled_by 'jev'), and every
// processed link gets `link_enrichment.properties_at`, described or not.
//
// POST {} processes up to LINKS_PER_RUN unprocessed links, newest first;
// POST {"link_ids": [...]} those links. "dry_run": true reports without writing.

const OTHER = "other";
const NONE = "none";

const FACET_OPTIONS = {
  domain: "A field, technology or subject it works in (AI, voice, robotics, hearing tech).",
  origin: "Where it is from or based (British, Finnish, Berlin-based).",
  stage: "How young, big or established it is (startup, 2-month-old, unicorn, giant).",
  type: "What kind of thing or role it is (neocloud, chipmaker, developer, coach, app, painter).",
  evaluation: "A judgement or framing of it (viral, rogue, controversial, beloved).",
  [OTHER]: "None of these: not a description of it, or part of another phrase.",
};

type Facet = keyof typeof FACET_OPTIONS;

const LINK_COLUMNS = "id, title, url, link_entities(surface, entity_id, entities(name)), link_topics(topic_id, topics(name))";

interface Link {
  id: string;
  title: string;
  url: string;
  link_entities: { surface: string | null; entity_id: string; entities: { name: string } }[];
  link_topics: { topic_id: string; topics: { name: string } }[];
}

interface Property {
  entityId: string;
  entity: string;
  facet: Facet;
  value: string;
  p: number;
  former: boolean;
  topic?: string;
}

const minFacetP = (facet: Facet) => facet === "evaluation" ? PROPERTY_EXTRACT.MIN_EVALUATION_P : PROPERTY_EXTRACT.MIN_FACET_P;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function linksById(db: SupabaseClient, ids: string[]): Promise<Link[]> {
  const { data, error } = await db.from("links").select(LINK_COLUMNS).in("id", ids);
  if (error) throw new Error(error.message);
  return data as unknown as Link[];
}

async function topLevelTopics(db: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await db.rpc("topic_children", {});
  if (error) throw new Error(error.message);
  return Object.fromEntries((data as { id: string; name: string }[]).map((t) => [t.id, `${t.name} (in general)`]));
}

async function propertiesOf(jev: JevClient, link: Link, topLevel: Record<string, string>) {
  const surfaces = link.link_entities.map((m) => m.surface ?? m.entities.name);
  const entityIdOf = new Map(link.link_entities.map((m, i) => [surfaces[i], m.entity_id]));
  const found = descriptors(link.title, surfaces);
  if (!found.length) return { link_id: link.id, title: link.title, site: hostOf(link.url), descriptors: found, properties: [], inputTokens: 0 };

  const state = { link: { title: link.title, site: hostOf(link.url) } };
  const words = found.flatMap((d, di) => d.words.map((word) => ({ d, di, word })));
  const facetResult = await jev.ask(state, Object.fromEntries(words.map(({ d, word }, i) => [
    `f${i}`,
    {
      type: "choice",
      instructions: {
        entity: d.surface,
        phrase: d.words.join(" "),
        word,
        question: "In `link`, what does `word` (in `phrase`, describing `entity`) say about `entity`?",
      },
      criteria: FACET_OPTIONS,
    } satisfies ChoiceQuestion,
  ])), link.id);
  let inputTokens = facetResult.usage.input_tokens;

  // Neighbouring words of one descriptor with the same facet merge into one property.
  const properties: Property[] = [];
  let lastKept = -1;
  words.forEach(({ d, di, word }, i) => {
    const answer = facetResult.answers[`f${i}`];
    const facet = answer.choice as Facet;
    const p = answer.probabilities[answer.choice];
    if (facet === OTHER || p < minFacetP(facet)) return;
    const prev = properties[properties.length - 1];
    if (prev && lastKept === i - 1 && words[lastKept].di === di && prev.facet === facet) {
      prev.value = `${prev.value} ${word}`;
      prev.p = Math.min(prev.p, p);
    } else {
      properties.push({ entityId: entityIdOf.get(d.surface)!, entity: d.surface, facet, value: word, p, former: d.former });
    }
    lastKept = i;
  });

  const domains = properties.filter((pr) => pr.facet === "domain");
  if (domains.length) {
    const topicOptions = {
      ...topLevel,
      ...Object.fromEntries(link.link_topics.map((t) => [t.topic_id, t.topics.name])),
      [NONE]: "None of these topics.",
    };
    const topicResult = await jev.ask(state, Object.fromEntries(domains.map((pr, i) => [
      `t${i}`,
      {
        type: "choice",
        instructions: { entity: pr.entity, phrase: pr.value, question: "Which topic is `phrase` (describing `entity`) about? The most specific that fits." },
        criteria: topicOptions,
      } satisfies ChoiceQuestion,
    ])), link.id);
    inputTokens += topicResult.usage.input_tokens;
    domains.forEach((pr, i) => {
      const answer = topicResult.answers[`t${i}`];
      if (answer.choice !== NONE && answer.probabilities[answer.choice] >= PROPERTY_EXTRACT.MIN_TOPIC_P) pr.topic = answer.choice;
    });
  }

  return {
    link_id: link.id,
    title: link.title,
    site: hostOf(link.url),
    descriptors: found,
    properties: properties.map((pr) => ({ ...pr, value: pr.value.toLowerCase(), p: Math.round(pr.p * 1000) / 1000 })),
    inputTokens,
  };
}

// Writes the properties and marks every read link done, described or not; the properties written.
async function saveProperties(db: SupabaseClient, results: Awaited<ReturnType<typeof propertiesOf>>[], report: Report): Promise<number> {
  const rows = results.flatMap((r) =>
    r.properties.map((pr) => ({
      entity_id: pr.entityId, link_id: r.link_id, facet: pr.facet, value: pr.value,
      topic_id: pr.topic ?? null, former: pr.former, p: pr.p, labeled_by: "jev",
    }))
  );
  const { error } = rows.length
    ? await db.from("entity_properties").upsert(rows, { onConflict: "link_id,entity_id,facet,value", ignoreDuplicates: true })
    : { error: null };
  if (error) report({ write: error.message });
  const { error: markError } = await markEnriched(db, "properties", error ? [] : results.map((r) => r.link_id));
  if (markError) report({ enrichment: markError.message });
  return error ? 0 : rows.length;
}

Deno.serve(serveJev({ fn: "property-extract", model: JEV.MODEL, maxLinkIds: PROPERTY_EXTRACT.MAX_LINK_IDS }, async ({ db, jev, ids, dryRun, report }) => {
  const [links, topLevel] = await Promise.all([
    ids ? linksById(db, ids) : linksToEnrich<Link>(db, "properties", PROPERTY_EXTRACT.LINKS_PER_RUN, LINK_COLUMNS),
    topLevelTopics(db),
  ]);
  const read = reporting(report, (link: Link) => ({ link_id: link.id }), (link) => propertiesOf(jev, link, topLevel));
  const results = (await pool(links, PROPERTY_EXTRACT.CONCURRENCY, read)).filter(isPresent);

  const written = dryRun ? 0 : await saveProperties(db, results, report);
  const described = results.filter((r) => r.descriptors.length);
  const properties = described.flatMap((r) => r.properties);
  return {
    links_scanned: links.length,
    links_with_descriptors: described.length,
    properties: properties.length,
    properties_written: written,
    by_facet: Object.fromEntries(Object.entries(Object.groupBy(properties, (p) => p.facet)).map(([f, ps]) => [f, ps!.length])),
    input_tokens: sumBy(results, "inputTokens"),
    results: described.map((r) => ({ ...r, properties: r.properties.map(({ entityId: _, ...pr }) => pr) })),
  };
}));
