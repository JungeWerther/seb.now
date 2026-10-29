import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { type User } from "jsr:@supabase/supabase-js@2";
import { InvalidArgs, object, string } from "../_shared/args.ts";
import { bearer, mergePlan, mergeRefusal } from "../_shared/account_merge.ts";
import { serviceClient } from "../_shared/clients.ts";
import { ACCOUNT_MERGE } from "../_shared/constants.ts";
import { jsonResponses } from "../_shared/helpers.ts";

// Folds the anonymous session a browser held before signing in into the real
// account it signed in to (public.merge_account, 20261029120000_accounts.sql).
//
// POST {"anonymous_token": "<that session's access token>"}
//   Authorization: Bearer <the signed-in account's access token>
//
// Both tokens are checked with auth.getUser, so a caller can only merge a
// session they hold into an account they hold. The merge itself runs in one
// transaction in the database, which checks the same rules again.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = jsonResponses({ headers: CORS });

const input = object({
  anonymous_token: string({ description: "The anonymous session's access token." }, {
    maxLength: ACCOUNT_MERGE.MAX_TOKEN_LENGTH,
  }),
});

class Answer extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function userOf(token: string | null): Promise<User> {
  if (!token) throw new Answer(401, "missing token");
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) throw new Answer(401, "invalid or expired token");
  return data.user;
}

async function merge(request: Request): Promise<Response> {
  const body = input.parse(await request.json().catch(() => null), "body");
  const [account, anon] = await Promise.all([
    userOf(bearer(request.headers.get("Authorization"))),
    userOf(body.anonymous_token),
  ]);
  const refusal = mergeRefusal(anon, account);
  if (refusal) throw new Answer(refusal.status, refusal.error);
  const plan = mergePlan(anon, account);
  const { error } = await serviceClient().rpc("merge_account", { from_user: plan.from, into_user: plan.into });
  if (error) throw new Answer(500, error.message);
  return json({ merged: plan.from, into: plan.into });
}

const answerFor = (e: unknown): Response =>
  e instanceof Answer
    ? json({ error: e.message }, e.status)
    : e instanceof InvalidArgs
    ? json({ error: e.message }, 400)
    : json({ error: String(e) }, 500);

const byMethod: Record<string, (request: Request) => Promise<Response>> = {
  OPTIONS: () => Promise.resolve(new Response(null, { headers: CORS })),
  POST: merge,
};

Deno.serve((request) =>
  (byMethod[request.method] ?? (() => Promise.resolve(json({ error: "method not allowed" }, 405))))(request)
    .catch(answerFor)
);
