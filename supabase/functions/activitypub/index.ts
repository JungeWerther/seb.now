import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Real ActivityPub backend for seb.now: the DO Functions proxy forwards
// seb.now/.well-known/webfinger and seb.now/ap/inbox here, and a DO ingress
// rule 308-redirects seb.now/ap/actor straight to this function.
// A single site-wide actor (@seb@seb.now), not per-profile - the local
// `profiles`/`follows` tables are unrelated (those model a profile
// following someone; this models the world following the site).
//
// Implements: WebFinger, the actor document (with its HTTP Signature
// public key), and an inbox that verifies signatures and handles
// Follow/Undo(Follow). Everything else (Like, Announce, Create, Delete,
// ...) is handled only when it's about one of our posts. Posts are local
// `links` rows marked in public.ap_posts: an outbox lists them, and
// /ap/deliver (called by an ap_posts insert trigger) sends each new one to
// followers as a signed Create(Note). A Like or Announce of a post becomes an
// upvote on its link, a public reply becomes a reply, and Undo/Delete remove
// them again.
// No automatic boosting yet (see the "bring your own algorithm" design
// discussion: boosts should follow a deliberate human upvote, not
// ingestion volume, and that's still unbuilt).
const DOMAIN = "seb.now";
const USERNAME = "seb";
const ACTOR_ID = `https://${DOMAIN}/ap/actor`;
const INBOX_URL = `https://${DOMAIN}/ap/inbox`;
const OUTBOX_URL = `https://${DOMAIN}/ap/outbox`;
const NOTES_URL = `https://${DOMAIN}/ap/notes`;
const POST_PAGE_URL = `https://${DOMAIN}/p`;
const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";
const OUTBOX_PAGE_SIZE = 20;
// Must match the replies_body_length check on public.replies.
const REPLY_MAX_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = `${ACTOR_ID}#main-key`;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------------------------------------------------------------------------
// Crypto helpers (Web Crypto API - available natively in Deno)
// ---------------------------------------------------------------------------

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [\s\S]+?-----/, "").replace(/-----END [\s\S]+?-----/, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemToArrayBuffer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", pemToArrayBuffer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function sha256Base64(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return arrayBufferToBase64(digest);
}

function buildSigningString(headerNames: string[], values: Record<string, string>): string {
  return headerNames.map((name) => `${name}: ${values[name] ?? ""}`).join("\n");
}

let cachedKeys: { privateKey: CryptoKey; publicKeyPem: string } | null = null;

const KEY_FETCH_ATTEMPTS = 4;
const KEY_FETCH_RETRY_DELAY_MS = 500;

async function fetchVaultSecret(name: string): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= KEY_FETCH_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.rpc("get_vault_secret", { secret_name: name });
    if (!error && data) return data as string;
    lastError = error?.message ?? "empty secret";
    // On a cold boot the edge runtime's service_role JWT can be minted a
    // moment ahead of PostgREST's clock ("JWT issued at future"), which
    // resolves itself within a second.
    if (attempt < KEY_FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, KEY_FETCH_RETRY_DELAY_MS));
  }
  throw new Error(`missing vault secret ${name}: ${lastError}`);
}

async function getKeys(): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  if (cachedKeys) return cachedKeys;
  const [privatePem, publicPem] = await Promise.all([
    fetchVaultSecret("ap-actor-private-key"),
    fetchVaultSecret("ap-actor-public-key"),
  ]);
  cachedKeys = { privateKey: await importPrivateKey(privatePem), publicKeyPem: publicPem };
  return cachedKeys;
}

