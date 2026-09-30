import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient, JsonValue } from "../_shared/jev.ts";
import { candidates } from "./candidates.ts";

// Finds the named entities a link's title mentions and links each to a row in
// `entities`, creating it when it's new. Per link:
//  1. code proposes candidate phrases (candidates.ts);
//  2. one Jev request asks, for every candidate, whether it is a name, a
//     concept or neither, and what kind of thing it would be (the kind is read
//     only for names);
//  3. for each name, `entity_candidates` finds close existing entities; an exact
//     name match is taken as is, otherwise one more Jev request per link asks
//     which of them each name is, or none (then a new entity is created).
// Links are processed one at a time so an entity created for one link can be
// matched by the next. Each processed link gets `link_enrichment.entities_at`.
//
// POST {"link_ids": [...]} processes those links; POST {} the newest
// LINKS_PER_RUN not yet processed. "dry_run": true reports without writing.

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const NAME_MIN_P = 0.8;
const MATCH_MIN_P = 0.5;
const CANDIDATE_ENTITIES = 8;
const LINKS_PER_RUN = 30;
const MAX_LINK_IDS = 50;
const NEW_ENTITY = "new";

const MENTION_OPTIONS = {
  name:
    "The phrase is exactly the name of one specific, identifiable thing: a company, organisation, " +
    "person, product, place, event or work (a named model, app, book, film). Not more than the name " +
    "and not less.",
  concept:
    "The phrase is a general idea, technology, field or kind of thing (\"semantic layer\", \"electric " +
    "trucks\"), not the name of one specific thing.",
  other:
    "Neither: a vague or generic phrase (\"the last time\", \"some users\"), a fragment of a name, or " +
    "a phrase that runs a name together with other words or with another name.",
};

const KIND_OPTIONS = {
  company: "A business run for profit.",
  cooperative: "A cooperative owned by its workers or members.",
  nonprofit: "A charity, foundation, association or other non-profit organisation.",
  public_body: "A government, public agency, ministry, court, city or other public institution.",
  person: "A particular person.",
  product: "A product, service, app, model, device or piece of software.",
  place: "A country, city, region, building or other place.",
  event: "A particular event, conference, election, war or incident.",
  work: "A book, film, song, article, paper, game or other creative work.",
  other: "Something else.",
};

type Kind = keyof typeof KIND_OPTIONS;

interface Link {
  id: string;
  title: string;
  url: string;
}

interface Candidate {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  example_title: string | null;
  similarity: number;
}

