import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";

// Proposes typed relations between the entities a link mentions, as claims made
// by that link: for every unordered pair of its entities (a, b), one Choice
// question asks how the link relates them. Directed relations are offered both
// ways round as separate options, so a pair gets one direction, never both;
// "none" covers pairs it only mentions together. A second request asks, for
// the pairs that got a relation, whether the link reports it as done, planned,
// called off or disputed. Claims land in `entity_relations` (labeled_by 'jev'),
// and each processed link gets `link_enrichment.relations_at`.
//
// POST {} processes up to LINKS_PER_RUN unprocessed links, newest first;
// POST {"link_ids": [...]} those links. "dry_run": true reports without writing.

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const LINKS_PER_RUN = 40;
const MAX_LINK_IDS = 50;
const MAX_ENTITIES_PER_LINK = 5;
const MIN_RELATION_P = 0.5;
const MAX_DESCRIPTION_CHARS = 300;
const CONCURRENCY = 6;
const NONE = "none";
const A_TO_B = "a>b:";
const B_TO_A = "b>a:";

// `{s}` and `{o}` stand for the subject and object; each directed relation
// becomes two options, one per direction.
const DIRECTED_RELATIONS = {
  acquires: "{s} buys or takes over {o}, or plans to; {o} is what is bought, not its founder.",
  invests_in: "{s} funds or takes a stake in {o}.",
  customer_of: "{s} pays {o} for products or services.",
  part_of: "{s} is owned by, or a unit, feature, brand or member of, {o}.",
  makes: "{s} makes, launches, publishes, organises or runs {o}; not what {o} is about.",
  leads: "{s} founded, runs or heads {o} (\"{o}'s {s}\" often means this).",
  works_for: "{s} works for, advises or represents {o}.",
  sues: "{s} takes legal action against {o}.",
  regulates: "{s} regulates, investigates, fines, bans, restricts or rules on {o}.",
  criticizes: "{s} accuses, criticises or disputes {o}.",
  located_in: "{s} itself, not an event it runs, is based or happens in the place {o}.",
};
const SYMMETRIC_RELATIONS = {
  partners_with: "`a` and `b` collaborate or partner.",
  competes_with: "`a` and `b` compete or rival each other.",
};
const NONE_OPTION = "No such relation is stated; they are only mentioned together.";

// Which entity kinds each relation's subject and object may have; a pair is
// only offered the relations its kinds allow. Only person and place are
// reliable enough to rule on (an organisation can be filed as "other" or
// "event"), so the rules only say where people and places can't stand.
const NOT_PERSON_OR_PLACE = (kind: string) => kind !== "person" && kind !== "place";
const ANY = () => true;
const KIND_RULES: Record<Relation, [(s: string) => boolean, (o: string) => boolean]> = {
  acquires: [NOT_PERSON_OR_PLACE, NOT_PERSON_OR_PLACE],
  invests_in: [(s) => s !== "place", NOT_PERSON_OR_PLACE],
  customer_of: [ANY, NOT_PERSON_OR_PLACE],
  part_of: [(s) => s !== "person", (o) => o !== "person"],
  makes: [(s) => s !== "place", NOT_PERSON_OR_PLACE],
  leads: [(s) => s === "person", NOT_PERSON_OR_PLACE],
  works_for: [(s) => s === "person", (o) => o !== "place"],
  sues: [ANY, ANY],
  regulates: [(s) => s !== "person", ANY],
  criticizes: [ANY, ANY],
  located_in: [ANY, (o) => o === "place"],
  partners_with: [NOT_PERSON_OR_PLACE, NOT_PERSON_OR_PLACE],
  competes_with: [(s) => s !== "place", (o) => o !== "place"],
};
const allowed = (r: Relation, s: EntityMention, o: EntityMention) => KIND_RULES[r][0](s.kind) && KIND_RULES[r][1](o.kind);

function relationOptions(a: EntityMention, b: EntityMention): Record<string, string> {
  const options: Record<string, string> = {};
  for (const [name, text] of Object.entries(DIRECTED_RELATIONS) as [Relation, string][]) {
    if (allowed(name, a, b)) options[A_TO_B + name] = text.replaceAll("{s}", "`a`").replaceAll("{o}", "`b`");
    if (allowed(name, b, a)) options[B_TO_A + name] = text.replaceAll("{s}", "`b`").replaceAll("{o}", "`a`");
  }
  for (const [name, text] of Object.entries(SYMMETRIC_RELATIONS) as [Relation, string][]) {
    if (allowed(name, a, b) && allowed(name, b, a)) options[name] = text;
  }
  return { ...options, [NONE]: NONE_OPTION };
}

const STATUS_OPTIONS = {
  stated: "Done, true or ongoing.",
  planned: "Announced, agreed, planned or in talks; not done yet.",
  called_off: "Abandoned, cancelled, ended or blocked.",
  disputed: "Alleged, denied or disputed.",
};

type Relation = keyof typeof DIRECTED_RELATIONS | keyof typeof SYMMETRIC_RELATIONS;
type Status = keyof typeof STATUS_OPTIONS;

interface Link {
  id: string;
  title: string;
  url: string;
  description: string | null;
}

interface EntityMention {
  id: string;
  name: string;
  kind: string;
  surface: string | null;
}

