import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "./jev.ts";

// Labels links with leaf topics by walking the topic tree with Jev: at each
// node one Choice over its children, keeping the BEAM_WIDTH best paths by
// geometric-mean edge probability (so a shallow leaf and a deep one compare
// fairly), and labelling the distinct leaves of the final beam that score at
// least MIN_LABEL_SCORE, with p = that score. Only links with no labels at all
// are picked up, so hand labels are never touched or doubled.
//
// POST {} labels up to LINKS_PER_RUN unlabelled links, newest first.
// POST {"link_ids": [...], "dry_run": true} returns labels without writing
// (used to evaluate against the hand labels).

const MODEL = "jev-1.13.0";
const TYPESAFE_KEY_SECRET = "typesafe-ai-token";
const BEAM_WIDTH = 3;
const MAX_LABELS = 3;
const MIN_LABEL_SCORE = 0.5;
const LINKS_PER_RUN = 60;
const MAX_LINK_IDS = 100;
const CONCURRENCY = 6;
const TOPICS_PAGE_SIZE = 1000;
const NONE = "none";
const ROOT = "";

interface Topic {
  id: string;
  name: string;
  description: string;
}

interface Path {
  node: string; // topic id, or ROOT; NONE when the link fits no top-level topic
  logSum: number;
  decisions: number;
  score: number;
}

interface Link {
  id: string;
  title: string;
  url: string;
  description: string | null;
}

async function loadTopics(db: SupabaseClient): Promise<Map<string, Topic[]>> {
  const children = new Map<string, Topic[]>();
  for (let from = 0; ; from += TOPICS_PAGE_SIZE) {
    const { data, error } = await db
      .from("topics")
      .select("id, name, description")
      .order("id")
      .range(from, from + TOPICS_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    for (const topic of data as Topic[]) {
      const parent = topic.id.includes(".") ? topic.id.slice(0, topic.id.lastIndexOf(".")) : ROOT;
      children.set(parent, [...(children.get(parent) ?? []), topic]);
    }
    if (data.length < TOPICS_PAGE_SIZE) return children;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function breadcrumb(node: string, names: Map<string, string>): string {
  const parts = node.split(".");
  return parts.map((_, i) => names.get(parts.slice(0, i + 1).join(".")) ?? parts[i]).join(" > ");
}

function childQuestion(node: string, options: Topic[], names: Map<string, string>): ChoiceQuestion {
  const criteria: Record<string, string> = Object.fromEntries(
    options.map((t) => [t.id, `${t.name}: ${t.description}`]),
  );
  if (node === ROOT) {
    criteria[NONE] = "None of these: the link is not mainly about any of the areas above.";
    return {
      type: "choice",
      instructions: "Which of these areas is the link in `link` mainly about?",
      criteria,
    };
  }
  return {
    type: "choice",
    instructions: {
      within: breadcrumb(node, names),
      question:
        "The link in `link` has been placed under the topic in `within`. Which of these more specific " +
        "topics under it fits the link best?",
    },
    criteria,
  };
}

function extend(path: Path, node: string, p: number, decided: boolean): Path {
  const logSum = path.logSum + (decided ? Math.log(Math.max(p, Number.EPSILON)) : 0);
  const decisions = path.decisions + (decided ? 1 : 0);
  return { node, logSum, decisions, score: decisions ? Math.exp(logSum / decisions) : 1 };
}

async function labelLink(jev: JevClient, link: Link, children: Map<string, Topic[]>, names: Map<string, string>) {
  const state = {
    link: {
      title: link.title,
      site: hostOf(link.url),
      ...(link.description ? { description: link.description.slice(0, 1000) } : {}),
    },
  };
  let beam: Path[] = [{ node: ROOT, logSum: 0, decisions: 0, score: 1 }];
  let inputTokens = 0;
  let requests = 0;
  for (;;) {
    const open = beam.filter((p) => p.node !== NONE && (children.get(p.node)?.length ?? 0) > 0);
    if (!open.length) break;
    const done = beam.filter((p) => !open.includes(p));
    const asked = open.filter((p) => children.get(p.node)!.length > 1 || p.node === ROOT);
    const questions = Object.fromEntries(
      asked.map((p, i) => [`q${i}`, childQuestion(p.node, children.get(p.node)!, names)]),
    );
    const result = asked.length ? await jev.ask(state, questions) : null;
    if (result) {
      inputTokens += result.usage.input_tokens;
      requests++;
    }
    const next: Path[] = [...done];
    for (const path of open) {
      const index = asked.indexOf(path);
      if (index < 0) {
        next.push(extend(path, children.get(path.node)![0].id, 1, false));
        continue;
      }
      const probabilities = result!.answers[`q${index}`].probabilities as Record<string, number>;
      for (const [option, p] of Object.entries(probabilities)) next.push(extend(path, option, p, true));
    }
    beam = next.sort((a, b) => b.score - a.score).slice(0, BEAM_WIDTH);
  }
  const labels = beam
    .filter((p) => p.node !== NONE && p.node !== ROOT && p.score >= MIN_LABEL_SCORE)
    .slice(0, MAX_LABELS)
    .map((p) => ({ topic_id: p.node, p: Math.round(p.score * 1000) / 1000 }));
  return { link_id: link.id, title: link.title, labels, beam: beam.map(({ node, score }) => ({ node, score })), requests, inputTokens };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function unlabelledLinks(db: SupabaseClient): Promise<Link[]> {
  const { data, error } = await db
    .from("links")
    .select("id, title, url, description, link_topics(link_id)")
    .order("created_at", { ascending: false })
    .limit(LINKS_PER_RUN * 10);
  if (error) throw new Error(error.message);
  return data
    .filter((l: Link & { link_topics: unknown[] }) => !l.link_topics.length)
    .slice(0, LINKS_PER_RUN)
    .map(({ link_topics: _, ...l }: Link & { link_topics: unknown[] }) => l);
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
  const children = await loadTopics(db);
  const names = new Map([...children.values()].flat().map((t) => [t.id, t.name]));

  let links: Link[];
  if (ids) {
    const { data, error } = await db.from("links").select("id, title, url, description").in("id", ids as string[]);
    if (error) throw new Error(error.message);
    links = data;
  } else {
    links = await unlabelledLinks(db);
  }

  const errors: unknown[] = [];
  const results = (await pool(links, CONCURRENCY, async (link) => {
    try {
      return await labelLink(jev, link, children, names);
    } catch (e) {
      errors.push({ link_id: link.id, error: String(e) });
      return null;
    }
  })).filter((r) => r !== null);

  let written = 0;
  if (!dryRun) {
    const rows = results.flatMap((r) => r!.labels.map((l) => ({ link_id: r!.link_id, ...l, labeled_by: "jev" })));
    if (rows.length) {
      const { error } = await db.from("link_topics").upsert(rows, { onConflict: "link_id,topic_id", ignoreDuplicates: true });
      if (error) errors.push({ write: error.message });
      else written = rows.length;
    }
  }

  return new Response(
    JSON.stringify({
      model: MODEL,
      dry_run: dryRun,
      links: results.length,
      labels_written: written,
      input_tokens: results.reduce((s, r) => s + r!.inputTokens, 0),
      requests: results.reduce((s, r) => s + r!.requests, 0),
      errors,
      results,
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
