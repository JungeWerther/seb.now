import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeEntities, enabledSources, mapSeries, present, previewImage, serveIngest, upsertLink } from "../_shared/ingest.ts";

// Public Mastodon REST API - no auth needed for public statuses. Not raw
// ActivityPub outbox parsing: Mastodon's JSON API is simpler and stable,
// and every account we pull from happens to be Mastodon. The accounts are
// the enabled mastodon_account rows in sources, as handle@instance.

const POSTS_PER_ACCOUNT = 10;

type Status = {
  id: string;
  uri: string;
  url: string;
  content: string;
  card?: { url?: string; title?: string; image?: string | null } | null;
};

// Mastodon wraps long URLs in inline <span> for ellipsis display with no
// real whitespace between spans - only block-level tags (p, br) represent
// an actual word/sentence break, so only those become a space.
function stripHtml(html: string): string {
  const withBreaks = html.replace(/<\/(p|br)\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks).replace(/\s+/g, " ");
}

// Mastodon only generates a card for posts with exactly one link, and even
// then not always (e.g. if its fetcher can't reach the target) - so a card
// alone misses plenty of single-link posts. Fall back to the post's own
// markup, where a real link is a plain <a href> with no mention/hashtag
// class (those point back into the fediverse, not out to a source).
function extractLinkedUrl(html: string): string | null {
  return [...html.matchAll(/<a\s+href="([^"]+)"[^>]*>/g)]
    .find(([tag]) => !/class="[^"]*\b(mention|hashtag)\b/.test(tag))?.[1] ?? null;
}

// When a post links to a single external page, Mastodon's own preview-card
// generator (status.card) already identifies it - more reliable than
// scanning post text for a URL, and gives us the target page's real title.
function titleFrom(status: { content: string; card?: { title?: string } | null }, displayName: string): string {
  if (status.card?.title) return status.card.title;
  const text = stripHtml(status.content);
  if (!text) return `Post by ${displayName}`;
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

// Mastodon's card already carries a preview image when it generated one.
// When it didn't (same cases titleFrom falls back for), peek at the
// target page ourselves: prefer its og:image, else its first <img>.
function imageFrom(status: { card?: { image?: string | null } | null }, sourceUrl: string): Promise<string | null> {
  return status.card?.image
    ? Promise.resolve(status.card.image)
    : previewImage(sourceUrl, { keys: ["og:image"], firstImage: true });
}

// The account's latest public posts and its display name.
async function latestPosts(handle: string, instance: string) {
  const lookupRes = await fetch(`https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`);
  if (!lookupRes.ok) throw new Error(`lookup ${lookupRes.status}`);
  const account = await lookupRes.json();
  const statusesRes = await fetch(
    `https://${instance}/api/v1/accounts/${account.id}/statuses?exclude_replies=true&exclude_reblogs=true&limit=${POSTS_PER_ACCOUNT}`,
  );
  if (!statusesRes.ok) throw new Error(`statuses ${statusesRes.status}`);
  return { displayName: account.display_name || handle, statuses: await statusesRes.json() };
}

Deno.serve(serveIngest(async (db, report) => {
  const results = await mapSeries(await enabledSources(db, "mastodon_account", report), async ({ id: sourceId, identifier }) => {
    const [handle, instance] = identifier.split("@");
    try {
      const { displayName, statuses } = await latestPosts(handle, instance);
      const linkIds = await mapSeries(statuses.filter((status: { url?: string }) => status.url), async (status: Status) => {
        const sourceUrl = status.card?.url || extractLinkedUrl(status.content) || status.url;
        return upsertLink(db, {
          url: sourceUrl,
          thread_url: status.url,
          title: titleFrom(status, displayName),
          origin: "fediverse",
          fediverse_post_uri: status.uri,
          submitted_by: null,
          // Which followed account posted it; the database tags the link with it.
          source_id: sourceId,
          ...present({ image_url: await imageFrom(status, sourceUrl) }),
        }, { instance, handle, status: status.id }, report, "fediverse_post_uri");
      });
      return { instance, handle, fetched: statuses.length, upserted: linkIds.filter(Boolean).length };
    } catch (e) {
      report({ instance, handle, error: e instanceof Error ? e.message : String(e) });
      return { instance, handle, fetched: 0, upserted: 0 };
    }
  });
  return { results };
}));
