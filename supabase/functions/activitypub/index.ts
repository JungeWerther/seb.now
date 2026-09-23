import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Real ActivityPub backend for the DO Functions proxy at
// seb.now/.well-known/webfinger, seb.now/ap/actor, seb.now/ap/inbox.
// A single site-wide actor (@seb@seb.now), not per-profile - the local
// `profiles`/`follows` tables are unrelated (those model a profile
// following someone; this models the world following the site).
//
// Implements: WebFinger, the actor document (with its HTTP Signature
// public key), and an inbox that verifies signatures and handles
// Follow/Undo(Follow). Everything else (Like, Announce, Create, Delete,
// ...) is accepted (202) and logged, not acted on - there's no outbox or
// automatic boosting yet (see the "bring your own algorithm" design
// discussion: boosts should follow a deliberate human upvote, not
// ingestion volume, and that's still unbuilt).
const DOMAIN = "seb.now";
const USERNAME = "seb";
const ACTOR_ID = `https://${DOMAIN}/ap/actor`;
const INBOX_URL = `https://${DOMAIN}/ap/inbox`;
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

async function getKeys(): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  if (cachedKeys) return cachedKeys;
  const [{ data: privatePem, error: privErr }, { data: publicPem, error: pubErr }] = await Promise.all([
    supabase.rpc("get_vault_secret", { secret_name: "ap-actor-private-key" }),
    supabase.rpc("get_vault_secret", { secret_name: "ap-actor-public-key" }),
  ]);
  if (privErr || !privatePem) throw new Error(`missing actor private key: ${privErr?.message}`);
  if (pubErr || !publicPem) throw new Error(`missing actor public key: ${pubErr?.message}`);
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

// Verifies an inbound activity's HTTP Signature against the sending actor's
// published public key. The request reaches this function proxied through
// DO Functions at an internal Supabase URL, not seb.now/ap/inbox directly -
// (request-target)/host are reconstructed to what the real sender actually
// signed (our own published inbox URL), not the internal proxy path.
async function verifyInboundSignature(
  req: Request,
  rawBody: string,
): Promise<{ ok: true; actorUrl: string; actorDoc: Record<string, unknown> } | { ok: false; reason: string }> {
  const sigHeader = req.headers.get("signature");
  if (!sigHeader) return { ok: false, reason: "missing signature header" };

  const params: Record<string, string> = {};
  for (const m of sigHeader.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  if (!params.keyId || !params.signature || !params.headers) {
    return { ok: false, reason: "malformed signature header" };
  }

  const actorUrl = params.keyId.split("#")[0];
  let actorDoc: Record<string, unknown>;
  try {
    const actorRes = await fetch(actorUrl, { headers: { Accept: "application/activity+json" } });
    if (!actorRes.ok) return { ok: false, reason: `actor fetch failed: ${actorRes.status}` };
    actorDoc = await actorRes.json();
  } catch (e) {
    return { ok: false, reason: `actor fetch error: ${String(e)}` };
  }

  const publicKeyPem = (actorDoc?.publicKey as { publicKeyPem?: string } | undefined)?.publicKeyPem;
  if (!publicKeyPem) return { ok: false, reason: "actor has no publicKey" };

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

  const publicKey = await importPublicKey(publicKeyPem);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64ToArrayBuffer(params.signature),
    new TextEncoder().encode(buildSigningString(signedHeaderNames, values)),
  );
  if (!valid) return { ok: false, reason: "signature verification failed" };

  return { ok: true, actorUrl: (actorDoc.id as string) || actorUrl, actorDoc };
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
      publicKey: { id: KEY_ID, owner: ACTOR_ID, publicKeyPem },
    },
    // Same DO gateway quirk as WebFinger above - application/activity+json
    // 400s under web: raw, plain application/json doesn't. Real senders
    // (Mastodon included) negotiate on Accept, not a strict response
    // Content-Type check, so this doesn't break federation.
    200,
    "application/json",
  );
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

  const object = activity.object as { type?: string } | undefined;
  if (activity.type === "Undo" && object?.type === "Follow") {
    const { error } = await supabase.from("ap_followers").delete().eq("actor_url", activityActor);
    if (error) console.error(`removing follower ${activityActor} failed:`, error.message);
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
  } catch (e) {
    console.error("activitypub handler error:", e);
    return json({ error: "internal_error" }, 500);
  }

  return json({ error: "not_found", path }, 404);
});
