import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
import { isPresent, type Report, reporting } from "../_shared/helpers.ts";
import { serveJev } from "../_shared/jev_function.ts";
import { pool } from "../_shared/pool.ts";

// Labels links with leaf topics by walking the topic tree with Jev: at each
// node one Choice over its children, keeping the BEAM_WIDTH best paths by
// geometric-mean edge probability (so a shallow leaf and a deep one compare
// fairly), and labelling the distinct leaves of the final beam that score at
// least MIN_LABEL_SCORE, with p = that score. Only links with no labels at all
// are picked up, so hand labels are never touched or doubled, and each processed
// link gets `link_enrichment.topics_at`, so one that no path fitted isn't retried.
//
// POST {} labels up to LINKS_PER_RUN unlabelled links, newest first.
// POST {"link_ids": [...], "dry_run": true} returns labels without writing
// (used to evaluate against the hand labels).

const MODEL = "jev-1.13.0";
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
    const result = asked.length ? await jev.ask(state, questions, link.id) : null;
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

async function linksById(db: SupabaseClient, ids: string[]): Promise<Link[]> {
  const { data, error } = await db.from("links").select("id, title, url, description").in("id", ids);
  if (error) throw new Error(error.message);
  return data;
}

// Writes the labels and marks every labelled link done; the labels written.
async function saveLabels(db: SupabaseClient, results: Awaited<ReturnType<typeof labelLink>>[], report: Report): Promise<number> {
  const rows = results.flatMap((r) => r.labels.map((l) => ({ link_id: r.link_id, ...l, labeled_by: "jev" })));
  const { error } = rows.length
    ? await db.from("link_topics").upsert(rows, { onConflict: "link_id,topic_id", ignoreDuplicates: true })
    : { error: null };
  if (error) report({ write: error.message });
  if (results.length) {
    const at = new Date().toISOString();
    const { error: markError } = await db.from("link_enrichment").upsert(results.map((r) => ({ link_id: r.link_id, topics_at: at })));
    if (markError) report({ enrichment: markError.message });
  }
  return error ? 0 : rows.length;
}

async function unlabelledLinks(db: SupabaseClient): Promise<Link[]> {
  const { data: rows, error } = await db.rpc("links_to_enrich", { step: "topics", max_results: LINKS_PER_RUN });
  if (error) throw new Error(error.message);
  const ids = (rows as { link_id: string }[]).map((r) => r.link_id);
  if (!ids.length) return [];
  const { data, error: linksError } = await db.from("links").select("id, title, url, description").in("id", ids);
  if (linksError) throw new Error(linksError.message);
  return data;
}

Deno.serve(serveJev({ fn: "topic-label", model: MODEL, maxLinkIds: MAX_LINK_IDS }, async ({ db, jev, ids, dryRun, report }) => {
  const children = await loadTopics(db);
  const names = new Map([...children.values()].flat().map((t) => [t.id, t.name]));
  const links = ids ? await linksById(db, ids) : await unlabelledLinks(db);
  const label = reporting(report, (link: Link) => ({ link_id: link.id }), (link) => labelLink(jev, link, children, names));
  const results = (await pool(links, CONCURRENCY, label)).filter(isPresent);

  const written = dryRun ? 0 : await saveLabels(db, results, report);
  return {
    links: results.length,
    labels_written: written,
    input_tokens: results.reduce((s, r) => s + r.inputTokens, 0),
    requests: results.reduce((s, r) => s + r.requests, 0),
    results,
  };
}));