interface Claim {
  subject: EntityMention;
  relation: Relation;
  object: EntityMention;
  p: number;
  status: Status;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const label = (e: EntityMention) => `${e.surface ?? e.name} (${e.kind})`;

async function mentionsByLink(db: SupabaseClient, ids: string[]): Promise<Map<string, EntityMention[]>> {
  const { data, error } = await db
    .from("link_entities")
    .select("link_id, surface, p, entities(id, name, kind)")
    .in("link_id", ids)
    .order("p", { ascending: false });
  if (error) throw new Error(error.message);
  const byLink = new Map<string, EntityMention[]>();
  for (const row of data as unknown as { link_id: string; surface: string | null; entities: { id: string; name: string; kind: string } }[]) {
    const list = byLink.get(row.link_id) ?? [];
    if (list.length < MAX_ENTITIES_PER_LINK && !list.some((e) => e.id === row.entities.id)) {
      list.push({ ...row.entities, surface: row.surface });
    }
    byLink.set(row.link_id, list);
  }
  return byLink;
}

const SYMMETRIC = Object.keys(SYMMETRIC_RELATIONS);

async function processLink(db: SupabaseClient, jev: JevClient, link: Link, entities: EntityMention[], dryRun: boolean) {
  const pairs = entities.flatMap((a, i) => entities.slice(i + 1).map((b) => [a, b] as const));
  const state = {
    link: { title: link.title, site: hostOf(link.url), ...(link.description ? { description: link.description.slice(0, MAX_DESCRIPTION_CHARS) } : {}) },
  };
  let inputTokens = 0;
  let claims: Claim[] = [];

  if (pairs.length) {
    const result = await jev.ask(state, Object.fromEntries(pairs.map(([a, b], i) => [
      `r${i}`,
      {
        type: "choice",
        instructions: {
          a: label(a),
          b: label(b),
          question: "How does `link` relate `a` and `b`? Only what it states or clearly implies.",
        },
        criteria: relationOptions(a, b),
      } satisfies ChoiceQuestion,
    ])));
    inputTokens += result.usage.input_tokens;
    claims = pairs.flatMap(([a, b], i) => {
      const answer = result.answers[`r${i}`];
      const p = Math.round(answer.probabilities[answer.choice] * 1000) / 1000;
      if (answer.choice === NONE || p < MIN_RELATION_P) return [];
      const relation = answer.choice.replace(A_TO_B, "").replace(B_TO_A, "") as Relation;
      let [subject, object] = answer.choice.startsWith(B_TO_A) ? [b, a] : [a, b];
      if (SYMMETRIC.includes(relation) && object.id < subject.id) [subject, object] = [object, subject];
      return [{ subject, relation, object, p, status: "stated" as Status }];
    });
  }

  if (claims.length) {
    const result = await jev.ask(state, Object.fromEntries(claims.map((c, i) => [
      `s${i}`,
      {
        type: "choice",
        instructions: {
          claim: `${label(c.subject)} ${c.relation.replace("_", " ")} ${label(c.object)}`,
          question: "How does `link` report `claim`?",
        },
        criteria: STATUS_OPTIONS,
      } satisfies ChoiceQuestion,
    ])));
    inputTokens += result.usage.input_tokens;
    claims.forEach((c, i) => (c.status = result.answers[`s${i}`].choice as Status));
  }

  if (!dryRun) {
    if (claims.length) {
      const { error } = await db.from("entity_relations").upsert(
        claims.map((c) => ({
          subject_id: c.subject.id, relation: c.relation, object_id: c.object.id,
          link_id: link.id, status: c.status, p: c.p, labeled_by: "jev",
        })),
        { onConflict: "link_id,subject_id,relation,object_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
    }
    const { error } = await db.from("link_enrichment").upsert({ link_id: link.id, relations_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }
  return {
    link_id: link.id,
    title: link.title,
    entities: entities.map(label),
    claims: claims.map((c) => ({ subject: c.subject.name, relation: c.relation, object: c.object.name, p: c.p, status: c.status })),
    inputTokens,
  };
}

async function unprocessedLinkIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.rpc("links_to_enrich", { step: "relations", max_results: LINKS_PER_RUN });
  if (error) throw new Error(error.message);
  return (data as { link_id: string }[]).map((r) => r.link_id);
}

Deno.serve(async (req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const given: unknown = body?.link_ids;
  if (given !== undefined && (!Array.isArray(given) || given.length > MAX_LINK_IDS || !given.every((i) => typeof i === "string"))) {
    return new Response(JSON.stringify({ error: `link_ids must be at most ${MAX_LINK_IDS} ids` }), { status: 400 });
  }
  const { data: apiKey, error: keyError } = await db.rpc("get_vault_secret", { secret_name: TYPESAFE_KEY_SECRET });
  if (keyError || !apiKey) {
    return new Response(JSON.stringify({ error: `no ${TYPESAFE_KEY_SECRET} in Vault` }), { status: 500 });
  }
  const jev = new JevClient(apiKey, MODEL);

  const ids = (given as string[] | undefined) ?? await unprocessedLinkIds(db);
  const { data: links, error } = await db.from("links").select("id, title, url, description").in("id", ids);
  if (error) throw new Error(error.message);
  const mentions = await mentionsByLink(db, ids);

  const results: Awaited<ReturnType<typeof processLink>>[] = [];
  const errors: unknown[] = [];
  const queue = [...(links as Link[])];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let link = queue.shift(); link; link = queue.shift()) {
      try {
        results.push(await processLink(db, jev, link, mentions.get(link.id) ?? [], dryRun));
      } catch (e) {
        errors.push({ link_id: link.id, error: String(e) });
      }
    }
  }));
  const claims = results.flatMap((r) => r.claims);
  return new Response(
    JSON.stringify({
      model: MODEL,
      dry_run: dryRun,
      links: results.length,
      claims: claims.length,
      by_relation: claims.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.relation]: (acc[c.relation] ?? 0) + 1 }), {}),
      input_tokens: results.reduce((s, r) => s + r.inputTokens, 0),
      errors,
      results,
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
