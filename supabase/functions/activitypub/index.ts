import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Real ActivityPub backend for the site: the DO Functions proxy forwards
// <site>/.well-known/webfinger and <site>/ap/inbox here, and a DO ingress
// rule 308-redirects <site>/ap/actor straight to this function. The site's
// address and its actor's username come from public.app_settings.
// The site-wide actor (@<username>@<site>) posts; the local `follows` table is
// unrelated (that models a profile following someone, this the world
// following the site or one of its readers).
//
// Implements: WebFinger, the actor document (with its HTTP Signature
// public key), and an inbox that verifies signatures and handles
// Follow/Undo(Follow). Everything else (Like, Announce, Create, Delete,
// ...) is handled only when it's about one of our posts. Posts are local
// `links` rows marked in public.ap_posts: an outbox lists them, and
// /ap/deliver (called by an ap_posts insert trigger) sends each new one to
// followers as a signed Create(Note). A Like or Announce of a post becomes an
// upvote on its link, a public reply becomes a reply, and Undo/Delete remove
// them again. Every profile with a handle is also an account,
// @handle@<site> (actor <site>/ap/actor?id=<profile id>, with its
// own keypair in public.ap_actor_keys): its replies on our posts go out as
// that account's replies (/ap/deliver-replies, called by a replies insert
// trigger), and deleting one sends a Delete (/ap/delete-reply).
// No automatic boosting yet (see the "bring your own algorithm" design
// discussion: boosts should follow a deliberate human upvote, not
// ingestion volume, and that's still unbuilt).
const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";
const OUTBOX_PAGE_SIZE = 20;
// Must match the replies_body_length check on public.replies.
const REPLY_MAX_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Must match the profiles_handle_format check. USERNAME is the site actor's,
// so a profile holding that handle gets no account of its own.
const HANDLE_PATTERN = "^[a-z0-9_]{1,30}$";
const REPLIES_FEDERATED_PER_HOUR = 5;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BOOT_RETRY_ATTEMPTS = 4;
const BOOT_RETRY_DELAY_MS = 500;

// Runs a service_role query, retrying briefly: on a cold boot the edge
// runtime's service_role JWT can be minted a moment ahead of PostgREST's clock
// ("JWT issued at future"), which resolves itself within a second.
async function withBootRetry<T>(what: string, query: () => PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  let lastError = "";
  for (let attempt = 1; attempt <= BOOT_RETRY_ATTEMPTS; attempt++) {
    const { data, error } = await query();
    if (!error && data) return data;
    lastError = error?.message ?? "no data";
    if (attempt < BOOT_RETRY_ATTEMPTS) await new Promise((r) => setTimeout(r, BOOT_RETRY_DELAY_MS));
  }
  throw new Error(`${what} failed: ${lastError}`);
}

const settingRows = await withBootRetry("reading app_settings", () => supabase.from("app_settings").select("key, value"));
const settings = new Map(settingRows.map((row) => [row.key, row.value]));
function setting(key: string): string {
  const value = settings.get(key);
  if (!value) throw new Error(`app_settings has no ${key}`);
  return value;
}

const SITE_ORIGIN = setting("site_origin");
const DOMAIN = new URL(SITE_ORIGIN).host;
const USERNAME = setting("site_actor_username");
const ACTOR_ID = `${SITE_ORIGIN}/ap/actor`;
const INBOX_URL = `${SITE_ORIGIN}/ap/inbox`;
const OUTBOX_URL = `${SITE_ORIGIN}/ap/outbox`;
const NOTES_URL = `${SITE_ORIGIN}/ap/notes`;
const POST_PAGE_URL = `${SITE_ORIGIN}/p`;
const KEY_ID = `${ACTOR_ID}#main-key`;

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