// Signs and delivers an activity to a remote inbox using our own key -
// draft-cavage-http-signatures over (request-target)/host/date/digest, the
// scheme Mastodon and most of the fediverse use for federation.
async function signedDeliver(inboxUrl: string, body: string): Promise<Response> {
  const { privateKey } = await getKeys();
  const target = new URL(inboxUrl);
  const date = new Date().toUTCString();
  const digest = `SHA-256=${await sha256Base64(body)}`;
  const headerNames = ["(request-target)", "host", "date", "digest"];
  const values: Record<string, string> = {
    "(request-target)": `post ${target.pathname}`,
    host: target.host,
    date,
    digest,
  };
  const signature = arrayBufferToBase64(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(buildSigningString(headerNames, values))),
  );
  const signatureHeader = `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="${headerNames.join(" ")}",signature="${signature}"`;

  return fetch(inboxUrl, {
    method: "POST",
    headers: {
      Host: target.host,
      Date: date,
      Digest: digest,
      Signature: signatureHeader,
      "Content-Type": "application/activity+json",
    },
    body,
  });
}

// Servers running Mastodon's secure mode (authorized fetch) answer 401 to
// unsigned actor fetches, so these are signed with our key too.
async function signedGet(url: string): Promise<Response> {
  const { privateKey } = await getKeys();
  const target = new URL(url);
  const date = new Date().toUTCString();
  const headerNames = ["(request-target)", "host", "date"];
  const values: Record<string, string> = {
    "(request-target)": `get ${target.pathname}${target.search}`,
    host: target.host,
    date,
  };
  const signature = arrayBufferToBase64(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(buildSigningString(headerNames, values))),
  );
  return fetch(url, {
    headers: {
      Accept: "application/activity+json",
      Date: date,
      Signature: `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="${headerNames.join(" ")}",signature="${signature}"`,
    },
  });
}

type SignatureCheck = { ok: true; actorUrl: string; actorDoc: Record<string, unknown> } | { ok: false; reason: string };

async function fetchActorPublicKey(
  keyId: string,
): Promise<{ ok: true; actorUrl: string; actorDoc: Record<string, unknown>; publicKey: CryptoKey } | { ok: false; reason: string }> {
  const actorUrl = keyId.split("#")[0];
  let actorDoc: Record<string, unknown>;
  try {
    const actorRes = await signedGet(actorUrl);
    if (!actorRes.ok) return { ok: false, reason: `actor fetch for ${actorUrl} failed: ${actorRes.status}` };
    actorDoc = await actorRes.json();
  } catch (e) {
    return { ok: false, reason: `actor fetch error: ${String(e)}` };
  }
  const publicKeyPem = (actorDoc?.publicKey as { publicKeyPem?: string } | undefined)?.publicKeyPem;
  if (!publicKeyPem) return { ok: false, reason: "actor has no publicKey" };
  return { ok: true, actorUrl: (actorDoc.id as string) || actorUrl, actorDoc, publicKey: await importPublicKey(publicKeyPem) };
}

// Senders use one of two schemes: RFC 9421 HTTP Message Signatures (a
// Signature-Input header, which mastodon.social now sends) or the older
// draft-cavage one (a single Signature header with keyId="...").
async function verifyInboundSignature(req: Request, rawBody: string): Promise<SignatureCheck> {
  if (req.headers.get("signature-input")) return await verifyRfc9421Signature(req, rawBody);
  return await verifyCavageSignature(req, rawBody);
}

