import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
import { isPresent, type Report, reporting, sumBy } from "../_shared/helpers.ts";
import { linksToEnrich, markEnriched } from "../_shared/enrich.ts";
import { serveJev } from "../_shared/jev_function.ts";
import { pool } from "../_shared/pool.ts";
import { JEV, RELATION_EXTRACT } from "../_shared/constants.ts";

// Proposes typed relations between the entities a link mentions, as claims made
// by that link: for every unordered pair of its entities (a, b), one Choice
// question asks how the link relates them. Directed relations are offered both
// ways round as separate options, so a pair gets one direction, never both;
// "none" covers pairs it only mentions together. A second request asks, for
// the pairs that got a relation, whether the link reports it as done, planned,
// called off, disputed or ended. Claims land in `entity_relations` (labeled_by
// 'jev'), and each processed link gets `link_enrichment.relations_at`.
//
// POST {} processes up to LINKS_PER_RUN unprocessed links, newest first;
// POST {"link_ids": [...]} those links. "dry_run": true reports without writing.

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

const STATUS_OPTIONS = {
  stated: "Done, true or ongoing.",
  planned: "Announced, agreed, planned or in talks; not done yet.",
  called_off: "Abandoned, cancelled or blocked before it happened.",
  disputed: "Alleged, denied or disputed.",
  ended: "Was so but is over (former, ex-, left, stepped down).",
};

type Relation = keyof typeof DIRECTED_RELATIONS | keyof typeof SYMMETRIC_RELATIONS;
type Status = keyof typeof STATUS_OPTIONS;
type KindTest = (kind: string) => boolean;

// Which entity kinds each relation's subject and object may have; a pair is
// only offered the relations its kinds allow. Only person and place are
// reliable enough to rule on (an organisation can be filed as "other" or
// "event"), so the rules only say where people and places can't stand.
const notPersonOrPlace: KindTest = (kind) => kind !== "person" && kind !== "place";
const any: KindTest = () => true;
const KIND_RULES: Record<Relation, [KindTest, KindTest]> = {
  acquires: [notPersonOrPlace, notPersonOrPlace],
  invests_in: [(s) => s !== "place", notPersonOrPlace],
  customer_of: [any, notPersonOrPlace],
  part_of: [(s) => s !== "person", (o) => o !== "person"],
  makes: [(s) => s !== "place", notPersonOrPlace],
  leads: [(s) => s === "person", notPersonOrPlace],
  works_for: [(s) => s === "person", (o) => o !== "place"],
  sues: [any, any],
  regulates: [(s) => s !== "person", any],
  criticizes: [any, any],
  located_in: [any, (o) => o === "place"],
  partners_with: [notPersonOrPlace, notPersonOrPlace],
  competes_with: [(s) => s !== "place", (o) => o !== "place"],
};
const symmetric = new Set<string>(Object.keys(SYMMETRIC_RELATIONS));

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

const allowed = (r: Relation, s: EntityMention, o: EntityMention) => KIND_RULES[r][0](s.kind) && KIND_RULES[r][1](o.kind);

