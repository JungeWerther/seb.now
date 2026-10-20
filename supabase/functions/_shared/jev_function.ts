// The request handling the Jev-backed enrichment functions (topic-label,
// entity-extract, event-extract) share: the service_role client, the body's
// `link_ids` (checked) and `dry_run`, the Jev client keyed from Vault, and an
// error sink. `serveJev(config, run)` wraps a function's run with all of it and
// answers with `{ model, dry_run, ...summary, errors }`.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { serviceClient, vaultSecret } from "./clients.ts";
import { json, type Report, type Row } from "./helpers.ts";
import { JevClient } from "./jev.ts";
import { JEV } from "./constants.ts";



export interface JevRun {
  db: SupabaseClient;
  jev: JevClient;
  // The links the request names, or null to pick the next ones itself.
  ids: string[] | null;
  dryRun: boolean;
  body: Row;
  report: Report;
}

export interface JevFunction {
  fn: string;
  model: string;
  maxLinkIds: number;
  // Requests that read but never write (beyond `dry_run`), e.g. an evaluation.
  readOnly?: (body: Row) => boolean;
}

function linkIds(body: Row, max: number): string[] | null | undefined {
  const ids = body.link_ids;
  if (ids === undefined) return null;
  return Array.isArray(ids) && ids.length <= max && ids.every((id) => typeof id === "string") ? ids : undefined;
}

// A run that returns a Response answers with it as is.
export function serveJev(
  config: JevFunction,
  run: (ctx: JevRun) => Promise<Row | Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const body: Row = await req.json().catch(() => ({})) ?? {};
    const dryRun = body.dry_run === true;
    const ids = linkIds(body, config.maxLinkIds);
    if (ids === undefined) return json({ error: `link_ids must be at most ${config.maxLinkIds} ids` }, 400);

    const db = serviceClient();
    const apiKey = await vaultSecret(JEV.TYPESAFE_KEY_SECRET).catch(() => null);
    if (!apiKey) return json({ error: `no ${JEV.TYPESAFE_KEY_SECRET} in Vault` }, 500);
    const jev = new JevClient(apiKey, config.model, {
      db,
      fn: config.fn,
      dryRun: dryRun || (config.readOnly?.(body) ?? false),
    });

    const errors: Row[] = [];
    const summary = await run({ db, jev, ids, dryRun, body, report: (error) => errors.push(error) });
    return summary instanceof Response ? summary : json({ model: config.model, dry_run: dryRun, ...summary, errors });
  };
}
