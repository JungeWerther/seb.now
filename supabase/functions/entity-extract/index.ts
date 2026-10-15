import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient, JsonValue } from "../_shared/jev.ts";
import { pageCandidates } from "../_shared/names.ts";
import { fetchPage, PageContent, pageText } from "../_shared/page.ts";
import { candidates } from "./candidates.ts";

// Finds the named entities a link mentions and links each to a row in
// `entities`, creating it when it's new. Two passes, each marked in
// `link_enrichment`: the title (`entities_at`), then the page the link points
// to (`page_entities_at`). The page pass fetches the page once for every later
// step, keeping its cleaned text in `link_content`. Per pass:
//  1. code proposes candidate phrases (candidates.ts; on the page
//     _shared/names.ts, each with the sentence it appears in);
//  2. one Jev request asks, for every candidate, whether it is a name, a
//     concept or neither, and what kind of thing it would be (the kind is read
//     only for names);
//  3. for each name, `entity_candidates` finds close existing entities; an exact
//     name match is taken as is, otherwise one more Jev request per link asks
//     which of them each name is, or none (then a new entity is created).
// Mentions land in `link_entities` with `found_in` 'title' or 'page'; an
// entity the title already names keeps its title row. Links are processed one
// at a time so an entity created for one link can be matched by the next.
//
// POST {} runs the title pass on up to LINKS_PER_RUN links, then the page pass
// on up to PAGE_LINKS_PER_RUN, newest first, starting no page after
// RUN_BUDGET_MS. POST {"link_ids": [...]} runs both passes on those links.
// "dry_run": true reports without writing.

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const NAME_MIN_P = 0.8;
const MATCH_MIN_P = 0.5;
const CANDIDATE_ENTITIES = 8;
const LINKS_PER_RUN = 30;
const PAGE_LINKS_PER_RUN = 12;
const FETCH_CONCURRENCY = 4;
const RUN_BUDGET_MS = 100_000;
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

// On the page, whether a phrase is a name and of what kind is one question, so
// a page's many phrases cost one question each: a name's p is the sum over kinds.
const CONCEPT = "concept";
const NOT_A_NAME = "not_a_name";
const PAGE_MENTION_OPTIONS = {
  ...Object.fromEntries(Object.entries(KIND_OPTIONS).map(([kind, description]) => [
    kind,
    `The phrase is exactly the name, not more and not less, of one specific thing of this kind: ${description}`,
  ])),
  [CONCEPT]: MENTION_OPTIONS.concept,
  [NOT_A_NAME]: MENTION_OPTIONS.other,
};
type FoundIn = "title" | "page";

interface Phrase {
  surface: string;
  sentence: string | null;
}

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
  sentence: string | null;
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

// Where a phrase was found, for the questions about it.
function phraseInstructions({ surface, sentence }: Phrase, question: string): JsonValue {
  return sentence
    ? { phrase: surface, sentence, question: `In \`sentence\`, from the page \`link\` points to, ${question}` }
    : { phrase: surface, question: `In the title of \`link\`, ${question}` };
}

async function findNames(jev: JevClient, state: JsonValue, phrases: Phrase[]) {
  const questions: Record<string, ChoiceQuestion> = {};
  phrases.forEach((phrase, i) => {
    if (phrase.sentence) {
      questions[`m${i}`] = {
        type: "choice",
        instructions: phraseInstructions(phrase, "what is `phrase`?"),
        criteria: PAGE_MENTION_OPTIONS,
      };
      return;
    }
    questions[`m${i}`] = {
      type: "choice",
      instructions: phraseInstructions(phrase, "what is `phrase`?"),
      criteria: MENTION_OPTIONS,
    };
    questions[`k${i}`] = {
      type: "choice",
      instructions: phraseInstructions(phrase, "if `phrase` names something, what kind of thing is it?"),
      criteria: KIND_OPTIONS,
    };
  });
  const result = await jev.ask(state, questions);
  const names = phrases.flatMap(({ surface, sentence }, i) => {
    const probabilities = result.answers[`m${i}`].probabilities as Record<string, number>;
    let p: number;
    let kind: Kind;
    if (sentence) {
      const kinds = (Object.keys(KIND_OPTIONS) as Kind[]).map((k) => [k, probabilities[k] ?? 0] as const);
      p = kinds.reduce((sum, [, q]) => sum + q, 0);
      kind = kinds.reduce((best, x) => (x[1] > best[1] ? x : best))[0];
    } else {
      p = probabilities.name ?? 0;
      kind = result.answers[`k${i}`].choice as Kind;
    }
    return p >= NAME_MIN_P ? [{ surface, sentence, p, kind }] : [];
  });
  return { names, inputTokens: result.usage.input_tokens };
}