// Derived components are rebuilt against our public inbox URL, for the same
// reason as in verifyCavageSignature.
async function verifyRfc9421Signature(req: Request, rawBody: string): Promise<SignatureCheck> {
  const inputMatch = (req.headers.get("signature-input") ?? "").match(/^\s*([\w-]+)=(\([^)]*\)[^,]*)/);
  if (!inputMatch) return { ok: false, reason: "malformed signature-input header" };
  const [, label, signatureParams] = inputMatch;

  const sigMatch = (req.headers.get("signature") ?? "").match(new RegExp(`(?:^|,)\\s*${label}=:([^:]+):`));
  if (!sigMatch) return { ok: false, reason: `no signature labelled ${label}` };

  const keyId = signatureParams.match(/;\s*keyid="([^"]+)"/)?.[1];
  if (!keyId) return { ok: false, reason: "signature-input has no keyid" };
  const alg = signatureParams.match(/;\s*alg="([^"]+)"/)?.[1];
  if (alg && alg !== "rsa-v1_5-sha256") return { ok: false, reason: `unsupported alg ${alg}` };

  const components = [...signatureParams.slice(0, signatureParams.indexOf(")")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!components.includes("content-digest")) return { ok: false, reason: "content-digest not signed" };

  const contentDigest = req.headers.get("content-digest") ?? "";
  if (!contentDigest.includes(`sha-256=:${await sha256Base64(rawBody)}:`)) return { ok: false, reason: "content-digest mismatch" };

  const inbox = new URL(INBOX_URL);
  const derived: Record<string, string> = {
    "@method": "POST",
    "@target-uri": INBOX_URL,
    "@authority": inbox.host,
    "@scheme": "https",
    "@path": inbox.pathname,
    "@request-target": inbox.pathname,
    host: inbox.host,
  };
  const lines: string[] = [];
  for (const name of components) {
    const value = derived[name] ?? req.headers.get(name)?.trim();
    if (value === undefined) return { ok: false, reason: `signed component ${name} missing` };
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${signatureParams.trim()}`);

  const actor = await fetchActorPublicKey(keyId);
  if (!actor.ok) return actor;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    actor.publicKey,
    base64ToArrayBuffer(sigMatch[1]),
    new TextEncoder().encode(lines.join("\n")),
  );
  if (!valid) return { ok: false, reason: "signature verification failed" };
  return { ok: true, actorUrl: actor.actorUrl, actorDoc: actor.actorDoc };
}

// Verifies a draft-cavage HTTP Signature against the sending actor's
// published public key. The request reaches this function proxied through
// DO Functions at an internal Supabase URL, not seb.now/ap/inbox directly -
// (request-target)/host are reconstructed to what the real sender actually
// signed (our own published inbox URL), not the internal proxy path.
async function verifyCavageSignature(req: Request, rawBody: string): Promise<SignatureCheck> {
  const sigHeader = req.headers.get("signature");
  if (!sigHeader) return { ok: false, reason: "missing signature header" };

  const params: Record<string, string> = {};
  for (const m of sigHeader.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  if (!params.keyId || !params.signature || !params.headers) {
    return { ok: false, reason: "malformed signature header" };
  }

  const signedHeaderNames = params.headers.split(" ");
  const values: Record<string, string> = {
    "(request-target)": "post /ap/inbox",
    host: DOMAIN,
    date: req.headers.get("date") || "",
    digest: req.headers.get("digest") || "",
  };

  if (signedHeaderNames.includes("digest")) {
    const expectedDigest = `SHA-256=${await sha256Base64(rawBody)}`;
    if (values.digest !== expectedDigest) return { ok: false, reason: "digest mismatch" };
  }

  const actor = await fetchActorPublicKey(params.keyId);
  if (!actor.ok) return actor;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    actor.publicKey,
    base64ToArrayBuffer(params.signature),
    new TextEncoder().encode(buildSigningString(signedHeaderNames, values)),
  );
  if (!valid) return { ok: false, reason: "signature verification failed" };

  return { ok: true, actorUrl: actor.actorUrl, actorDoc: actor.actorDoc };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function json(body: unknown, status: number, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": contentType } });
}

function handleWebfinger(req: Request): Response {
  const resource = new URL(req.url).searchParams.get("resource");
  if (resource !== `acct:${USERNAME}@${DOMAIN}`) return json({ error: "not_found" }, 404);
  return json(
    {
      subject: `acct:${USERNAME}@${DOMAIN}`,
      aliases: [ACTOR_ID],
      links: [
        { rel: "self", type: "application/activity+json", href: ACTOR_ID },
        { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `https://${DOMAIN}/` },
      ],
    },
    // Spec-correct would be application/jrd+json, but DO's OpenWhisk-based
    // functions gateway 400s "+json" suffixed content types under web: raw
    // (Messages.httpContentTypeError) even though the body is otherwise
    // fine - plain application/json is what actually gets through. Most
    // WebFinger clients are lenient about the exact type here.
    200,
    "application/json",
  );
}

