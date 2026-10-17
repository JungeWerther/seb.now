import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ChoiceQuestion, JevClient } from "../_shared/jev.ts";
import { memoize, once } from "../_shared/memo.ts";
import { ENV, JEV, QUERY_PARSE } from "../_shared/constants.ts";
import { jsonResponses } from "../_shared/helpers.ts";

// Reads what the search box is asking for, as the reader types: the page
// proposes the topics whose names match the text (it holds the whole topic
// list and matches on every keystroke), and one Jev request chooses the sort
// order, which of those topics (if any) is meant, and each word's role, so
// the words that are neither become a plain title search. Code proposes, Jev
// only chooses: the sort orders are feed_query's, and topics are looked up by
// id, so nothing the page sends becomes an option's text.
//
// Each Jev read takes one of the caller's query credits (spend_query_credit,
// as the caller, so it needs a signed-in session, anonymous ones included),
// given back if Jev fails. Answers are kept in `query_readings`, shared by
// every reader, so a query anyone has had read is free after that (this
// isolate keeps a copy in memory too). Every reply carries `credits_left`,
// and 429 means none are left.
//
// POST {"text": "latest on ai agents", "topic_ids": ["ai.agents", ...]}
// → {"sort": "latest", "topic": {"id": "ai.agents", "name": "AI agents"}, "search": "", ...}

const TOPIC_ID_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;
const NONE = "none";
const DEFAULT_SORT = "for_you";

const SORTS = {
  for_you: "No particular order asked for: the reader's usual ranking, by their own taste.",
  latest: "Newest first: latest, recent, new, today, fresh, just in, what's happening now.",
  top: "Most upvoted first: top, best, popular, most liked, highest rated.",
  discussed: "Most replies first: most discussed, debated, controversial, talked about, comments.",
};
type Sort = keyof typeof SORTS;

const ROLES = {
  sort: "Asks how to order the feed (like latest, newest, top, best, popular, discussed).",
  topic: "Part of the name of the subject area chosen in `topic`.",
  search: "A specific name or word to look for in article titles (a company, person, product, place, or a subject not covered by the topic).",
  filler: "Connecting or request words with no meaning of their own here (show, me, news, about, on, the, articles, posts).",
};
type Role = keyof typeof ROLES;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Topic {
  id: string;
  name: string;
  description: string;
}

type Reading = Awaited<ReturnType<typeof parse>>;


const json = jsonResponses({ headers: CORS });

const admin: SupabaseClient = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);

const client = once(async (): Promise<JevClient> => {
  const { data: apiKey, error } = await admin.rpc("get_vault_secret", { secret_name: JEV.TYPESAFE_KEY_SECRET });
  if (error || !apiKey) throw new Error(`no ${JEV.TYPESAFE_KEY_SECRET} in Vault`);
  return new JevClient(apiKey, JEV.MODEL, { db: admin, fn: "query-parse" });
});

// A reading anyone has had, from this isolate's memory, else query_readings.
const storedReading = memoize((key: string) => key, async (key: string): Promise<Reading | null> => {
  const { data, error } = await admin.from("query_readings").select("reading").eq("key", key).maybeSingle();
  if (error) console.error("query_readings read failed", error);
  return (data?.reading as Reading | undefined) ?? null;
}, { maxEntries: QUERY_PARSE.CACHE_SIZE });

// The caller's user id, from the bearer token the gateway has already verified.
function callerId(req: Request): string | null {
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).sub ?? null;
  } catch {
    return null;
  }
}

async function refundCredit(req: Request) {
  const id = callerId(req);
  if (!id) return;
  const { data } = await admin.from("query_credits").select("used").eq("user_id", id).maybeSingle();
  if (data?.used) await admin.from("query_credits").update({ used: data.used - 1 }).eq("user_id", id);
}

function asCaller(req: Request) {
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
}

async function loadTopics(ids: string[]): Promise<Topic[]> {
  if (!ids.length) return [];
  const db = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY);
  const { data, error } = await db.from("topics").select("id, name, description").in("id", ids);
  if (error) throw new Error(error.message);
  const order = new Map(ids.map((id, i) => [id, i]));
  return (data as Topic[]).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