async function mentionsOf(db: SupabaseClient, jev: JevClient, link: Link, phrases: Phrase[]) {
  const state = { link: { title: link.title, site: hostOf(link.url) } };
  if (!phrases.length) return { mentions: [] as Mention[], inputTokens: 0 };

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
        instructions: phraseInstructions(name, "which of these is `phrase` the name of? If it is none of them, say so."),
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

  return { mentions, inputTokens };
}

async function saveMentions(db: SupabaseClient, linkId: string, mentions: Mention[], foundIn: FoundIn) {
  for (const mention of mentions) {
    if (!mention.entity_id) mention.entity_id = await createEntity(db, mention.surface, mention.kind);
    const { error } = await db.from("link_entities").upsert(
      { link_id: linkId, entity_id: mention.entity_id, surface: mention.surface, p: Math.round(mention.p * 1000) / 1000, labeled_by: "jev", found_in: foundIn },
      { onConflict: "link_id,entity_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  }
}

async function processTitle(db: SupabaseClient, jev: JevClient, link: Link, dryRun: boolean) {
  const phrases = candidates(link.title).map((surface) => ({ surface, sentence: null }));
  const { mentions, inputTokens } = await mentionsOf(db, jev, link, phrases);
  if (!dryRun) {
    await saveMentions(db, link.id, mentions, "title");
    const { error } = await db.from("link_enrichment").upsert({ link_id: link.id, entities_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  return { link_id: link.id, title: link.title, found_in: "title", candidates: phrases.map((p) => p.surface), mentions, inputTokens };
}

async function processPage(db: SupabaseClient, jev: JevClient, link: Link, page: PageContent, dryRun: boolean) {
  const phrases = pageCandidates(page.sections, link.title);
  const { mentions, inputTokens } = await mentionsOf(db, jev, link, phrases);
  if (!dryRun) {
    const { error: contentError } = await db.from("link_content").upsert({
      link_id: link.id,
      fetched_at: new Date().toISOString(),
      status: page.status,
      lang: page.lang?.slice(0, 35) ?? null,
      text: pageText(page.sections) || null,
      json_ld_events: page.jsonLdEvents.length ? page.jsonLdEvents : null,
    });
    if (contentError) throw new Error(contentError.message);
    await saveMentions(db, link.id, mentions, "page");
    const { error } = await db.from("link_enrichment").upsert({ link_id: link.id, page_entities_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  return { link_id: link.id, title: link.title, found_in: "page", status: page.status, candidates: phrases.map((p) => p.surface), mentions, inputTokens };
}

// Pages are fetched FETCH_CONCURRENCY at a time, ahead of the one-at-a-time Jev work.
function prefetch(links: Link[]): Promise<PageContent>[] {
  const lanes: Promise<unknown>[] = Array.from({ length: FETCH_CONCURRENCY }, () => Promise.resolve());
  return links.map((link, i) => {
    const page = lanes[i % FETCH_CONCURRENCY].then(() => fetchPage(link.url));
    lanes[i % FETCH_CONCURRENCY] = page;
    return page;
  });
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

async function unprocessedLinks(db: SupabaseClient, step: "entities" | "page_entities", max: number): Promise<Link[]> {
  const { data: rows, error } = await db.rpc("links_to_enrich", { step, max_results: max });
  if (error) throw new Error(error.message);
  const ids = (rows as { link_id: string }[]).map((r) => r.link_id);
  if (!ids.length) return [];
  const { data, error: linksError } = await db.from("links").select("id, title, url").in("id", ids);
  if (linksError) throw new Error(linksError.message);
  const byId = new Map((data as Link[]).map((l) => [l.id, l]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
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

  let titleLinks: Link[];
  if (ids) {
    const { data, error } = await db.from("links").select("id, title, url").in("id", ids as string[]);
    if (error) throw new Error(error.message);
    titleLinks = data;
  } else {
    titleLinks = await unprocessedLinks(db, "entities", LINKS_PER_RUN);
  }

  const results = [];
  const errors: unknown[] = [];
  for (const link of titleLinks) {
    try {
      results.push(await processTitle(db, jev, link, dryRun));
    } catch (e) {
      errors.push({ link_id: link.id, found_in: "title", error: String(e) });
    }
  }

  const pageLinks = ids ? titleLinks : await unprocessedLinks(db, "page_entities", PAGE_LINKS_PER_RUN);
  const pages = prefetch(pageLinks);
  for (const [i, link] of pageLinks.entries()) {
    if (!ids && Date.now() - started > RUN_BUDGET_MS) break;
    try {
      results.push(await processPage(db, jev, link, await pages[i], dryRun));
    } catch (e) {
      errors.push({ link_id: link.id, found_in: "page", error: String(e) });
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