async function handleActor(): Promise<Response> {
  const { publicKeyPem } = await getKeys();
  return json(
    {
      "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
      id: ACTOR_ID,
      type: "Person",
      preferredUsername: USERNAME,
      name: "Seb",
      summary: "News, links, and boosts from seb.now.",
      url: `https://${DOMAIN}/`,
      inbox: INBOX_URL,
      outbox: OUTBOX_URL,
      publicKey: { id: KEY_ID, owner: ACTOR_ID, publicKeyPem },
    },
    // Mastodon rejects an actor served with any other type. seb.now/ap/actor
    // redirects here rather than going through the DO Functions proxy, whose
    // gateway can't send this type or accept Mastodon's Accept header.
    200,
    "application/activity+json",
  );
}

type ApPost = { id: string; title: string; created_at: string };
const POST_SELECT = "links(id, title, created_at)";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function noteFor(post: ApPost): Record<string, unknown> {
  return {
    // A query string, not a path segment: seb.now's DO redirect to this
    // function keeps the query but drops anything after its matched prefix.
    id: `${NOTES_URL}?id=${post.id}`,
    type: "Note",
    attributedTo: ACTOR_ID,
    url: `${POST_PAGE_URL}/${post.id}`,
    content: escapeHtml(post.title).split("\n").map((line) => `<p>${line}</p>`).join(""),
    published: new Date(post.created_at).toISOString(),
    to: [PUBLIC_AUDIENCE],
    cc: [],
  };
}

function createFor(post: ApPost): Record<string, unknown> {
  const note = noteFor(post);
  return {
    id: `${note.id}#create`,
    type: "Create",
    actor: ACTOR_ID,
    published: note.published,
    to: note.to,
    cc: note.cc,
    object: note,
  };
}

async function handleOutbox(): Promise<Response> {
  const { data, error, count } = await supabase
    .from("links")
    .select("id, title, created_at, ap_posts!inner(link_id)", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(OUTBOX_PAGE_SIZE);
  if (error) throw new Error(`reading posts failed: ${error.message}`);
  const posts = data as unknown as ApPost[];
  return json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: OUTBOX_URL,
      type: "OrderedCollection",
      totalItems: count ?? posts.length,
      orderedItems: posts.map(createFor),
    },
    200,
    "application/activity+json",
  );
}

async function handleNote(id: string): Promise<Response> {
  if (!UUID_PATTERN.test(id)) return json({ error: "not_found" }, 404);
  const { data, error } = await supabase.from("ap_posts").select(POST_SELECT).eq("link_id", id).maybeSingle();
  if (error || !data) return json({ error: "not_found" }, 404);
  const post = (data as unknown as { links: ApPost }).links;
  return json({ "@context": "https://www.w3.org/ns/activitystreams", ...noteFor(post) }, 200, "application/activity+json");
}

// Claims every undelivered post (setting delivered_at in the same UPDATE, so
// concurrent calls never deliver one twice) and sends each to every follower
// inbox, preferring a server's shared inbox. Unauthenticated on purpose: it
// only ever sends posts already in the table.
async function handleDeliver(): Promise<Response> {
  const { data: claimed, error } = await supabase
    .from("ap_posts")
    .update({ delivered_at: new Date().toISOString() })
    .is("delivered_at", null)
    .select(POST_SELECT);
  if (error) throw new Error(`claiming ap_posts failed: ${error.message}`);
  const posts = (claimed as unknown as { links: ApPost }[]).map((row) => row.links);
  if (!posts.length) return json({ delivered: 0 }, 200);

  const { data: followers, error: followersErr } = await supabase.from("ap_followers").select("inbox_url, shared_inbox_url");
  if (followersErr) throw new Error(`reading ap_followers failed: ${followersErr.message}`);
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox_url ?? f.inbox_url))];

  for (const post of posts.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const body = JSON.stringify({ "@context": "https://www.w3.org/ns/activitystreams", ...createFor(post) });
    await Promise.all(inboxes.map(async (inbox) => {
      try {
        const res = await signedDeliver(inbox, body);
        if (!res.ok) console.error(`post ${post.id} delivery to ${inbox} failed: ${res.status} ${await res.text()}`);
      } catch (e) {
        console.error(`post ${post.id} delivery to ${inbox} threw:`, String(e));
      }
    }));
  }
  return json({ delivered: posts.length, inboxes: inboxes.length }, 200);
}

