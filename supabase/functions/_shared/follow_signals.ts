// What the follow browser extension says about a page, cleaned. The extension
// runs in the reader's browser and can be imitated by anyone holding its
// token, so nothing it sends is trusted: every value is read by a cleaner that
// returns a safe value or nothing, and only the page's own URL is required.
//
// The signals are what feed discovery needs and nothing else: the page's feed
// links (<link rel="alternate">), identity links (rel="me", JSON-LD sameAs,
// author pages) and a few names. Never the page's text: a signed-in page can
// hold private mail, and free text read back by an agent is an injection
// vector.
//
// Cleaners compose declaratively: `record({...})` reads an object field by
// field, `list(item, max)` keeps the items that clean (deduplicated, at most
// `max`), and the leaves are `url` and `text(max)`.

import { FOLLOW_INTAKE } from "./constants.ts";
import { stripTags, truncate } from "./text.ts";

// A value cleaned, or undefined when nothing safe is left of it.
export type Cleaner<T> = (value: unknown) => T | undefined;

type Cleaned<S extends Record<string, Cleaner<unknown>>> = { [K in keyof S]?: Exclude<ReturnType<S[K]>, undefined> };

// Control and format characters (C0/C1 controls, zero-width characters, bidi
// overrides and isolates, BOM) and line/paragraph separators: invisible
// characters that make a URL or a name read as something else.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HIDDEN_OR_SPACE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const WHITESPACE = /\s+/g;
const ANGLE_BRACKETS = /[<>]/g;

// Hosts that name the reader's own machine or network: the URL is fetched
// later (by pg_net or an Edge Function), so these would be requests into our
// own infrastructure.
const IPV4_HOST = /^[0-9.]+$/;
const LOCAL_HOST =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|onion|test|invalid|example)$/i;
const HAS_TLD = /\.[a-z][a-z0-9-]*$/i;

// An https URL to a public host, as a string. http is upgraded (feeds still
// advertise http URLs that redirect). Refused: other schemes, credentials in
// the URL, an explicit port, IP literals, local or single-label hosts, hidden
// characters, and anything longer than MAX_URL_LENGTH. The fragment is
// dropped, since it never reaches a server.
export const url: Cleaner<string> = (value) => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.length > FOLLOW_INTAKE.MAX_URL_LENGTH || HIDDEN_OR_SPACE.test(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  const host = parsed.hostname;
  const refused = parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    host.startsWith("[") ||
    IPV4_HOST.test(host) ||
    LOCAL_HOST.test(host) ||
    !HAS_TLD.test(host);
  if (refused) return undefined;
  parsed.hash = "";
  const clean = parsed.href;
  return clean.length <= FOLLOW_INTAKE.MAX_URL_LENGTH ? clean : undefined;
};

// Plain text of at most `max` characters: tags and angle brackets removed,
// hidden characters dropped, whitespace collapsed.
export const text = (max: number): Cleaner<string> => (value) => {
  if (typeof value !== "string") return undefined;
  const plain = stripTags(value.slice(0, max * 4), " ")
    .replace(HIDDEN, "")
    .replace(ANGLE_BRACKETS, "")
    .replace(WHITESPACE, " ")
    .trim();
  return plain ? truncate(plain, max) : undefined;
};

// The items of an array that clean, deduplicated by their JSON, at most `max`.
// A non-array reads as empty.
export const list = <T>(item: Cleaner<T>, max: number): Cleaner<T[]> => (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const raw of value.slice(0, max * 4)) {
    const clean = item(raw);
    const key = JSON.stringify(clean);
    if (clean === undefined || seen.has(key)) continue;
    seen.add(key);
    kept.push(clean);
    if (kept.length === max) break;
  }
  return kept;
};

// An object read field by field; fields that don't clean are left out, as are
// any fields the shape doesn't name. A non-object reads as empty.
export const record = <S extends Record<string, Cleaner<unknown>>>(shape: S): Cleaner<Cleaned<S>> => (value) => {
  const source = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const entries = Object.entries(shape)
    .map(([key, clean]) => [key, clean(source[key])] as const)
    .filter(([, clean]) => clean !== undefined);
  return Object.fromEntries(entries) as Cleaned<S>;
};

// `clean`, refusing a result without `key`.
export const requiring =
  <T extends object>(clean: Cleaner<T>) =>
  <K extends keyof T>(key: K): Cleaner<T & Required<Pick<T, K>>> =>
  (
    value,
  ) => {
    const cleaned = clean(value);
    return cleaned !== undefined && cleaned[key] !== undefined ? cleaned as T & Required<Pick<T, K>> : undefined;
  };

const { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_FEEDS, MAX_IDENTITY_LINKS } = FOLLOW_INTAKE;

// A feed the page links to.
export const feed = requiring(record({ url, title: text(MAX_TITLE_LENGTH) }))("url");

// The signals of one page, as the extension sends them and the inbox keeps them.
export const signals = requiring(
  record({
    url,
    canonical: url,
    title: text(MAX_TITLE_LENGTH),
    site_name: text(MAX_TITLE_LENGTH),
    description: text(MAX_DESCRIPTION_LENGTH),
    author: text(MAX_TITLE_LENGTH),
    feeds: list(feed, MAX_FEEDS),
    rel_me: list(url, MAX_IDENTITY_LINKS),
    same_as: list(url, MAX_IDENTITY_LINKS),
    author_urls: list(url, MAX_IDENTITY_LINKS),
  }),
)("url");

export type Signals = Exclude<ReturnType<typeof signals>, undefined>;
