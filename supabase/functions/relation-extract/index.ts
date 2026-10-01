import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";

// Proposes typed relations between the entities a link mentions, as claims made
// by that link: for every unordered pair of its entities (a, b), one Choice
// question asks how the link relates them. Directed relations are offered both
// ways round as separate options, so a pair gets one direction, never both;
// "none" covers pairs it only mentions together. One Jev request per link.
//
// Evaluation only for now: POST {"link_ids": [...]} returns the proposed
// relations without writing anything.

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const MAX_LINK_IDS = 50;
const MAX_ENTITIES_PER_LINK = 5;
const MIN_RELATION_P = 0.5;
const CONCURRENCY = 6;
const NONE = "none";
const A_TO_B = "a>b:";
const B_TO_A = "b>a:";

// `{s}` and `{o}` stand for the subject and object; each directed relation
// becomes two options, one per direction.
const DIRECTED_RELATIONS = {
  acquires: "{s} buys, takes over or merges into itself {o}, or agrees or plans to.",
  invests_in: "{s} puts money into {o}: leads or joins a funding round, takes a stake, funds it.",
  customer_of: "{s} pays {o} for products or services, or signs a deal to.",
  part_of: "{s} is owned by, a subsidiary, division, feature or brand of, or a member of {o}.",
  makes: "{s} makes, launches, publishes, organises or operates {o} (a product, service, work or event).",
  leads: "{s} founded, runs or heads {o} (CEO, founder, chair, leader); often written as {o}'s possessive before {s}'s name.",
  works_for: "{s} works for, advises or represents {o}, without leading it.",
  sues: "{s} takes legal action against {o}.",
  regulates: "{s} regulates, investigates, fines, bans, restricts, rules on or sanctions {o}.",
  criticizes: "{s} accuses, criticises or disputes a claim by {o}.",
  located_in: "{s} is based in, happens in or is a part of the place {o}.",
};
const SYMMETRIC_RELATIONS = {
  partners_with: "`a` and `b` collaborate, integrate or sign a partnership, neither just paying the other.",
  competes_with: "`a` and `b` compete with or rival each other.",
};
const RELATION_OPTIONS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(DIRECTED_RELATIONS).flatMap(([name, text]) => [
    [A_TO_B + name, text.replaceAll("{s}", "`a`").replaceAll("{o}", "`b`")],
    [B_TO_A + name, text.replaceAll("{s}", "`b`").replaceAll("{o}", "`a`")],
  ])),
  ...SYMMETRIC_RELATIONS,
  [NONE]: "The link states no relation of these kinds between `a` and `b`, or only mentions them together.",
};

type Relation = keyof typeof DIRECTED_RELATIONS | keyof typeof SYMMETRIC_RELATIONS;

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
  subject: string;
  relation: Relation;
  object: string;
  p: number;
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

async function processLink(jev: JevClient, link: Link, entities: EntityMention[]) {
  const pairs = entities.flatMap((a, i) => entities.slice(i + 1).map((b) => [a, b] as const));
  if (!pairs.length) return { link_id: link.id, title: link.title, entities: entities.map(label), claims: [], inputTokens: 0 };

  const state = {
    link: { title: link.title, site: hostOf(link.url), ...(link.description ? { description: link.description } : {}) },
  };
  const questions: Record<string, ChoiceQuestion> = Object.fromEntries(pairs.map(([a, b], i) => [
    `r${i}`,
    {
      type: "choice",
      instructions: {
        a: label(a),
        b: label(b),
        question: "According to `link`, how are `a` and `b` related? Only what the link itself states or clearly implies.",
      },
      criteria: RELATION_OPTIONS,
    },
  ]));
  const result = await jev.ask(state, questions);
  const claims: Claim[] = pairs.flatMap(([a, b], i) => {
    const answer = result.answers[`r${i}`];
    const p = Math.round(answer.probabilities[answer.choice] * 1000) / 1000;
    if (answer.choice === NONE || p < MIN_RELATION_P) return [];
    const [subject, object] = answer.choice.startsWith(B_TO_A) ? [b, a] : [a, b];
    const relation = answer.choice.replace(A_TO_B, "").replace(B_TO_A, "") as Relation;
    return [{ subject: subject.name, relation, object: object.name, p }];
  });
  return { link_id: link.id, title: link.title, entities: entities.map(label), claims, inputTokens: result.usage.input_tokens };
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

  const { data: links, error } = await db.from("links").select("id, title, url, description").in("id", ids);
  if (error) throw new Error(error.message);
  const mentions = await mentionsByLink(db, ids);

  const results = [];
  const errors: unknown[] = [];
  const queue = [...(links as Link[])];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let link = queue.shift(); link; link = queue.shift()) {
      try {
        results.push(await processLink(jev, link, mentions.get(link.id) ?? []));
      } catch (e) {
        errors.push({ link_id: link.id, error: String(e) });
      }
    }
  }));
  const claims = results.flatMap((r) => r.claims);
  return new Response(
    JSON.stringify({
      model: MODEL,
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
