import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient, JsonValue } from "../_shared/jev.ts";
import { isPresent, json, reporting } from "../_shared/helpers.ts";
import { serveJev } from "../_shared/jev_function.ts";
import { pool } from "../_shared/pool.ts";
import { nameHints } from "../_shared/hints.ts";
import { fold, NameHints, pageCandidates, WORD } from "../_shared/names.ts";
import { fetchHtml, fetchPage, PageContent, pageText, readPage } from "../_shared/page.ts";
import { candidates } from "./candidates.ts";
import { aloneSentence, contains, containsName, nameWords, readSpans, sentenceWith, SpanReading } from "../_shared/spans.ts";
import { ENTITY_EXTRACT, JEV, PAGE } from "../_shared/constants.ts";

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
//     name match of the same kind is taken as is (names are unique per kind:
//     the same words as another kind are another sense), otherwise one more Jev request per link asks
//     which of them each name is, or none (then a new entity is created).
//     A name that a longer name in the same pass contains ("Pusateri" in "Drew
//     Pusateri") is always asked, with those longer names as options too: a
//     page's short forms are mostly the person or thing it named in full, and
//     taking an exact match would join every bare "Sarah" into one entity.
//  Between 2 and 3, a name the text only ever says inside a longer name
//  ("Tokyo" in "Palais de Tokyo") is a fragment (_shared/spans.ts): one more
//  Jev question asks of each longer name holding one whether it is one name
//  or runs several together ("Ledger Flex and Ledger Stax"); the run-together
//  names give way to their parts, and every other fragment is dropped, so the
//  short name is never a mention of its own. The page pass counts the title's
//  names as read whole, and offers them as longer names too.
// Mentions land in `link_entities` with `found_in` 'title' or 'page'; an
// entity the title already names keeps its title row. Links are processed one
// at a time so an entity created for one link can be matched by the next.
//
// POST {} runs the title pass on up to LINKS_PER_RUN links, then the page pass
// on up to PAGE_LINKS_PER_RUN, newest first, starting no page after
// RUN_BUDGET_MS. POST {"link_ids": [...]} runs both passes on those links.
// "dry_run": true reports without writing.
//
// POST {"respan": true, "link_ids": [...], "batch": "<label>"} re-reads the
// mentions already stored for those links with the same span rule and stages
// every fragment, or run-together name, as a `drop_mention` row in
// `entity_edits` (status 'staged'), applying nothing; "dry_run" only reports.
//
// POST {"eval": true} scores the page pass's candidates against the
// hand-labelled names in `entity_gold` (on its links, or on `link_ids`), with
// no Jev call and no writes: per link, which labelled names are among the
// candidates exactly or overlapping one, and how long each step took.
// "decide": true also runs the dry run's decisions and scores the mentions;
// "text": true adds the page text as read.

const NEW_ENTITY = "new";
const UNIQUE_VIOLATION = "23505";
const SAME_AS_PREFIX = "same_as_";

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
  decision: "exact" | "matched" | "new" | "same_as" | "known";
  match_p?: number;
  same_as?: string;
}

type Name = Omit<Mention, "entity_id" | "entity_name" | "decision" | "match_p" | "same_as">;