function relationOptions(a: EntityMention, b: EntityMention): Record<string, string> {
  const directed = (Object.entries(DIRECTED_RELATIONS) as [Relation, string][]).flatMap(([name, text]) => [
    ...(allowed(name, a, b) ? [[A_TO_B + name, text.replaceAll("{s}", "`a`").replaceAll("{o}", "`b`")]] : []),
    ...(allowed(name, b, a) ? [[B_TO_A + name, text.replaceAll("{s}", "`b`").replaceAll("{o}", "`a`")]] : []),
  ]);
  const both = (Object.entries(SYMMETRIC_RELATIONS) as [Relation, string][])
    .filter(([name]) => allowed(name, a, b) && allowed(name, b, a));
  return { ...Object.fromEntries([...directed, ...both]), [NONE]: NONE_OPTION };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const label = (e: EntityMention) => `${e.surface ?? e.name} (${e.kind})`;

async function linksById(db: SupabaseClient, ids: string[]): Promise<Link[]> {
  const { data, error } = await db.from("links").select("id, title, url, description").in("id", ids);
  if (error) throw new Error(error.message);
  return data;
}

// Each link's first MAX_ENTITIES_PER_LINK distinct entities, most certain first.
async function mentionsByLink(db: SupabaseClient, ids: string[]): Promise<Map<string, EntityMention[]>> {
  const { data, error } = await db
    .from("link_entities")
    .select("link_id, surface, p, entities(id, name, kind)")
    .in("link_id", ids)
    .order("p", { ascending: false });
  if (error) throw new Error(error.message);
  const byLink = new Map<string, EntityMention[]>();
  for (const row of data as unknown as { link_id: string; surface: string | null; entities: Omit<EntityMention, "surface"> }[]) {
    const list = byLink.get(row.link_id) ?? [];
    if (list.length < RELATION_EXTRACT.MAX_ENTITIES_PER_LINK && !list.some((e) => e.id === row.entities.id)) {
      list.push({ ...row.entities, surface: row.surface });
    }
    byLink.set(row.link_id, list);
  }
  return byLink;
}

async function claimsOf(jev: JevClient, link: Link, entities: EntityMention[]) {
  const pairs = entities.flatMap((a, i) => entities.slice(i + 1).map((b) => [a, b] as const));
  const state = {
    link: {
      title: link.title,
      site: hostOf(link.url),
      ...(link.description ? { description: link.description.slice(0, RELATION_EXTRACT.MAX_DESCRIPTION_CHARS) } : {}),
    },
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
    ])), link.id);
    inputTokens += result.usage.input_tokens;
    claims = pairs.flatMap(([a, b], i) => {
      const answer = result.answers[`r${i}`];
      const p = Math.round(answer.probabilities[answer.choice] * 1000) / 1000;
      if (answer.choice === NONE || p < RELATION_EXTRACT.MIN_RELATION_P) return [];
      const relation = answer.choice.replace(A_TO_B, "").replace(B_TO_A, "") as Relation;
      const [first, second] = answer.choice.startsWith(B_TO_A) ? [b, a] : [a, b];
      const [subject, object] = symmetric.has(relation) && second.id < first.id ? [second, first] : [first, second];
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
    ])), link.id);
    inputTokens += result.usage.input_tokens;
    claims = claims.map((c, i) => ({ ...c, status: result.answers[`s${i}`].choice as Status }));
  }
  return { link_id: link.id, title: link.title, entities: entities.map(label), claims, inputTokens };
}

// Writes the claims and marks every asked link done; the claims written.
async function saveClaims(db: SupabaseClient, results: Awaited<ReturnType<typeof claimsOf>>[], report: Report): Promise<number> {
  const rows = results.flatMap((r) =>
    r.claims.map((c) => ({
      subject_id: c.subject.id, relation: c.relation, object_id: c.object.id,
      link_id: r.link_id, status: c.status, p: c.p, labeled_by: "jev",
    }))
  );
  const { error } = rows.length
    ? await db.from("entity_relations").upsert(rows, { onConflict: "link_id,subject_id,relation,object_id", ignoreDuplicates: true })
    : { error: null };
  if (error) report({ write: error.message });
  const { error: markError } = await markEnriched(db, "relations", error ? [] : results.map((r) => r.link_id));
  if (markError) report({ enrichment: markError.message });
  return error ? 0 : rows.length;
}

Deno.serve(serveJev({ fn: "relation-extract", model: JEV.MODEL, maxLinkIds: RELATION_EXTRACT.MAX_LINK_IDS }, async ({ db, jev, ids, dryRun, report }) => {
  const links = ids
    ? await linksById(db, ids)
    : await linksToEnrich<Link>(db, "relations", RELATION_EXTRACT.LINKS_PER_RUN, "id, title, url, description");
  const mentions = await mentionsByLink(db, links.map((l) => l.id));
  const ask = reporting(report, (link: Link) => ({ link_id: link.id }), (link) => claimsOf(jev, link, mentions.get(link.id) ?? []));
  const results = (await pool(links, RELATION_EXTRACT.CONCURRENCY, ask)).filter(isPresent);

  const written = dryRun ? 0 : await saveClaims(db, results, report);
  const claims = results.flatMap((r) => r.claims);
  return {
    links: results.length,
    claims: claims.length,
    claims_written: written,
    by_relation: Object.fromEntries(Object.entries(Object.groupBy(claims, (c) => c.relation)).map(([r, cs]) => [r, cs!.length])),
    input_tokens: sumBy(results, "inputTokens"),
    results: results.map((r) => ({
      ...r,
      claims: r.claims.map((c) => ({ subject: c.subject.name, relation: c.relation, object: c.object.name, p: c.p, status: c.status })),
    })),
  };
}));
