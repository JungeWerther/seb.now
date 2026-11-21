import { type Field, InvalidArgs, map, string } from "./args.ts";
import { STYLE_TYPES } from "./constants.ts";

// Arguments naming style types and carrying style values (20261020120000_style_types.sql),
// shared by the style-types API and the MCP server. The database is the
// authority (pg_jsonschema checks every value against its type's schema); these
// refuse what no type could accept before a request reaches it, so a caller
// learns why at once and nothing CSS-shaped slips past a type added later.

const TYPE_NAME = /^[a-z0-9_]{2,32}$/;
const TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
// What a value could use to leave its declaration: a function (url(), expression()),
// a new declaration or block, an escape, markup, or a control character.
const UNSAFE = /[(){};\\<>]|\p{Cc}/u;

export const styleTypeName = map(
  string({ description: "The style type's name, e.g. palette, block or layout (see list_styles)." }, { maxLength: 32 }),
  (name) => {
    if (!TYPE_NAME.test(name)) throw new InvalidArgs("type must be 2-32 lowercase letters, digits or underscores");
    return name;
  },
);

export const styleKindPath = (name: string) => `${STYLE_TYPES.KIND_ROOT}.${name}`;

const tokenValue = (value: unknown, at: string): string | number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.length || value.length > STYLE_TYPES.MAX_TOKEN_VALUE_LENGTH) {
    throw new InvalidArgs(`${at} must be a number or a string of 1-${STYLE_TYPES.MAX_TOKEN_VALUE_LENGTH} characters`);
  }
  if (UNSAFE.test(value)) throw new InvalidArgs(`${at} may not contain ( ) { } ; \\ < > or control characters`);
  return value;
};

// A style's values, one per token: `{"color_page": "#ebedf1"}`.
export const styleValues = (description: string): Field<Record<string, string | number>> => ({
  schema: {
    type: "object",
    description,
    maxProperties: STYLE_TYPES.MAX_TOKENS,
    propertyNames: { pattern: TOKEN.source },
    additionalProperties: { type: ["string", "number"] },
  },
  required: true,
  parse: (value, at) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new InvalidArgs(`${at} must be a JSON object of token values`);
    }
    const entries = Object.entries(value);
    if (entries.length > STYLE_TYPES.MAX_TOKENS) throw new InvalidArgs(`${at} has more than ${STYLE_TYPES.MAX_TOKENS} tokens`);
    return Object.fromEntries(entries.map(([token, v]) => {
      if (!TOKEN.test(token)) throw new InvalidArgs(`${at}: '${token.slice(0, 64)}' isn't a token name`);
      return [token, tokenValue(v, `${at}.${token}`)];
    }));
  },
});

type TokenSchema = { $ref?: string; enum?: unknown[]; description?: string };

// A type's compiled schema read back as what each token takes: a primitive's
// name (color, length, …) or its keywords, with the token's description.
export function tokensOf(schema: { properties?: Record<string, TokenSchema> }): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([token, { $ref, enum: keywords, description }]) => [
    token,
    {
      ...($ref ? { takes: $ref.split("/").pop() } : { takes: keywords }),
      ...(description ? { description } : {}),
    },
  ]));
}