// A name the span rule set aside, and why: only part of a longer name, or a
// longer name that ran several things together.
interface Dropped {
  surface: string;
  reason: "part_of_name" | "runs_together";
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

// Whether `a` resolves before `b`: more words first, and of two spellings of
// the same words ("Sean O'Kane", "Sean O’Kane") the greater one, so a name only
// ever points to one that comes before it.
function before(a: Name, b: Name): boolean {
  const [x, y] = [nameWords(a.surface).length, nameWords(b.surface).length];
  return x !== y ? x > y : a.surface > b.surface;
}

// The other names in the same pass that contain `name` or spell it differently,
// closest in length first.
function longerNames(name: Name, names: Name[]): Name[] {
  const words = nameWords(name.surface);
  return names
    .map((other) => ({ other, words: nameWords(other.surface) }))
    .filter(({ other, words: longer }) =>
      containsName(longer, words) || (longer.join(" ") === words.join(" ") && before(other, name)))
    .sort((a, b) => a.words.length - b.words.length)
    .slice(0, ENTITY_EXTRACT.SAME_PASS_OPTIONS)
    .map(({ other }) => other);
}

function describeSamePass(other: Name): string {
  return other.sentence
    ? `The same thing as "${other.surface}", which the page also names: "${other.sentence}"`
    : `The same thing as "${other.surface}", which the title also names.`;
}

// Where a phrase was found, for the questions about it.
function phraseInstructions({ surface, sentence }: Phrase, question: string): JsonValue {
  return sentence
    ? { phrase: surface, sentence, question: `In \`sentence\`, from the page \`link\` points to, ${question}` }
    : { phrase: surface, question: `In the title of \`link\`, ${question}` };
}

// The options for whether a longer name holding `parts` is one name.
function spanCriteria(parts: string[]): Record<"whole" | "parts", string> {
  const quoted = parts.map((part) => `"${part}"`).join(", ");
  const one = parts.length === 1;
  return {
    whole: `One name, of one thing. ${quoted} ${one ? "is" : "are"} only part of it here, not ${one ? "a name" : "names"} of ${one ? "its" : "their"} own.`,
    parts: `Not one name: it runs ${quoted} together with other words or another name, and ${one ? "it names" : "they name"} something on ${one ? "its" : "their"} own.`,
  };
}

// Asks, of each longer name holding a fragment, whether it runs several things
// together; those that do (p of "parts" at least SPAN_PARTS_MIN_P) are returned.
function askRunTogether(jev: JevClient, linkId: string, state: JsonValue, spend: (inputTokens: number) => void) {
  return async <N extends Name>(holders: { name: N; parts: N[] }[]): Promise<Set<N>> => {
    const questions = Object.fromEntries(holders.map(({ name, parts }, i) => [
      `s${i}`,
      {
        type: "choice",
        instructions: phraseInstructions(name, "is `phrase` the name of one thing, or does it run separate things together?"),
        criteria: spanCriteria(parts.map((part) => part.surface)),
      } satisfies ChoiceQuestion,
    ]));
    const result = await jev.ask(state, questions, linkId);
    spend(result.usage.input_tokens);
    return new Set(holders
      .filter((_, i) => (result.answers[`s${i}`].probabilities.parts ?? 0) >= ENTITY_EXTRACT.SPAN_PARTS_MIN_P)
      .map(({ name }) => name));
  };
}

function droppedBy<N extends Name>(spans: SpanReading<N>): Dropped[] {
  return [
    ...spans.parts.map(({ surface }) => ({ surface, reason: "part_of_name" as const })),
    ...spans.runTogether.map(({ surface }) => ({ surface, reason: "runs_together" as const })),
  ];
}

async function findNames(jev: JevClient, linkId: string, state: JsonValue, phrases: Phrase[]) {
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
  const result = await jev.ask(state, questions, linkId);
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
    return p >= ENTITY_EXTRACT.NAME_MIN_P ? [{ surface, sentence, p, kind }] : [];
  });
  return { names, inputTokens: result.usage.input_tokens };
}