interface Mention {
  surface: string;
  p: number;
  kind: Kind;
  entity_id: string | null;
  entity_name: string;
  decision: "exact" | "matched" | "new";
  match_p?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function describe(c: Candidate): string {
  return [
    `${c.name} (${c.kind})`,
    c.description ? `: ${c.description}` : "",
    c.example_title ? `. Mentioned before in: "${c.example_title}"` : "",
  ].join("");
}

async function findNames(jev: JevClient, state: JsonValue, phrases: string[]) {
  const questions: Record<string, ChoiceQuestion> = {};
  phrases.forEach((phrase, i) => {
    questions[`m${i}`] = {
      type: "choice",
      instructions: { phrase, question: "In the title of `link`, what is `phrase`?" },
      criteria: MENTION_OPTIONS,
    };
    questions[`k${i}`] = {
      type: "choice",
      instructions: { phrase, question: "If `phrase` names something in the title of `link`, what kind of thing is it?" },
      criteria: KIND_OPTIONS,
    };
  });
  const result = await jev.ask(state, questions);
  const names = phrases.flatMap((surface, i) => {
    const p = result.answers[`m${i}`].probabilities.name ?? 0;
    return p >= NAME_MIN_P ? [{ surface, p, kind: result.answers[`k${i}`].choice as Kind }] : [];
  });
  return { names, inputTokens: result.usage.input_tokens };
}

async function processLink(db: SupabaseClient, jev: JevClient, link: Link, dryRun: boolean) {
  const phrases = candidates(link.title);
  const state = { link: { title: link.title, site: hostOf(link.url) } };
  if (!phrases.length) return { link_id: link.id, title: link.title, candidates: phrases, mentions: [], inputTokens: 0 };

  const found = await findNames(jev, state, phrases);
  let inputTokens = found.inputTokens;

  const pending: { name: typeof found.names[number]; options: Candidate[] }[] = [];
  const mentions: Mention[] = [];
  for (const name of found.names) {
    const { data, error } = await db.rpc("entity_candidates", { phrase: name.surface, max_results: CANDIDATE_ENTITIES });
    if (error) throw new Error(error.message);
    const options = data as Candidate[];
    const exact = options.find((c) => c.name.toLowerCase() === name.surface.toLowerCase());
    if (exact) {
      mentions.push({ ...name, entity_id: exact.id, entity_name: exact.name, decision: "exact" });
    } else if (options.length) {
      pending.push({ name, options });
    } else {
      mentions.push({ ...name, entity_id: null, entity_name: name.surface, decision: "new" });
    }
  }

  if (pending.length) {
    const questions = Object.fromEntries(pending.map(({ name, options }, i) => [
      `e${i}`,
      {
        type: "choice",
        instructions: {
          phrase: name.surface,
          question: "In the title of `link`, which of these is `phrase` the name of? If it is none of them, say so.",
        },
        criteria: {
          ...Object.fromEntries(options.map((c) => [c.id, describe(c)])),
          [NEW_ENTITY]: "None of these: something else that isn't listed.",
        },
      } satisfies ChoiceQuestion,
    ]));
    const result = await jev.ask(state, questions);
    inputTokens += result.usage.input_tokens;
    pending.forEach(({ name, options }, i) => {
      const answer = result.answers[`e${i}`];
      const match = options.find((c) => c.id === answer.choice);
      const p = answer.probabilities[answer.choice];
      mentions.push(
        match && p >= MATCH_MIN_P
          ? { ...name, entity_id: match.id, entity_name: match.name, decision: "matched", match_p: p }
          : { ...name, entity_id: null, entity_name: name.surface, decision: "new", match_p: p },
      );
    });
  }

  if (!dryRun) {
    for (const mention of mentions) {
      if (!mention.entity_id) mention.entity_id = await createEntity(db, mention.surface, mention.kind);
      const { error } = await db.from("link_entities").upsert(
        { link_id: link.id, entity_id: mention.entity_id, surface: mention.surface, p: Math.round(mention.p * 1000) / 1000, labeled_by: "jev" },
        { onConflict: "link_id,entity_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
    }
    const { error } = await db.from("link_enrichment").upsert({ link_id: link.id, entities_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  return { link_id: link.id, title: link.title, candidates: phrases, mentions, inputTokens };
}

// `entities.name` is unique: a name Jev called new that already exists (it only
// differs in case, or was created concurrently) resolves to the existing row.
async function createEntity(db: SupabaseClient, name: string, kind: Kind): Promise<string> {
  const { data, error } = await db.from("entities").insert({ name, kind }).select("id").single();
  if (!error) return data.id;
  const { data: existing, error: readError } = await db.from("entities").select("id").ilike("name", name.replace(/[%_\\]/g, "\\$&")).limit(1).single();
  if (readError) throw new Error(`${error.message}; ${readError.message}`);
  return existing.id;
}

async function unprocessedLinks(db: SupabaseClient): Promise<Link[]> {
  const { data: rows, error } = await db.rpc("links_to_enrich", { step: "entities", max_results: LINKS_PER_RUN });
  if (error) throw new Error(error.message);
  const ids = (rows as { link_id: string }[]).map((r) => r.link_id);
  if (!ids.length) return [];
  const { data, error: linksError } = await db.from("links").select("id, title, url").in("id", ids);
  if (linksError) throw new Error(linksError.message);
  return data;
}

Deno.serve(async (req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const ids: unknown = body?.link_ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_LINK_IDS || !ids.every((i) => typeof i === "string"))) {
    return new Response(JSON.stringify({ error: `link_ids must be at most ${MAX_LINK_IDS} ids` }), { status: 400 });
  }
  const { data: apiKey, error: keyError } = await db.rpc("get_vault_secret", { secret_name: TYPESAFE_KEY_SECRET });
  if (keyError || !apiKey) {
    return new Response(JSON.stringify({ error: `no ${TYPESAFE_KEY_SECRET} in Vault` }), { status: 500 });
  }
  const jev = new JevClient(apiKey, MODEL);

  let links: Link[];
  if (ids) {
    const { data, error } = await db.from("links").select("id, title, url").in("id", ids as string[]);
    if (error) throw new Error(error.message);
    links = data;
  } else {
    links = await unprocessedLinks(db);
  }

  const results = [];
  const errors: unknown[] = [];
  for (const link of links) {
    try {
      results.push(await processLink(db, jev, link, dryRun));
    } catch (e) {
      errors.push({ link_id: link.id, error: String(e) });
    }
  }
  const mentions = results.flatMap((r) => r.mentions);
  return new Response(
    JSON.stringify({
      model: MODEL,
      dry_run: dryRun,
      links: results.length,
      mentions: mentions.length,
      new_entities: mentions.filter((m) => m.decision === "new").length,
      input_tokens: results.reduce((s, r) => s + r.inputTokens, 0),
      errors,
      results,
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