async function parse(text: string, topics: Topic[]) {
  const words = text.split(/\s+/).filter(Boolean).slice(0, QUERY_PARSE.MAX_WORDS);
  const questions: Record<string, ChoiceQuestion> = {
    sort: {
      type: "choice",
      instructions: "The reader typed `query` into a news feed's search box. Which order are they asking the feed to be in?",
      criteria: SORTS,
    },
  };
  if (topics.length) {
    const criteria: Record<string, string> = Object.fromEntries(
      topics.map((t) => [t.id, `${t.name}: ${t.description}`]),
    );
    criteria[NONE] = "None of these: `query` doesn't ask for any of these subject areas.";
    questions.topic = {
      type: "choice",
      instructions: "Which of these subject areas, if any, is `query` asking for articles about?",
      criteria,
    };
  }
  words.forEach((word, i) => {
    questions[`w${i}`] = {
      type: "choice",
      instructions: {
        word,
        position: i + 1,
        question: "What does the word in `word` (at `position` in `query`) do in the reader's query?",
      },
      criteria: topics.length ? ROLES : Object.fromEntries(Object.entries(ROLES).filter(([k]) => k !== "topic")),
    };
  });
  const state = {
    query: text,
    ...(topics.length ? { topic: "the subject area chosen from the options of the `topic` question" } : {}),
  };
  const result = await (await client()).ask(state, questions);
  const answers = result.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;

  const sortAnswer = answers.sort;
  const sort = (sortAnswer.probabilities[sortAnswer.choice] >= QUERY_PARSE.MIN_SORT_P ? sortAnswer.choice : DEFAULT_SORT) as Sort;
  const topicAnswer = answers.topic;
  const topic = topicAnswer && topicAnswer.choice !== NONE && topicAnswer.probabilities[topicAnswer.choice] >= QUERY_PARSE.MIN_TOPIC_P
    ? topics.find((t) => t.id === topicAnswer.choice) ?? null
    : null;
  const roles = words.map((word, i) => {
    const answer = answers[`w${i}`];
    let role = answer.choice as Role;
    // A word naming a topic that wasn't chosen is still worth searching for.
    if (role === "topic" && !topic) role = "search";
    if (role === "sort" && sort === DEFAULT_SORT) role = "filler";
    return { word, role, p: Math.round(answer.probabilities[answer.choice] * 1000) / 1000 };
  });
  const search = roles.filter((r) => r.role === "search").map((r) => r.word).join(" ");
  return {
    sort,
    sort_p: Math.round(sortAnswer.probabilities[sort] * 1000) / 1000,
    topic: topic && { id: topic.id, name: topic.name },
    topic_p: topic ? Math.round(topicAnswer.probabilities[topic.id] * 1000) / 1000 : null,
    search,
    words: roles,
    input_tokens: result.usage.input_tokens,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim().replace(/\s+/g, " ") : "";
  const ids: unknown = body?.topic_ids ?? [];
  if (!text || text.length > QUERY_PARSE.MAX_TEXT_LENGTH) {
    return json({ error: `text must be 1-${QUERY_PARSE.MAX_TEXT_LENGTH} characters` }, 400);
  }
  if (
    !Array.isArray(ids) || ids.length > QUERY_PARSE.MAX_TOPIC_CANDIDATES ||
    !ids.every((id) => typeof id === "string" && TOPIC_ID_PATTERN.test(id))
  ) {
    return json({ error: `topic_ids must be at most ${QUERY_PARSE.MAX_TOPIC_CANDIDATES} topic ids` }, 400);
  }
  const caller = asCaller(req);
  const key = JSON.stringify([text.toLowerCase(), ids]);
  const cached = await storedReading(key);
  if (cached) {
    const { data: left, error } = await caller.rpc("query_credits_left");
    if (error) return json({ error: "sign in to search" }, 401);
    return json({ ...cached, credits_left: left });
  }
  const { data: left, error: spendError } = await caller.rpc("spend_query_credit");
  if (spendError) return json({ error: "sign in to search" }, 401);
  if (left === null) return json({ error: "no query credits left", credits_left: 0 }, 429);
  try {
    const parsed = await parse(text, await loadTopics(ids as string[]));
    storedReading.prime([key], parsed);
    const { error } = await admin.from("query_readings").upsert({ key, reading: parsed }, { ignoreDuplicates: true });
    if (error) console.error("query_readings write failed", error);
    return json({ ...parsed, credits_left: left });
  } catch (e) {
    console.error("query-parse failed", e);
    await refundCredit(req);
    return json({ error: "could not read the query", credits_left: left + 1 }, 502);
  }
});