async function handleFollow(activity: Record<string, unknown>, actorDoc: Record<string, unknown>): Promise<void> {
  const actorUrl = actorDoc.id as string;
  const inboxUrl = actorDoc.inbox as string;
  const sharedInbox = (actorDoc.endpoints as { sharedInbox?: string } | undefined)?.sharedInbox ?? null;

  const { error } = await supabase
    .from("ap_followers")
    .upsert({ actor_url: actorUrl, inbox_url: inboxUrl, shared_inbox_url: sharedInbox }, { onConflict: "actor_url" });
  if (error) console.error(`storing follower ${actorUrl} failed:`, error.message);

  const accept = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ACTOR_ID}/activities/${crypto.randomUUID()}`,
    type: "Accept",
    actor: ACTOR_ID,
    object: activity,
  };

  try {
    const res = await signedDeliver(inboxUrl, JSON.stringify(accept));
    if (!res.ok) console.error(`Accept delivery to ${inboxUrl} failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(`Accept delivery to ${inboxUrl} threw:`, String(e));
  }
}

// The link id of one of our posts, given its note id (or an object carrying
// it), or null when the object isn't one of our posts.
async function ourPostId(object: unknown): Promise<string | null> {
  const id = typeof object === "string" ? object : (object as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id.startsWith(`${NOTES_URL}?id=`)) return null;
  const linkId = new URL(id).searchParams.get("id") ?? "";
  if (!UUID_PATTERN.test(linkId)) return null;
  const { data } = await supabase.from("ap_posts").select("link_id").eq("link_id", linkId).maybeSingle();
  return data ? linkId : null;
}

async function upsertRemoteActor(actorDoc: Record<string, unknown>): Promise<string | null> {
  const actorUrl = actorDoc.id as string;
  const username = typeof actorDoc.preferredUsername === "string" ? actorDoc.preferredUsername : "";
  const handle = username ? `@${username}@${new URL(actorUrl).host}` : actorUrl;
  const { data, error } = await supabase
    .from("remote_actors")
    .upsert({ actor_url: actorUrl, handle: handle.slice(0, 200) }, { onConflict: "actor_url" })
    .select("id")
    .single();
  if (error) {
    console.error(`storing remote actor ${actorUrl} failed:`, error.message);
    return null;
  }
  return data.id;
}

async function remoteActorId(actorUrl: string): Promise<string | null> {
  const { data } = await supabase.from("remote_actors").select("id").eq("actor_url", actorUrl).maybeSingle();
  return data?.id ?? null;
}

// Mastodon sends note content as HTML; replies are stored as the plain text
// the page renders with textContent.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, REPLY_MAX_LENGTH);
}

function isPublic(object: Record<string, unknown>): boolean {
  const audience = [object.to, object.cc].flat().filter((a) => typeof a === "string");
  return audience.some((a) => a === PUBLIC_AUDIENCE || a === "as:Public" || a === "Public");
}

async function handleReaction(activity: Record<string, unknown>, actorDoc: Record<string, unknown>): Promise<void> {
  const linkId = await ourPostId(activity.object);
  if (!linkId) return;
  const actorId = await upsertRemoteActor(actorDoc);
  if (!actorId) return;
  const { error } = await supabase
    .from("votes")
    .upsert({ link_id: linkId, remote_actor_id: actorId, value: 1 }, { onConflict: "link_id,remote_actor_id" });
  if (error) console.error(`storing ${activity.type} on ${linkId} failed:`, error.message);
}