async function fetchVaultSecret(name: string): Promise<string> {
  return await withBootRetry(`reading vault secret ${name}`, () => supabase.rpc("get_vault_secret", { secret_name: name }));
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

type Signer = { keyId: string; privateKey: CryptoKey };

async function siteSigner(): Promise<Signer> {
  return { keyId: KEY_ID, privateKey: (await getKeys()).privateKey };
}

// Signs and delivers an activity to a remote inbox - draft-cavage-http-
// signatures over (request-target)/host/date/digest, the scheme Mastodon and
// most of the fediverse use for federation. The site actor signs unless
// another account's signer is given.
async function signedDeliver(inboxUrl: string, body: string, signer?: Signer): Promise<Response> {
  const { keyId, privateKey } = signer ?? await siteSigner();
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
  const signatureHeader = `keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames.join(" ")}",signature="${signature}"`;

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

type LocalAccount = { id: string; handle: string };

function userActorId(profileId: string): string {
  return `${ACTOR_ID}?id=${profileId}`;
}

// The account for a profile id or handle, or null when that profile has no
// usable handle.
async function localAccount(by: { id?: string; handle?: string }): Promise<LocalAccount | null> {
  let query = supabase.from("profiles").select("id, handle");
  if (by.id) {
    if (!UUID_PATTERN.test(by.id)) return null;
    query = query.eq("id", by.id);
  } else {
    query = query.eq("handle", by.handle ?? "");
  }
  const { data } = await query.maybeSingle();
  if (!data?.handle || !new RegExp(HANDLE_PATTERN).test(data.handle) || data.handle === USERNAME) return null;
  return { id: data.id, handle: data.handle };
}

async function exportPem(key: CryptoKey, format: "pkcs8" | "spki", label: string): Promise<string> {
  const b64 = arrayBufferToBase64(await crypto.subtle.exportKey(format, key));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

const accountKeys = new Map<string, { privateKey: CryptoKey; publicKeyPem: string }>();

// An account's keypair, generated and stored the first time it's needed. If
// two requests race, the insert that loses is ignored and both use the stored
// pair.
async function getAccountKeys(profileId: string): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  const cached = accountKeys.get(profileId);
  if (cached) return cached;
  let { data } = await supabase.from("ap_actor_keys").select("public_key_pem, private_key_pem").eq("profile_id", profileId).maybeSingle();
  if (!data) {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const generated = {
      profile_id: profileId,
      public_key_pem: await exportPem(pair.publicKey, "spki", "PUBLIC KEY"),
      private_key_pem: await exportPem(pair.privateKey, "pkcs8", "PRIVATE KEY"),
    };
    await supabase.from("ap_actor_keys").upsert(generated, { onConflict: "profile_id", ignoreDuplicates: true });
    ({ data } = await supabase.from("ap_actor_keys").select("public_key_pem, private_key_pem").eq("profile_id", profileId).single());
  }
  const keys = { privateKey: await importPrivateKey(data!.private_key_pem), publicKeyPem: data!.public_key_pem };
  accountKeys.set(profileId, keys);
  return keys;
}

async function accountSigner(profileId: string): Promise<Signer> {
  return { keyId: `${userActorId(profileId)}#main-key`, privateKey: (await getAccountKeys(profileId)).privateKey };
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
// DO Functions at an internal Supabase URL, not <site>/ap/inbox directly -
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
    "(request-target)": `post ${new URL(INBOX_URL).pathname}`,
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

async function handleWebfinger(req: Request): Promise<Response> {
  const resource = new URL(req.url).searchParams.get("resource") ?? "";
  const handle = resource.match(new RegExp(`^acct:([^@]+)@${DOMAIN.replace(".", "\\.")}$`))?.[1];
  if (!handle) return json({ error: "not_found" }, 404);
  let actorId = ACTOR_ID;
  if (handle !== USERNAME) {
    const account = await localAccount({ handle });
    if (!account) return json({ error: "not_found" }, 404);
    actorId = userActorId(account.id);
  }
  return json(
    {
      subject: `acct:${handle}@${DOMAIN}`,
      aliases: [actorId],
      links: [
        { rel: "self", type: "application/activity+json", href: actorId },
        { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `${SITE_ORIGIN}/` },
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
      summary: `News, links, and boosts from ${DOMAIN}.`,
      url: `${SITE_ORIGIN}/`,
      inbox: INBOX_URL,
      outbox: OUTBOX_URL,
      publicKey: { id: KEY_ID, owner: ACTOR_ID, publicKeyPem },
    },
    // Mastodon rejects an actor served with any other type. <site>/ap/actor
    // redirects here rather than going through the DO Functions proxy, whose
    // gateway can't send this type or accept Mastodon's Accept header.
    200,
    "application/activity+json",
  );
}

async function handleUserActor(profileId: string): Promise<Response> {
  const account = await localAccount({ id: profileId });
  if (!account) return json({ error: "not_found" }, 404);
  const actorId = userActorId(account.id);
  const { publicKeyPem } = await getAccountKeys(account.id);
  return json(
    {
      "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
      id: actorId,
      type: "Person",
      preferredUsername: account.handle,
      name: account.handle,
      summary: `A reader of ${DOMAIN}.`,
      url: `${SITE_ORIGIN}/`,
      inbox: INBOX_URL,
      endpoints: { sharedInbox: INBOX_URL },
      publicKey: { id: `${actorId}#main-key`, owner: actorId, publicKeyPem },
    },
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
    // A query string, not a path segment: the site's DO redirect to this
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

type LocalReply = { id: string; link_id: string; author_id: string; handle: string; body: string; created_at: string };

function replyNoteId(replyId: string): string {
  return `${NOTES_URL}?reply=${replyId}`;
}

function replyNoteFor(reply: LocalReply): Record<string, unknown> {
  return {
    id: replyNoteId(reply.id),
    type: "Note",
    attributedTo: userActorId(reply.author_id),
    inReplyTo: `${NOTES_URL}?id=${reply.link_id}`,
    url: `${POST_PAGE_URL}/${reply.link_id}`,
    content: `<p><span class="h-card"><a href="${SITE_ORIGIN}/" class="u-url mention">@<span>${USERNAME}</span></a></span> ` +
      escapeHtml(reply.body).split("\n").join("<br>") + "</p>",
    published: new Date(reply.created_at).toISOString(),
    to: [PUBLIC_AUDIENCE],
    cc: [ACTOR_ID],
    tag: [{ type: "Mention", href: ACTOR_ID, name: `@${USERNAME}@${DOMAIN}` }],
  };
}

async function handleReplyNote(replyId: string): Promise<Response> {
  if (!UUID_PATTERN.test(replyId)) return json({ error: "not_found" }, 404);
  const { data } = await supabase
    .from("replies")
    .select("id, link_id, author_id, body, created_at, profiles(handle)")
    .eq("id", replyId)
    .eq("ap_state", "sent")
    .maybeSingle();
  if (!data) return json({ error: "not_found" }, 404);
  const reply = { ...data, handle: (data.profiles as unknown as { handle: string }).handle } as LocalReply;
  return json({ "@context": "https://www.w3.org/ns/activitystreams", ...replyNoteFor(reply) }, 200, "application/activity+json");
}

// Everyone who should see a reply on this post: the site's followers, the
// author's followers, and the remote accounts already in the conversation.
async function conversationInboxes(linkId: string, authorId: string): Promise<string[]> {
  const [{ data: followers }, { data: voters }, { data: repliers }] = await Promise.all([
    supabase.from("ap_followers").select("inbox_url, shared_inbox_url").or(`profile_id.is.null,profile_id.eq.${authorId}`),
    supabase.from("votes").select("remote_actors(inbox_url, shared_inbox_url)").eq("link_id", linkId).not("remote_actor_id", "is", null),
    supabase.from("replies").select("remote_actors(inbox_url, shared_inbox_url)").eq("link_id", linkId).not("remote_actor_id", "is", null),
  ]);
  type Inboxes = { inbox_url: string | null; shared_inbox_url: string | null } | null;
  const actors: Inboxes[] = [
    ...(followers ?? []),
    ...[...(voters ?? []), ...(repliers ?? [])].map((row) => row.remote_actors as unknown as Inboxes),
  ];
  return [...new Set(actors.map((a) => a?.shared_inbox_url ?? a?.inbox_url).filter((url): url is string => !!url))];
}

async function deliverAll(inboxes: string[], activity: Record<string, unknown>, signer: Signer): Promise<void> {
  const body = JSON.stringify({ "@context": "https://www.w3.org/ns/activitystreams", ...activity });
  await Promise.all(inboxes.map(async (inbox) => {
    try {
      const res = await signedDeliver(inbox, body, signer);
      if (!res.ok) console.error(`${activity.type} ${activity.id} delivery to ${inbox} failed: ${res.status} ${await res.text()}`);
    } catch (e) {
      console.error(`${activity.type} ${activity.id} delivery to ${inbox} threw:`, String(e));
    }
  }));
}

async function handleDeliverReplies(): Promise<Response> {
  const { data, error } = await supabase.rpc("claim_federated_replies", {
    handle_pattern: HANDLE_PATTERN,
    reserved_handle: USERNAME,
    per_hour: REPLIES_FEDERATED_PER_HOUR,
  });
  if (error) throw new Error(`claiming replies failed: ${error.message}`);
  const sent = (data as (LocalReply & { ap_state: string })[]).filter((r) => r.ap_state === "sent");
  for (const reply of sent) {
    const note = replyNoteFor(reply);
    const create = { id: `${note.id}#create`, type: "Create", actor: note.attributedTo, published: note.published, to: note.to, cc: note.cc, object: note };
    await deliverAll(await conversationInboxes(reply.link_id, reply.author_id), create, await accountSigner(reply.author_id));
  }
  return json({ claimed: (data as unknown[]).length, sent: sent.length }, 200);
}

// Called by the replies delete trigger. Only sends the Delete once the reply
// is really gone, so a caller can't retract a reply that still exists.
async function handleDeleteReply(req: Request): Promise<Response> {
  const { reply_id, author_id, link_id } = await req.json().catch(() => ({}));
  if (![reply_id, author_id, link_id].every((v) => typeof v === "string" && UUID_PATTERN.test(v))) {
    return json({ error: "bad_request" }, 400);
  }
  const { data: stillThere } = await supabase.from("replies").select("id").eq("id", reply_id).maybeSingle();
  if (stillThere) return json({ error: "reply still exists" }, 409);
  const noteId = replyNoteId(reply_id);
  const actorId = userActorId(author_id);
  const del = { id: `${noteId}#delete`, type: "Delete", actor: actorId, to: [PUBLIC_AUDIENCE], object: { id: noteId, type: "Tombstone" } };
  await deliverAll(await conversationInboxes(link_id, author_id), del, await accountSigner(author_id));
  return json({ deleted: noteId }, 200);
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

  const { data: followers, error: followersErr } = await supabase
    .from("ap_followers")
    .select("inbox_url, shared_inbox_url")
    .is("profile_id", null);
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

// Which of our actors an activity targets: the site actor (profile null), a
// profile's account, or none of ours.
async function followedAccount(target: unknown): Promise<{ profileId: string | null } | null> {
  const id = typeof target === "string" ? target : (target as { id?: unknown } | undefined)?.id;
  if (id === ACTOR_ID) return { profileId: null };
  if (typeof id !== "string" || !id.startsWith(`${ACTOR_ID}?id=`)) return null;
  const account = await localAccount({ id: new URL(id).searchParams.get("id") ?? "" });
  return account ? { profileId: account.id } : null;
}

async function handleFollow(activity: Record<string, unknown>, actorDoc: Record<string, unknown>): Promise<void> {
  const followed = await followedAccount(activity.object);
  if (!followed) return;
  const actorUrl = actorDoc.id as string;
  const inboxUrl = actorDoc.inbox as string;
  const sharedInbox = (actorDoc.endpoints as { sharedInbox?: string } | undefined)?.sharedInbox ?? null;

  const { error } = await supabase
    .from("ap_followers")
    .upsert(
      { actor_url: actorUrl, inbox_url: inboxUrl, shared_inbox_url: sharedInbox, profile_id: followed.profileId },
      { onConflict: "actor_url,profile_id" },
    );
  if (error) console.error(`storing follower ${actorUrl} failed:`, error.message);

  const followedId = followed.profileId ? userActorId(followed.profileId) : ACTOR_ID;
  const accept = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${followedId}#accepts/${crypto.randomUUID()}`,
    type: "Accept",
    actor: followedId,
    object: activity,
  };

  try {
    const signer = followed.profileId ? await accountSigner(followed.profileId) : undefined;
    const res = await signedDeliver(inboxUrl, JSON.stringify(accept), signer);
    if (!res.ok) console.error(`Accept delivery to ${inboxUrl} failed: ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(`Accept delivery to ${inboxUrl} threw:`, String(e));
  }
}

// The link id of one of our posts, given its note id (or an object carrying
// it), or null when the object isn't one of our posts.
async function ourPostId(object: unknown, { viaReply = false } = {}): Promise<string | null> {
  const id = typeof object === "string" ? object : (object as { id?: unknown } | undefined)?.id;
  if (viaReply && typeof id === "string" && id.startsWith(`${NOTES_URL}?reply=`)) {
    const replyId = new URL(id).searchParams.get("reply") ?? "";
    if (!UUID_PATTERN.test(replyId)) return null;
    const { data } = await supabase.from("replies").select("link_id").eq("id", replyId).eq("ap_state", "sent").maybeSingle();
    return data?.link_id ?? null;
  }
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
  const inboxUrl = typeof actorDoc.inbox === "string" ? actorDoc.inbox : null;
  const sharedInbox = (actorDoc.endpoints as { sharedInbox?: unknown } | undefined)?.sharedInbox;
  const { data, error } = await supabase
    .from("remote_actors")
    .upsert(
      { actor_url: actorUrl, handle: handle.slice(0, 200), inbox_url: inboxUrl, shared_inbox_url: typeof sharedInbox === "string" ? sharedInbox : null },
      { onConflict: "actor_url" },
    )
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
  const linkId = await ourPostId(note.inReplyTo, { viaReply: true });
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
    const followed = await followedAccount(object.object);
    let unfollow = supabase.from("ap_followers").delete().eq("actor_url", activityActor);
    if (followed) {
      unfollow = followed.profileId ? unfollow.eq("profile_id", followed.profileId) : unfollow.is("profile_id", null);
    }
    const { error } = await unfollow;
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
    if (req.method === "GET" && path === "/.well-known/webfinger") return await handleWebfinger(req);
    if (req.method === "GET" && path === "/ap/actor") {
      const profileId = new URL(req.url).searchParams.get("id");
      return profileId ? await handleUserActor(profileId) : await handleActor();
    }
    if (req.method === "POST" && path === "/ap/inbox") return await handleInbox(req);
    if (req.method === "GET" && path === "/ap/outbox") return await handleOutbox();
    if (req.method === "POST" && path === "/ap/deliver") return await handleDeliver();
    if (req.method === "GET" && path === "/ap/notes") {
      const params = new URL(req.url).searchParams;
      return params.has("reply") ? await handleReplyNote(params.get("reply") ?? "") : await handleNote(params.get("id") ?? "");
    }
    if (req.method === "POST" && path === "/ap/deliver-replies") return await handleDeliverReplies();
    if (req.method === "POST" && path === "/ap/delete-reply") return await handleDeleteReply(req);
  } catch (e) {
    console.error("activitypub handler error:", e);
    return json({ error: "internal_error" }, 500);
  }

  return json({ error: "not_found", path }, 404);
});
