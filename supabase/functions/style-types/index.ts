import "jsr:@supabase/functions-js@2/edge-runtime.d.ts";
import { createClient, type PostgrestError, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { type Field, type Fields, type Infer, InvalidArgs, map, object, optional, string, uuid } from "../_shared/args.ts";
import { ENV, STYLE_TYPES } from "../_shared/constants.ts";
import { jsonResponses } from "../_shared/helpers.ts";

// An API for style types and styles (20261020120000_style_types.sql): design
// tokens in the entity graph. A type is a kind `entity.style.<name>` whose
// schema names our primitives (GET /primitives) or keyword enums; a style is an
// entity of that kind holding one value per token. Every request runs as the
// caller, so RLS decides what they may change (their own types and styles), and
// the database checks every schema and value with pg_jsonschema. This function
// only parses the request and says why a write was refused.
//
// GET    /primitives
// GET    /types
// POST   /types          {"name": "theme", "label": "Theme", "properties": {"bg": {"$ref": "#/$defs/color"}}}
// DELETE /types/:name
// GET    /styles?type=theme
// POST   /styles         {"type": "theme", "name": "Dark", "style": {"bg": "#101010"}}
// PATCH  /styles/:id     {"style": {...}, "description": "..."}
// DELETE /styles/:id

const TYPE_NAME = /^[a-z0-9_]{2,32}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

// How a refused write reads to the caller, by Postgres error code.
const STATUS_BY_CODE: Record<string, number> = {
  "23514": 422, // check_violation: a schema or value the type doesn't allow
  "42501": 403, // insufficient_privilege / RLS: not yours, or not signed in
  "23505": 409, // unique_violation: a type or a style of that name exists
  "23503": 409, // foreign_key_violation: no such type, or a type still in use
  "PGRST116": 404, // .single() found no row
};

const json = jsonResponses({ headers: CORS });

type Db = SupabaseClient;
type Context = { db: Db; params: Record<string, string>; query: URLSearchParams };
type Route = { method: string; path: URLPattern; handle: (body: unknown, ctx: Context) => Promise<unknown> };

class Refused extends Error {
  constructor(readonly error: PostgrestError) {
    super(error.message);
  }
}

// A JSON object, passed on as is: what's in it is the database's to check.
const jsonObject = (description: string): Field<Record<string, unknown>> => ({
  schema: { type: "object", description },
  required: true,
  parse: (value, at) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new InvalidArgs(`${at} must be a JSON object`);
  },
});

const typeName = map(
  string({ description: "The type's name: 2-32 lowercase letters, digits or underscores." }, { maxLength: 32 }),
  (name) => {
    if (!TYPE_NAME.test(name)) throw new InvalidArgs("name must be 2-32 lowercase letters, digits or underscores");
    return name;
  },
);

const kindPath = (name: string) => `${STYLE_TYPES.KIND_ROOT}.${name}`;
const description = () =>
  optional(string({ description: "What it's for." }, { maxLength: STYLE_TYPES.MAX_DESCRIPTION_LENGTH }));

async function rows<T>(query: PromiseLike<{ data: T | null; error: PostgrestError | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Refused(error);
  return data as T;
}

const TYPE_COLUMNS = "path, label, description, schema, owner_id";
const STYLE_COLUMNS = "id, name, description, kind_path, style, owner_id";

// A route declared once: its method, its path (`:name` segments become params)
// and, for a body, the fields it's parsed by.
function route<F extends Fields>(
  method: string,
  path: string,
  input: F,
  handler: (args: Infer<F>, ctx: Context) => Promise<unknown>,
): Route {
  const parser = object(input);
  return {
    method,
    path: new URLPattern({ pathname: `{/*}?/style-types${path}` }),
    handle: (body, ctx) => handler(parser.parse(body ?? {}, ""), ctx),
  };
}

const ROUTES: Route[] = [
  route("GET", "/primitives", {}, (_, { db }) =>
    rows(db.from("style_primitives").select("name, schema, description").order("name"))),

  route("GET", "/types", {}, (_, { db }) =>
    rows(db.from("kinds").select(TYPE_COLUMNS).not("schema", "is", null).order("path"))),

  route("POST", "/types", {
    name: typeName,
    label: string({ description: "Its label: 2-40 letters, digits or spaces." }, { maxLength: STYLE_TYPES.MAX_LABEL_LENGTH }),
    description: description(),
    properties: jsonObject("Its tokens: each {\"$ref\": \"#/$defs/<primitive>\"} or {\"enum\": [...]}."),
  }, ({ name, label, description, properties }, { db }) =>
    rows(
      db.from("kinds")
        .insert({ path: kindPath(name), label, description, schema: { properties } })
        .select(TYPE_COLUMNS)
        .single(),
    )),

  route("DELETE", "/types/:name", {}, async (_, { db, params }) => {
    await rows(db.from("kinds").delete().eq("path", kindPath(params.name)).select("path").single());
    return { deleted: params.name };
  }),

  route("GET", "/styles", {}, (_, { db, query }) => {
    const type = query.get("type");
    const styles = db.from("entities").select(STYLE_COLUMNS).eq("kind", "style").order("name");
    return rows(type ? styles.eq("kind_path", kindPath(typeName.parse(type, "type"))) : styles);
  }),

  route("POST", "/styles", {
    type: typeName,
    name: string({ description: "The style's name." }, { maxLength: STYLE_TYPES.MAX_STYLE_NAME_LENGTH }),
    description: description(),
    style: jsonObject("One value per token of the type."),
  }, ({ type, name, description, style }, { db }) =>
    rows(
      db.from("entities")
        .insert({ name, kind: "style", kind_path: kindPath(type), description, style })
        .select(STYLE_COLUMNS)
        .single(),
    )),

  route("PATCH", "/styles/:id", {
    style: optional(jsonObject("One value per token of the type.")),
    description: description(),
  }, ({ style, description }, { db, params }) => {
    const id = uuid().parse(params.id, "id");
    const changes = Object.fromEntries(Object.entries({ style, description }).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) throw new InvalidArgs("give style, description or both");
    return rows(db.from("entities").update(changes).eq("id", id).select(STYLE_COLUMNS).single());
  }),

  route("DELETE", "/styles/:id", {}, async (_, { db, params }) => {
    const id = uuid().parse(params.id, "id");
    await rows(db.from("entities").delete().eq("id", id).eq("kind", "style").select("id").single());
    return { deleted: id };
  }),
];

function asCaller(req: Request): Db {
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
}

async function bodyOf(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") return undefined;
  try {
    return await req.json();
  } catch {
    throw new InvalidArgs("the body must be JSON");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const matches = ROUTES.map((r) => ({ r, m: r.path.exec(url) })).filter(({ m }) => m);
  if (!matches.length) return json({ error: "not found" }, 404);
  const match = matches.find(({ r }) => r.method === req.method);
  if (!match) return json({ error: `${req.method} not allowed here` }, 405);
  const params = Object.fromEntries(
    Object.entries(match.m!.pathname.groups).filter(([k, v]) => k !== "0" && v !== undefined),
  ) as Record<string, string>;
  try {
    const result = await match.r.handle(await bodyOf(req), { db: asCaller(req), params, query: url.searchParams });
    return json(result, req.method === "POST" ? 201 : 200);
  } catch (e) {
    if (e instanceof InvalidArgs) return json({ error: e.message }, 400);
    if (e instanceof Refused) {
      return json({ error: e.error.message, code: e.error.code }, STATUS_BY_CODE[e.error.code] ?? 400);
    }
    console.error("style-types failed", e);
    return json({ error: "internal error" }, 500);
  }
});