async function handleReply(activity: Record<string, unknown>, actorDoc: Record<string, unknown>): Promise<void> {
  const note = activity.object as Record<string, unknown> | undefined;
  if (!note || typeof note !== "object" || note.type !== "Note" || typeof note.id !== "string") return;
  const linkId = await ourPostId(note.inReplyTo);
  if (!linkId || !isPublic(note)) return;
  const body = htmlToText(typeof note.content === "string" ? note.content : "");
  if (!body) return;
  const actorId = await upsertRemoteActor(actorDoc);
  if (!actorId) return;
  const { error } = await supabase
    .from("replies")
    .upsert({ link_id: linkId, remote_actor_id: actorId, body, ap_object_id: note.id }, { onConflict: "ap_object_id" });
  if (error) console.error(`storing reply ${note.id} failed:`, error.message);
}

async function handleUndoReaction(object: Record<string, unknown>, actorUrl: string): Promise<void> {
  const linkId = await ourPostId(object.object);
  const actorId = await remoteActorId(actorUrl);
  if (!linkId || !actorId) return;
  await supabase.from("votes").delete().eq("link_id", linkId).eq("remote_actor_id", actorId);
}

async function handleDelete(object: unknown, actorUrl: string): Promise<void> {
  const objectId = typeof object === "string" ? object : (object as { id?: unknown } | undefined)?.id;
  const actorId = await remoteActorId(actorUrl);
  if (typeof objectId !== "string" || !actorId) return;
  await supabase.from("replies").delete().eq("ap_object_id", objectId).eq("remote_actor_id", actorId);
}

async function handleInbox(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const verified = await verifyInboundSignature(req, rawBody);
  if (!verified.ok) {
    console.error("inbox signature rejected:", verified.reason);
    return json({ error: "unauthorized", reason: verified.reason }, 401);
  }

  let activity: Record<string, unknown>;
  try {
    activity = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_request", reason: "invalid JSON" }, 400);
  }

  const activityActor = typeof activity.actor === "string" ? activity.actor : (activity.actor as { id?: string } | undefined)?.id;
  if (!activityActor || activityActor !== verified.actorUrl) {
    return json({ error: "unauthorized", reason: "actor mismatch" }, 401);
  }

  if (activity.type === "Follow") {
    await handleFollow(activity, verified.actorDoc);
    return new Response(null, { status: 202 });
  }

  const object = activity.object as Record<string, unknown> | undefined;
  if (activity.type === "Undo" && object?.type === "Follow") {
    const { error } = await supabase.from("ap_followers").delete().eq("actor_url", activityActor);
    if (error) console.error(`removing follower ${activityActor} failed:`, error.message);
    return new Response(null, { status: 202 });
  }
  if (activity.type === "Like" || activity.type === "Announce") {
    await handleReaction(activity, verified.actorDoc);
    return new Response(null, { status: 202 });
  }
  if (activity.type === "Undo" && (object?.type === "Like" || object?.type === "Announce")) {
    await handleUndoReaction(object, activityActor);
    return new Response(null, { status: 202 });
  }
  if (activity.type === "Create") {
    await handleReply(activity, verified.actorDoc);
    return new Response(null, { status: 202 });
  }
  if (activity.type === "Delete") {
    await handleDelete(activity.object, activityActor);
    return new Response(null, { status: 202 });
  }

  console.log(`inbox: ignoring ${activity.type} from ${activityActor}`);
  return new Response(null, { status: 202 });
}

Deno.serve(async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?activitypub/, "") || "/";

  try {
    if (req.method === "GET" && path === "/.well-known/webfinger") return handleWebfinger(req);
    if (req.method === "GET" && path === "/ap/actor") return await handleActor();
    if (req.method === "POST" && path === "/ap/inbox") return await handleInbox(req);
    if (req.method === "GET" && path === "/ap/outbox") return await handleOutbox();
    if (req.method === "POST" && path === "/ap/deliver") return await handleDeliver();
    if (req.method === "GET" && path === "/ap/notes") return await handleNote(new URL(req.url).searchParams.get("id") ?? "");
  } catch (e) {
    console.error("activitypub handler error:", e);
    return json({ error: "internal_error" }, 500);
  }

  return json({ error: "not_found", path }, 404);
});