// `text` is what the pass read (the title, or the title and the page), for the
// span rule; `known` are names already resolved for this link (the title's, on
// the page), which count as read whole and can be the longer name a short form
// stands for.
async function mentionsOf(db: SupabaseClient, jev: JevClient, link: Link, phrases: Phrase[], text: string, known: Mention[] = []) {
  const state = { link: { title: link.title, site: hostOf(link.url) } };
  if (!phrases.length) return { mentions: [] as Mention[], dropped: [] as Dropped[], inputTokens: 0 };

  const found = await findNames(jev, link.id, state, phrases);
  let inputTokens = found.inputTokens;
  const spans = await readSpans(found.names, known, text, askRunTogether(jev, link.id, state, (n) => inputTokens += n));
  const names = spans.kept;

  const pending: { name: Name; options: Candidate[]; longer: Name[] }[] = [];
  const mentions: Mention[] = [];
  for (const name of names) {
    const { data, error } = await db.rpc("entity_candidates", { phrase: name.surface, max_results: ENTITY_EXTRACT.CANDIDATE_ENTITIES });
    if (error) throw new Error(error.message);
    const options = data as Candidate[];
    const longer = longerNames(name, [...names, ...known]);
    // An exact match is the same name *as the same kind*: "Tonight" the film
    // isn't the period, and a name with senses of other kinds only is asked.
    const exact = options.find((c) => c.name.toLowerCase() === name.surface.toLowerCase() && c.kind === name.kind);
    if (longer.length) {
      // A longer name that is already an entity would be offered twice and split
      // the vote: by its name, or by the entity a known name resolved to.
      const offered = new Set(longer.map((o) => o.surface.toLowerCase()));
      const offeredIds = new Set(longer.flatMap((o) => ("entity_id" in o && o.entity_id ? [o.entity_id as string] : [])));
      pending.push({ name, options: options.filter((c) => !offered.has(c.name.toLowerCase()) && !offeredIds.has(c.id)), longer });
    } else if (exact) {
      mentions.push({ ...name, entity_id: exact.id, entity_name: exact.name, decision: "exact" });
    } else if (options.length) {
      pending.push({ name, options, longer });
    } else {
      mentions.push({ ...name, entity_id: null, entity_name: name.surface, decision: "new" });
    }
  }

  if (pending.length) {
    const questions = Object.fromEntries(pending.map(({ name, options, longer }, i) => [
      `e${i}`,
      {
        type: "choice",
        instructions: phraseInstructions(name, "which of these is `phrase` the name of? If it is none of them, say so."),
        criteria: {
          ...Object.fromEntries(longer.map((other, j) => [`${SAME_AS_PREFIX}${j}`, describeSamePass(other)])),
          ...Object.fromEntries(options.map((c) => [c.id, describe(c)])),
          [NEW_ENTITY]: "None of these: something else that isn't listed.",
        },
      } satisfies ChoiceQuestion,
    ]));
    const result = await jev.ask(state, questions, link.id);
    inputTokens += result.usage.input_tokens;
    pending.forEach(({ name, options, longer }, i) => {
      const answer = result.answers[`e${i}`];
      const p = answer.probabilities[answer.choice];
      const same = answer.choice.startsWith(SAME_AS_PREFIX) ? longer[Number(answer.choice.slice(SAME_AS_PREFIX.length))] : null;
      const match = options.find((c) => c.id === answer.choice);
      mentions.push(
        same && p >= ENTITY_EXTRACT.MATCH_MIN_P
          ? { ...name, entity_id: null, entity_name: same.surface, decision: "same_as", match_p: p, same_as: same.surface }
          : match && p >= ENTITY_EXTRACT.MATCH_MIN_P
          ? { ...name, entity_id: match.id, entity_name: match.name, decision: "matched", match_p: p }
          : { ...name, entity_id: null, entity_name: name.surface, decision: "new", match_p: p },
      );
    });
  }

  return { mentions: followSameAs(mentions, known), dropped: droppedBy(spans), inputTokens };
}

// A name resolved to a longer one in the same pass (or a known one) takes that
// name's entity, following chains ("Trump" → "Donald Trump" → "President
// Donald Trump"); a name only points to one `before` it, so there are no
// cycles, and sorting by `before` lets `saveMentions` create an entity before
// its short forms need it.
function followSameAs(mentions: Mention[], known: Mention[]): Mention[] {
  const bySurface = new Map([...known, ...mentions].map((m) => [m.surface, m]));
  const target = (m: Mention): Mention => (m.same_as && bySurface.has(m.same_as) ? target(bySurface.get(m.same_as)!) : m);
  for (const m of mentions) {
    if (m.decision !== "same_as") continue;
    const t = target(m);
    m.entity_id = t.entity_id;
    m.entity_name = t.entity_name;
  }
  return mentions.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}

