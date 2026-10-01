import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
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
//
// Evaluation only for now: POST {"link_ids": [...]} returns the properties
// without writing anything; links whose titles describe no entity are skipped.

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const MAX_LINK_IDS = 300;
const MIN_FACET_P = 0.5;
const MIN_EVALUATION_P = 0.75;
const MIN_TOPIC_P = 0.5;
const CONCURRENCY = 6;
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

interface Link {
  id: string;
  title: string;
  url: string;
}

interface Property {
  entity: string;
  facet: Facet;
  value: string;
  p: number;
  former: boolean;
  topic?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function loadLinks(db: SupabaseClient, ids: string[]) {
  const { data, error } = await db
    .from("links")
    .select("id, title, url, link_entities(surface, entities(name)), link_topics(topic_id, topics(name))")
    .in("id", ids);
  if (error) throw new Error(error.message);
  return data as unknown as (Link & {
    link_entities: { surface: string | null; entities: { name: string } }[];
    link_topics: { topic_id: string; topics: { name: string } }[];
  })[];
}

async function topLevelTopics(db: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await db.rpc("topic_children", {});
  if (error) throw new Error(error.message);
  return Object.fromEntries((data as { id: string; name: string }[]).map((t) => [t.id, `${t.name} (in general)`]));
}

async function processLink(jev: JevClient, link: Awaited<ReturnType<typeof loadLinks>>[number], topLevel: Record<string, string>) {
  const surfaces = link.link_entities.map((m) => m.surface ?? m.entities.name);
  const found = descriptors(link.title, surfaces);
  if (!found.length) return null;

  const state = { link: { title: link.title, site: hostOf(link.url) } };
  const words = found.flatMap((d, di) => d.words.map((word, wi) => ({ d, di, wi, word })));
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
  ])));
  let inputTokens = facetResult.usage.input_tokens;

  const properties: Property[] = [];
  let lastKept = -1;
  words.forEach(({ d, di, word }, i) => {
    const answer = facetResult.answers[`f${i}`];
    const facet = answer.choice as Facet;
    const p = answer.probabilities[answer.choice];
    if (facet === OTHER || p < (facet === "evaluation" ? MIN_EVALUATION_P : MIN_FACET_P)) return;
    const prev = properties[properties.length - 1];
    if (prev && lastKept === i - 1 && words[lastKept].di === di && prev.facet === facet) {
      prev.value = `${prev.value} ${word}`;
      prev.p = Math.min(prev.p, p);
    } else {
      properties.push({ entity: d.surface, facet, value: word, p, former: d.former });
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
    ])));
    inputTokens += topicResult.usage.input_tokens;
    domains.forEach((pr, i) => {
      const answer = topicResult.answers[`t${i}`];
      if (answer.choice !== NONE && answer.probabilities[answer.choice] >= MIN_TOPIC_P) pr.topic = answer.choice;
    });
  }

  return {
    link_id: link.id,
    title: link.title,
    site: hostOf(link.url),
    descriptors: found,
    properties: properties.map((pr) => ({ ...pr, p: Math.round(pr.p * 1000) / 1000 })),
    inputTokens,
  };
}

Deno.serve(async (req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const ids: unknown = body?.link_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_LINK_IDS || !ids.every((i) => typeof i === "string")) {
    return new Response(JSON.stringify({ error: `link_ids must be 1 to ${MAX_LINK_IDS} ids` }), { status: 400 });
  }
  const { data: apiKey, error: keyError } = await db.rpc("get_vault_secret", { secret_name: TYPESAFE_KEY_SECRET });
  if (keyError || !apiKey) {
    return new Response(JSON.stringify({ error: `no ${TYPESAFE_KEY_SECRET} in Vault` }), { status: 500 });
  }
  const jev = new JevClient(apiKey, MODEL);
  const [links, topLevel] = await Promise.all([loadLinks(db, ids), topLevelTopics(db)]);

  const results: NonNullable<Awaited<ReturnType<typeof processLink>>>[] = [];
  const errors: unknown[] = [];
  const queue = [...links];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let link = queue.shift(); link; link = queue.shift()) {
      try {
        const result = await processLink(jev, link, topLevel);
        if (result) results.push(result);
      } catch (e) {
        errors.push({ link_id: link.id, error: String(e) });
      }
    }
  }));
  const properties = results.flatMap((r) => r.properties);
  return new Response(
    JSON.stringify({
      model: MODEL,
      links_scanned: links.length,
      links_with_descriptors: results.length,
      properties: properties.length,
      by_facet: properties.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.facet]: (acc[p.facet] ?? 0) + 1 }), {}),
      input_tokens: results.reduce((s, r) => s + r.inputTokens, 0),
      errors,
      results,
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
