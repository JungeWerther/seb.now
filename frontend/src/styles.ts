// A style's tokens as CSS custom properties (20261020120000_style_types.sql).
// A style type's stored schema is compiled: every token a `$ref` to one of its
// `$defs` primitives (a string with a pattern, or a bounded number) or an
// `enum` of keywords. The database already checked the style against it; the
// page checks each value again before it reaches the CSSOM, and drops what
// doesn't read, so a style can only set the tokens its type names, to values
// its type allows.

type PrimitiveSchema = { type: "string"; pattern: string } | { type: "number"; minimum: number; maximum: number };
type TokenSchema = { $ref: string } | { enum: string[] };
interface StyleSchema { properties: Record<string, TokenSchema>; $defs: Record<string, PrimitiveSchema> }
type StyleValues = Record<string, unknown>;
type TokenField = "$ref" | "enum";
type PrimitiveType = PrimitiveSchema["type"];

const DEFS_PREFIX = "#/$defs/";
const TOKEN_PROPERTY_PREFIX = "--";
const TOKEN_WORD_SEPARATOR = /_/g;
const TOKEN_PROPERTY_SEPARATOR = "-";
const TOKEN_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const PATTERN_FLAGS = "u";
// Nothing a primitive's pattern admits, checked again here: no url(), no way
// out of the declaration.
const UNSAFE_VALUE = /[();{}\\<>]/;

// Whether `value` matches a primitive's pattern; a pattern this engine can't
// read matches nothing.
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, PATTERN_FLAGS).test(value);
  } catch {
    return false;
  }
}

// Whether `value` is one `primitive` allows.
const acceptsByPrimitiveType: Mapping<PrimitiveType, (primitive: PrimitiveSchema, value: unknown) => boolean> = {
  string: (primitive, value) =>
    typeof value === "string" && "pattern" in primitive && matchesPattern(primitive.pattern, value),
  number: (primitive, value) =>
    typeof value === "number" && Number.isFinite(value) && "minimum" in primitive
    && value >= primitive.minimum && value <= primitive.maximum,
};

// Whether `value` is one a token allows, given its type's primitives.
const acceptsByTokenField: Cases<TokenField, TokenSchema, (defs: StyleSchema["$defs"], value: unknown) => boolean> = {
  $ref: ({ $ref }) => (defs, value) => {
    const primitive = $ref.startsWith(DEFS_PREFIX) ? defs[$ref.slice(DEFS_PREFIX.length)] : undefined;
    return primitive !== undefined && acceptsByPrimitiveType[primitive.type](primitive, value);
  },
  enum: (token) => (_defs, value) => typeof value === "string" && token.enum.includes(value),
};

// The custom property a token sets: `column_width` is `--column-width`.
function tokenProperty(token: string): string {
  return TOKEN_PROPERTY_PREFIX + token.replace(TOKEN_WORD_SEPARATOR, TOKEN_PROPERTY_SEPARATOR);
}

// A style's values as [property, value] declarations, keeping only the tokens
// its type names whose values it allows.
function styleDeclarations(schema: StyleSchema, values: StyleValues): [string, string][] {
  return Object.entries(schema.properties)
    .filter(([token, tokenSchema]) =>
      TOKEN_NAME.test(token) && match(acceptsByTokenField, tokenSchema)(schema.$defs, values[token]))
    .map(([token]): [string, string] => [tokenProperty(token), String(values[token])])
    .filter(([, value]) => !UNSAFE_VALUE.test(value));
}

// Every custom property a style type's tokens set, to clear them.
function styleProperties(schema: StyleSchema): string[] {
  return Object.keys(schema.properties).filter((token) => TOKEN_NAME.test(token)).map(tokenProperty);
}
