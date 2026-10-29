// Every Edge Function metaparameter: model ids, limits, thresholds, timeouts,
// secret names and the external services' addresses, grouped by the function
// that uses them, plus ENV, the only place the environment is read.
// tests/test_edge_constants.py fails on a top-level UPPER_CASE const or a
// Deno.env.get anywhere else (regexes and the protocol tables it lists aside).

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// The function's environment, read when first used.
export const ENV = {
  get SUPABASE_URL() {
    return required("SUPABASE_URL");
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get SUPABASE_ANON_KEY() {
    return required("SUPABASE_ANON_KEY");
  },
};

// TypeSafe's System One API (Jev), shared by every function that asks it.
export const JEV = Object.freeze({
  ENDPOINT: "https://api.typesafe.ai/v1/systemone",
  RETRYABLE_STATUSES: [429, 529],
  MAX_ATTEMPTS: 4,
  BACKOFF_BASE_MS: 1000,
  MODEL: "jev-1.13.0",
  TYPESAFE_KEY_SECRET: "typesafe-ai-token",
});

// _shared/clients.ts.
export const VAULT = Object.freeze({
  CACHED_SECRETS: 8,
});

// _shared/ingest.ts: what every ingest function shares.
export const INGEST = Object.freeze({
  IMAGE_FETCH_TIMEOUT_MS: 5000,
  USER_AGENT: "seb.now feed reader (+https://seb.now)",
});

// hn-ingest.
export const HN = Object.freeze({
  STORIES_LIMIT: 25,
  API: "https://hacker-news.firebaseio.com/v0",
});

// youtube-ingest.
export const YOUTUBE = Object.freeze({
  FEED_URL: "https://www.youtube.com/feeds/videos.xml?channel_id=",
  WATCH_URL: "https://www.youtube.com/watch?v=",
  // 4:3 with letterbox bars on 16:9 videos; the page's 16:9 cover crop removes
  // them exactly. Unlike maxresdefault, it exists for every video.
  THUMBNAIL_URL: (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  // oEmbed answers data-centre requests (unlike the watch page's og tags) and
  // names the uploading channel, which becomes links.author.
  OEMBED_URL: "https://www.youtube.com/oembed?format=json&url=",
  OEMBED_TIMEOUT_MS: 5000,
  // YouTube links from any ingest (e.g. Hacker News) still without an author,
  // looked up per run.
  AUTHOR_SWEEP_LIMIT: 50,
});

// web-feed-ingest.
export const WEB_FEED = Object.freeze({
  ITEMS_PER_FEED: 10,
  FEED_FETCH_TIMEOUT_MS: 10000,
  DESCRIPTION_MAX_CHARS: 500,
  DESCRIPTION_MIN_CHARS: 20,
});

// ical-ingest.
export const ICAL = Object.freeze({
  // link_events dates are wall-clock dates here
  EVENT_ZONE: "Europe/Paris",
  HORIZON_DAYS: 45,
  EVENTS_PER_FEED: 40,
  FEED_FETCH_TIMEOUT_MS: 15000,
  IMAGE_CONCURRENCY: 6,
  DESCRIPTION_MAX_CHARS: 500,
  DESCRIPTION_MIN_CHARS: 20,
  EVIDENCE_MAX_CHARS: 500,
  VENUE_MAX_CHARS: 300,
  TITLE_MAX_CHARS: 300,
});

// fediverse-ingest.
export const FEDIVERSE = Object.freeze({
  POSTS_PER_ACCOUNT: 10,
  // A post's own text as its title: 140 characters and an ellipsis.
  TITLE_MAX_CHARS: 141,
});

// _shared/page.ts: fetching and reading a link's page.
export const PAGE = Object.freeze({
  FETCH_TIMEOUT_MS: 10000,
  MAX_HTML_CHARS: 2_000_000,
  MAX_TEXT_CHARS: 20000,
  MIN_ARTICLE_CHARS: 500,
  USER_AGENT: "Mozilla/5.0 (compatible; seb.now reader; +https://seb.now)",
  // A paragraph that opens with a bold title ("<p><a><strong>Meet Your
  // Seoul…</strong></a><br>Du 6 au 27 octobre…") is an entry of a listing
  // without headings; a short bold lead-in ("À noter :") is emphasis.
  ENTRY_TITLE_MIN_CHARS: 12,
  ENTRY_TITLE_MAX_CHARS: 200,
  DECLARED_MAX: 15,
  CONTEXT_CHARS: 240,
});

// _shared/names.ts: names proposed from a page.
export const NAMES = Object.freeze({
  MAX_LENGTH: 60,
  PAGE_CANDIDATES: 80,
  KNOWN_CANDIDATES: 25,
  PAGE_MIN_LENGTH: 3,
  CAP_RATE_NAME: 0.5,
  // Below this, a capitalised word at a sentence start is never a name's first
  // word ("After", "Pour"); above, it sometimes is ("New York").
  NAME_START_RATE: 0.1,
  PREFIX_CAP_RATE: 0.25,
  MAX_PARTICLES: 2,
});

// _shared/hints.ts.
export const HINTS = Object.freeze({
  MIN_EVIDENCE: 5,
  MAX_LOOKUP_WORDS: 5000,
});

// topic-label.
export const TOPIC_LABEL = Object.freeze({
  BEAM_WIDTH: 3,
  MAX_LABELS: 3,
  MIN_LABEL_SCORE: 0.5,
  LINKS_PER_RUN: 60,
  MAX_LINK_IDS: 100,
  CONCURRENCY: 6,
  TOPICS_PAGE_SIZE: 1000,
});

// entity-extract.
export const ENTITY_EXTRACT = Object.freeze({
  NAME_MIN_P: 0.8,
  MATCH_MIN_P: 0.5,
  CANDIDATE_ENTITIES: 8,
  LINKS_PER_RUN: 30,
  PAGE_LINKS_PER_RUN: 12,
  FETCH_CONCURRENCY: 4,
  RUN_BUDGET_MS: 100_000,
  MAX_LINK_IDS: 50,
  SAME_PASS_OPTIONS: 4,
  // How sure Jev must be that a longer name runs several things together
  // before its parts are read instead of it.
  SPAN_PARTS_MIN_P: 0.5,
  // An `entity_edits.batch` label (same check as the table's).
  BATCH_PATTERN: /^[a-z0-9][a-z0-9-]{2,63}$/,
});

// entity-extract/candidates.ts: phrases proposed from a title.
export const TITLE_CANDIDATES = Object.freeze({
  MAX_CANDIDATES: 20,
  MIN_LENGTH: 2,
  WINDOW_MIN_RUN_WORDS: 3,
});

// event-extract.
export const EVENT_EXTRACT = Object.freeze({
  LINKS_PER_RUN: 10,
  MAX_LINK_IDS: 50,
  CONCURRENCY: 4,
  MIN_PAGE_P: 0.5,
  MAX_NOT_AN_EVENT_P: 0.5,
  MIN_ROLE_P: 0.5,
  MIN_VENUE_P: 0.5,
  SECTION_VENUE_PHRASES: 6,
  LEAD_CHARS: 600,
  EXCERPT_CHARS: 300,
  DESCRIPTION_CHARS: 500,
  RECENT_MS: 24 * 60 * 60 * 1000,
});

// event-extract/dates.ts.
export const EVENT_DATES = Object.freeze({
  MAX_CANDIDATES: 20,
});

// query-parse.
export const QUERY_PARSE = Object.freeze({
  MAX_TEXT_LENGTH: 120,
  MAX_WORDS: 12,
  MAX_TOPIC_CANDIDATES: 8,
  MIN_SORT_P: 0.5,
  MIN_TOPIC_P: 0.5,
  CACHE_SIZE: 500,
});

// style-types. The lengths mirror the checks in 20261020120000_style_types.sql,
// so a request that the database would refuse is refused here with a clearer
// message first.
export const STYLE_TYPES = Object.freeze({
  KIND_ROOT: "entity.style",
  MAX_LABEL_LENGTH: 40,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_STYLE_NAME_LENGTH: 60,
});

// activitypub.
export const ACTIVITYPUB = Object.freeze({
  OUTBOX_PAGE_SIZE: 20,
  // Must match the replies_body_length check on public.replies.
  REPLY_MAX_LENGTH: 500,
  REPLIES_FEDERATED_PER_HOUR: 5,
  BOOT_RETRY_ATTEMPTS: 4,
  // Reader accounts whose signing keys an isolate keeps imported.
  ACCOUNT_KEYS_CACHED: 500,
  BOOT_RETRY_DELAY_MS: 500,
});

// mcp.
export const MCP = Object.freeze({
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 50,
  MAX_QUERY_LENGTH: 200,
  MAX_PROPOSAL_EXAMPLES: 10,
  MAX_RATIONALE_LENGTH: 500,
  MAX_TOPIC_NAME_LENGTH: 60,
  MAX_TOPIC_DESCRIPTION_LENGTH: 300,
  // The URL clients connect to for the signed-in endpoint, and so the OAuth
  // resource its tokens are for: the seb.now proxy, not this function's own URL.
  USER_RESOURCE: "https://seb.now/mcp/user",
});

// follow-intake: pages the follow browser extension sends, staged in
// public.follow_inbox for /follow (_shared/follow_intake.ts).
export const FOLLOW_INTAKE = Object.freeze({
  // Vault secret holding the extension's bearer token.
  TOKEN_SECRET: "follow-intake-token",
  // Refused before parsing: the signals are a few kilobytes at most.
  MAX_BODY_BYTES: 65_536,
  // Pages staged per RATE_WINDOW before further sends get 429.
  MAX_PER_WINDOW: 120,
  RATE_WINDOW: "1 hour",
  // What one page may carry, after cleaning; extra items are dropped.
  MAX_URL_LENGTH: 2048,
  MAX_TITLE_LENGTH: 300,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_FEEDS: 20,
  MAX_IDENTITY_LINKS: 40,
});

// index-snapshot.
export const INDEX_SNAPSHOT = Object.freeze({
  BUCKET: "index",
  PREFIX: "snapshots",
  KEEP_SNAPSHOTS: 3,
  // Snapshot names never change content, so they can be cached for a year.
  CACHE_SECONDS: "31536000",
  // Pages catch up from the latest snapshot with index_diff, so one of the
  // current gen is only replaced once it is this old and something was added,
  MAX_AGE_MS: 60 * 60 * 1000,
  // or once this many mentions were added past it: index_diff carries none past
  // 2,000 (INDEX_DIFF_MAX_PAIRS), asked from INDEX_DIFF_OVERLAP (500) below.
  MAX_NEW_PAIRS: 1000,
});

// _shared/wikidata.ts: Wikidata's public API and the properties that place an item.
export const WIKIDATA = Object.freeze({
  API: "https://www.wikidata.org/w/api.php",
  // Wikimedia asks API clients to name themselves and a contact.
  USER_AGENT: "seb.now place-resolve (+https://seb.now)",
  FETCH_TIMEOUT_MS: 10000,
  LANGUAGES: ["en", "fr"],
  SEARCH_LIMIT: 7,
  CACHED_ITEMS: 2000,
  LOCATED_IN: "P131",
  COUNTRY: "P17",
  ISO_CODE: "P297",
  COORDINATES: "P625",
  END_TIME: "P582",
  // Wikimedia rate-limits busy clients with 429 (and 503 when overloaded):
  // those are retried with growing waits, other failures aren't.
  RETRYABLE_STATUSES: [429, 503],
  MAX_ATTEMPTS: 4,
  BACKOFF_BASE_MS: 2000,
  // Wikidata API requests in flight at once per isolate, across every place,
  // search language and description read (a request's retries hold its slot):
  // Wikimedia asks clients not to run requests in parallel, and four at once
  // drew 429s.
  MAX_CONCURRENT_REQUESTS: 1,
});

// place-resolve: links place entities to Wikidata and to the place they are in.
export const PLACE_RESOLVE = Object.freeze({
  PLACES_PER_RUN: 20,
  MAX_ENTITY_IDS: 50,
  // Places proposed at once. Their Wikidata requests are limited separately,
  // by WIKIDATA.MAX_CONCURRENT_REQUESTS.
  FETCH_CONCURRENCY: 1,
  // How sure Jev must be of an item before it is taken.
  MATCH_MIN_P: 0.6,
  // Posts shown to Jev as where the place was mentioned.
  CONTEXT_MENTIONS: 2,
  // `entity_edits.batch` for merges it stages, followed by the date.
  MERGE_BATCH_PREFIX: "wikidata",
});