async function saveMentions(db: SupabaseClient, linkId: string, mentions: Mention[], foundIn: FoundIn) {
  const bySurface = new Map(mentions.map((m) => [m.surface, m]));
  for (const mention of mentions) {
    const target = mention.same_as ? bySurface.get(mention.same_as) : undefined;
    if (!mention.entity_id && target) mention.entity_id = target.entity_id;
    if (!mention.entity_id) mention.entity_id = await createEntity(db, mention.surface, mention.kind);
    const { error } = await db.from("link_entities").upsert(
      { link_id: linkId, entity_id: mention.entity_id, surface: mention.surface, p: Math.round(mention.p * 1000) / 1000, labeled_by: "jev", found_in: foundIn },
      { onConflict: "link_id,entity_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  }
}

async function processTitle(db: SupabaseClient, jev: JevClient, link: Link, dryRun: boolean) {
  const hints = await nameHints(db, [link.title], null);
  const phrases = candidates(link.title, hints).map((surface) => ({ surface, sentence: null }));
  const { mentions, dropped, inputTokens } = await mentionsOf(db, jev, link, phrases, link.title);
  if (!dryRun) {
    await saveMentions(db, link.id, mentions, "title");
    const { error } = await db.from("link_enrichment").upsert({ link_id: link.id, entities_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  return { link_id: link.id, title: link.title, found_in: "title", candidates: phrases.map((p) => p.surface), mentions, dropped, inputTokens };
}

function sectionTexts(page: PageContent): string[] {
  return page.sections.map((s) => [s.heading, s.text].filter(Boolean).join("\n"));
}

// The title's phrases that are part of a title name but that the page also
// says on its own ("Tokyo" after "Palais de Tokyo"): the page's own candidates
// leave out everything the title says, so these are offered again with the
// page sentence that says them.
async function titleFragmentsOnPage(db: SupabaseClient, link: Link, known: Mention[], body: string, lang: string | null): Promise<Phrase[]> {
  if (!known.length || !body) return [];
  const titlePhrases = candidates(link.title, await nameHints(db, [link.title], null));
  return titlePhrases.flatMap((surface) => {
    const holders = known.filter((k) => contains(k, { surface }));
    const sentence = holders.length ? aloneSentence(body, surface, holders.map((h) => h.surface), lang) : null;
    return sentence ? [{ surface, sentence }] : [];
  });
}

// What the page pass asks about: the page's own candidates, and the title
// fragments the page says on its own.
async function pagePhrases(db: SupabaseClient, link: Link, page: PageContent, known: Mention[], hints: NameHints): Promise<Phrase[]> {
  const ownPhrases = pageCandidates(page.sections, link.title, hints);
  const offered = new Set(ownPhrases.map((p) => p.surface.toLowerCase()));
  const recovered = await titleFragmentsOnPage(db, link, known, sectionTexts(page).join("\n"), page.lang);
  return [...ownPhrases, ...recovered.filter((p) => !offered.has(p.surface.toLowerCase()))];
}

// The text a page pass reads, whole: `pageText` is capped for storage, but the
// candidates come from every section, so the span rule must see them all. The
// names the page declares in its structured data each stand on their own line:
// a declared name is a reference of its own, never a fragment.
function readText(link: Link, page: PageContent): string {
  return [link.title, ...sectionTexts(page), ...page.declared.map((d) => d.name)].join("\n");
}

// `titleNames` are the title pass's names when they weren't saved (a dry run);
// otherwise the stored title mentions are read.
async function processPage(db: SupabaseClient, jev: JevClient, link: Link, page: PageContent, dryRun: boolean, titleNames?: Mention[]) {
  const known = titleNames ?? await storedMentions(db, link.id, "title");
  const hints = await nameHints(db, sectionTexts(page), page.lang, page.declared);
  const phrases = await pagePhrases(db, link, page, known, hints);
  const text = readText(link, page);
  const { mentions, dropped, inputTokens } = await mentionsOf(db, jev, link, phrases, text, known);
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
  return { link_id: link.id, title: link.title, found_in: "page", status: page.status, candidates: phrases.map((p) => p.surface), mentions, dropped, inputTokens };
}

interface StoredMention {
  entity_id: string;
  surface: string | null;
  p: number;
  found_in: FoundIn;
  entities: { name: string; kind: Kind } | null;
}

// A link's mentions found by Jev in `foundIn` (or both passes), as resolved names.
async function storedMentions(db: SupabaseClient, linkId: string, foundIn?: FoundIn): Promise<(Mention & { found_in: FoundIn })[]> {
  let query = db.from("link_entities").select("entity_id, surface, p, found_in, entities(name, kind)")
    .eq("link_id", linkId).eq("labeled_by", "jev");
  query = foundIn ? query.eq("found_in", foundIn) : query.in("found_in", ["title", "page"]);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as unknown as StoredMention[]).flatMap(({ entity_id, surface, p, found_in, entities }) =>
    surface && entities
      ? [{ surface, sentence: null, p, kind: entities.kind, entity_id, entity_name: entities.name, decision: "known" as const, found_in }]
      : []
  );
}

// Re-reads the mentions stored for `link` with the span rule, pass by pass,
// and returns those it would drop with their entities.
async function respanLink(db: SupabaseClient, jev: JevClient, link: Link) {
  const stored = await storedMentions(db, link.id);
  const { data: content, error } = await db.from("link_content").select("text, lang").eq("link_id", link.id).maybeSingle();
  if (error) throw new Error(error.message);
  const pageText = content?.text ?? "";
  const titles = stored.filter((m) => m.found_in === "title");
  const pages = stored.filter((m) => m.found_in === "page")
    .map((m) => ({ ...m, sentence: sentenceWith(pageText, m.surface, content?.lang) ?? m.surface }));
  const state = { link: { title: link.title, site: hostOf(link.url) } };
  let inputTokens = 0;
  const ask = askRunTogether(jev, link.id, state, (n) => inputTokens += n);
  // A title name is a fragment only if the page doesn't say it on its own either.
  const text = [link.title, pageText].join("\n");
  const title = await readSpans(titles, [], text, ask);
  const page = await readSpans(pages, title.kept, text, ask);
  // Stored text is capped: on a page cut at the cap, a name may stand alone in
  // the part not kept, so page fragments aren't dropped there.
  const capped = pageText.length >= PAGE.MAX_TEXT_CHARS;
  const drops = [title, capped ? { ...page, parts: [] } : page].flatMap((spans) => [
    ...spans.parts.map((m) => ({ mention: m, reason: "only part of a longer name here" })),
    // A run-together surface that resolved to one of its own parts ("Ledger
    // Flex and Ledger Stax" stored as Ledger Flex) still names that entity.
    ...spans.runTogether
      .filter((m) => !contains(m, { surface: m.entity_name }))
      .map((m) => ({ mention: m, reason: "runs several names together" })),
  ]);
  return { link_id: link.id, title: link.title, drops, inputTokens };
}

// Stages each drop as an `entity_edits` row, skipping mentions already staged
// or dropped.
async function stageDrops(db: SupabaseClient, batch: string, results: Awaited<ReturnType<typeof respanLink>>[]) {
  const rows = results.flatMap(({ link_id, drops }) => drops.map(({ mention, reason }) => ({
    batch,
    op: "drop_mention",
    link_id,
    entity_id: mention.entity_id!,
    entity_name: mention.entity_name,
    reason: `${reason}: "${mention.surface}"`.slice(0, 300),
    decided_by: "jev",
  })));
  if (!rows.length) return 0;
  const { data: existing, error } = await db.from("entity_edits").select("link_id, entity_id")
    .eq("op", "drop_mention").in("status", ["staged", "applied"]).in("link_id", [...new Set(rows.map((r) => r.link_id))]);
  if (error) throw new Error(error.message);
  const seen = new Set((existing as { link_id: string; entity_id: string }[]).map((r) => `${r.link_id} ${r.entity_id}`));
  const fresh = rows.filter((r) => !seen.has(`${r.link_id} ${r.entity_id}`));
  // One row at a time, so a drop another request staged meanwhile (the unique
  // index on staged drops) skips that row instead of failing the batch.
  let staged = 0;
  for (const row of fresh) {
    const { error: insertError } = await db.from("entity_edits").insert(row);
    if (insertError && insertError.code !== UNIQUE_VIOLATION) throw new Error(insertError.message);
    if (!insertError) staged++;
  }
  return staged;
}

// Pages are fetched FETCH_CONCURRENCY at a time, ahead of the one-at-a-time Jev work.
function prefetch<T>(links: Link[], fetchOne: (url: string) => Promise<T>): Promise<T>[] {
  const lanes: Promise<unknown>[] = Array.from({ length: ENTITY_EXTRACT.FETCH_CONCURRENCY }, () => Promise.resolve());
  return links.map((link, i) => {
    const page = lanes[i % ENTITY_EXTRACT.FETCH_CONCURRENCY].then(() => fetchOne(link.url));
    lanes[i % ENTITY_EXTRACT.FETCH_CONCURRENCY] = page;
    return page;
  });
}

function nameKey(name: string): string[] {
  return [...name.matchAll(WORD)].map((m) => fold(m[0]));
}

// Whether one name's words run, in order, inside the other's.
function overlaps(a: string[], b: string[]): boolean {
  const [inner, outer] = a.length <= b.length ? [a, b] : [b, a];
  if (!inner.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

// How well `found` covers the labelled names: exactly (same words), or
// overlapping (one inside the other: "Monet" for "Claude Monet"); and how
// many of `found` overlap a labelled name at all.
function score(gold: string[], found: string[]) {
  const g = gold.map(nameKey);
  const f = found.map(nameKey);
  const exact = g.filter((x) => f.some((y) => y.join(" ") === x.join(" "))).length;
  const missed = gold.filter((_, i) => !f.some((y) => overlaps(y, g[i])));
  const relevant = f.filter((y) => g.some((x) => overlaps(x, y))).length;
  // Found names that are only part of a labelled name ("Tokyo" for "Palais
  // de Tokyo"): counted relevant above, but they are the span rule's misses.
  const fragments = found.filter((_, i) =>
    !g.some((x) => x.join(" ") === f[i].join(" ")) && g.some((x) => f[i].length < x.length && overlaps(x, f[i])));
  return { exact, overlapping: gold.length - missed.length, relevant, missed, fragments };
}

async function evaluate(db: SupabaseClient, jev: JevClient, ids: string[] | null, decide: boolean, withText: boolean) {
  let query = db.from("entity_gold").select("link_id, name");
  if (ids) query = query.in("link_id", ids);
  const { data: goldRows, error } = await query;
  if (error) throw new Error(error.message);
  const gold = new Map<string, string[]>();
  for (const r of goldRows as { link_id: string; name: string }[]) gold.set(r.link_id, [...(gold.get(r.link_id) ?? []), r.name]);
  const { data: links, error: linksError } = await db.from("links").select("id, title, url").in("id", (ids ?? [...gold.keys()]).slice(0, ENTITY_EXTRACT.MAX_LINK_IDS));
  if (linksError) throw new Error(linksError.message);

  const htmls = prefetch(links as Link[], fetchHtml);
  const results: Record<string, unknown>[] = [];
  for (const [i, link] of (links as Link[]).entries()) {
    const names = gold.get(link.id) ?? [];
    const { status, html } = await htmls[i];
    const t0 = performance.now();
    const page: PageContent = html === null
      ? { status, lang: null, sections: [], jsonLdEvents: [], declared: [] }
      : { status, ...readPage(html) };
    const t1 = performance.now();
    const hints = await nameHints(db, sectionTexts(page), page.lang, page.declared);
    const t2 = performance.now();
    const known = await storedMentions(db, link.id, "title");
    const phrases = await pagePhrases(db, link, page, known, hints);
    const t3 = performance.now();
    const surfaces = phrases.map((p) => p.surface);
    const text = pageText(page.sections);
    const result: Record<string, unknown> = {
      link_id: link.id,
      title: link.title,
      status,
      html_chars: html?.length ?? 0,
      text_chars: text.length,
      ms: { read: Math.round(t1 - t0), hints: Math.round(t2 - t1), candidates: Math.round(t3 - t2) },
      gold: names.length,
      candidates: surfaces.length,
      ...score(names, surfaces),
      declared: page.declared.map((d) => d.name),
      candidate_list: surfaces,
    };
    if (decide) {
      const { mentions, dropped } = await mentionsOf(db, jev, link, phrases, readText(link, page), known);
      const m = score(names, mentions.map((x) => x.surface));
      result.mentions = {
        count: mentions.length,
        exact: m.exact,
        overlapping: m.overlapping,
        relevant: m.relevant,
        fragments: m.fragments,
        list: mentions.map((x) => x.surface),
        dropped,
      };
    }
    if (withText) result.text = text;
    results.push(result);
  }
  const sum = (f: (r: Record<string, unknown>) => number) => results.reduce((s, r) => s + f(r), 0);
  const goldTotal = sum((r) => r.gold as number);
  const mention = (k: string) => sum((r) => ((r.mentions as Record<string, number> | undefined)?.[k] ?? 0));
  return {
    links: results.length,
    gold: goldTotal,
    candidate_recall_exact: sum((r) => r.exact as number) / goldTotal,
    candidate_recall_overlapping: sum((r) => r.overlapping as number) / goldTotal,
    candidate_precision: sum((r) => r.relevant as number) / sum((r) => r.candidates as number),
    ...(decide
      ? {
        mention_recall_exact: mention("exact") / goldTotal,
        mention_recall_overlapping: mention("overlapping") / goldTotal,
        mention_precision: mention("relevant") / mention("count"),
        mention_fragments: sum((r) => ((r.mentions as { fragments?: string[] } | undefined)?.fragments?.length ?? 0)),
      }
      : {}),
    results,
  };
}

// A name is unique per kind (ignoring case), not globally: the same words can
// name a place and a work, each its own sense. A name Jev called new that
// already exists *as this kind* (it only differs in case, or was created
// concurrently) resolves to that row; the same name as another kind is a new
// sense, never merged into it.
async function createEntity(db: SupabaseClient, name: string, kind: Kind): Promise<string> {
  const { data, error } = await db.from("entities").insert({ name, kind }).select("id").single();
  if (!error) return data.id;
  const { data: existing, error: readError } = await db.from("entities").select("id, kind")
    .ilike("name", name.replace(/[%_\\]/g, "\\$&"));
  if (readError) throw new Error(`${error.message}; ${readError.message}`);
  const same = (existing as { id: string; kind: string }[]).find((r) => r.kind === kind);
  if (!same) throw new Error(`${error.message}; no ${kind} named ${name}`);
  return same.id;
}

async function linksById(db: SupabaseClient, ids: string[]): Promise<Link[]> {
  const { data, error } = await db.from("links").select("id, title, url").in("id", ids);
  if (error) throw new Error(error.message);
  return data;
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

Deno.serve(serveJev({
  fn: "entity-extract",
  model: JEV.MODEL,
  maxLinkIds: ENTITY_EXTRACT.MAX_LINK_IDS,
  readOnly: (body) => body.eval === true,
}, async ({ db, jev, ids, dryRun, body, report }) => {
  const started = Date.now();
  if (body.eval === true) {
    const evaluation = await evaluate(db, jev, ids, body.decide === true, body.text === true);
    return json(evaluation);
  }
  if (body.respan === true) {
    const batch = typeof body.batch === "string" ? body.batch : "";
    if (!ids || !ENTITY_EXTRACT.BATCH_PATTERN.test(batch)) return json({ error: "respan needs link_ids and a batch label" }, 400);
    const results = (await pool(await linksById(db, ids), 1, reporting(report, (link: Link) => ({ link_id: link.id, found_in: "respan" }), (link) =>
      respanLink(db, jev, link)))).filter(isPresent);
    const staged = dryRun ? 0 : await stageDrops(db, batch, results);
    return {
      links: results.length,
      drops: results.reduce((n, r) => n + r.drops.length, 0),
      staged,
      input_tokens: results.reduce((n, r) => n + r.inputTokens, 0),
      results: results.map(({ link_id, title, drops }) => ({
        link_id,
        title,
        drops: drops.map(({ mention, reason }) => ({ surface: mention.surface, entity: mention.entity_name, reason })),
      })),
    };
  }

  // One link at a time, so an entity a link creates is matchable by the next.
  const titleLinks = ids ? await linksById(db, ids) : await unprocessedLinks(db, "entities", ENTITY_EXTRACT.LINKS_PER_RUN);
  const titles = await pool(titleLinks, 1, reporting(report, (link: Link) => ({ link_id: link.id, found_in: "title" }), (link) =>
    processTitle(db, jev, link, dryRun)));

  // A dry run saves nothing, so its page pass takes the title pass's names directly.
  const titleNamesOf = new Map(titles.filter(isPresent).map((r) => [r.link_id, r.mentions]));
  const pageLinks = ids ? titleLinks : await unprocessedLinks(db, "page_entities", ENTITY_EXTRACT.PAGE_LINKS_PER_RUN);
  const prefetched = prefetch(pageLinks, fetchPage);
  const overBudget = () => !ids && Date.now() - started > ENTITY_EXTRACT.RUN_BUDGET_MS;
  const pageResults = await pool(
    pageLinks.map((link, i) => ({ link, page: prefetched[i] })),
    1,
    reporting(report, ({ link }) => ({ link_id: link.id, found_in: "page" }), async ({ link, page }) =>
      overBudget() ? null : processPage(db, jev, link, await page, dryRun, dryRun ? titleNamesOf.get(link.id) : undefined)),
  );

  const results = [...titles, ...pageResults].filter(isPresent);
  const mentions = results.flatMap((r) => r.mentions);
  return {
    links: results.length,
    mentions: mentions.length,
    new_entities: mentions.filter((m) => m.decision === "new").length,
    dropped: results.reduce((n, r) => n + r.dropped.length, 0),
    input_tokens: results.reduce((s, r) => s + r.inputTokens, 0),
    results,
  };
}));
