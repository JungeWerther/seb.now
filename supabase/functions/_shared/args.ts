// Argument parsers declared as JSON Schema: each field is built from the schema
// a client is shown, and validates (and types) a value by that same schema, so
// a bound is written once. Options outside the schema (a parser's own
// refinements) never reach the client.

export type JsonSchema = { readonly [key: string]: unknown };

export class InvalidArgs extends Error {}

export interface Field<T> {
  readonly schema: JsonSchema;
  // Listed in its object's `required`: it has no default and isn't optional.
  readonly required: boolean;
  parse(value: unknown, at: string): T;
}

export type Fields = { readonly [key: string]: Field<unknown> };
export type Infer<F extends Fields> = { -readonly [K in keyof F]: F[K] extends Field<infer T> ? T : never };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A field of `type`, whose schema is `type` and then `schema` as written, and
// whose value is `check`ed after a missing one takes the schema's default.
function field<T, S extends JsonSchema & { default?: unknown }>(
  type: string,
  schema: S,
  check: (value: unknown, at: string) => T,
): Field<T> {
  return {
    schema: { type, ...schema },
    required: schema.default === undefined,
    parse: (value, at) => check(value ?? schema.default, at),
  };
}

const fail = (message: string): never => {
  throw new InvalidArgs(message);
};

export const integer = (schema: { minimum?: number; maximum?: number; default?: number; description?: string }) => {
  const { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = schema;
  return field("integer", schema, (value, at) =>
    Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
      ? value as number
      : fail(`${at} must be an integer from ${minimum} to ${maximum}`));
};

const interval = ({ minimum, exclusiveMinimum, maximum }: { minimum?: number; exclusiveMinimum?: number; maximum?: number }) =>
  `${exclusiveMinimum !== undefined ? `(${exclusiveMinimum}` : `[${minimum ?? -Infinity}`}, ` +
  `${maximum ?? Infinity}${maximum !== undefined ? "]" : ")"}`;

export const number = (
  schema: { minimum?: number; exclusiveMinimum?: number; maximum?: number; default?: number; description?: string },
) => {
  const { minimum = -Infinity, exclusiveMinimum = -Infinity, maximum = Infinity } = schema;
  return field("number", schema, (value, at) =>
    typeof value === "number" && value >= minimum && value > exclusiveMinimum && value <= maximum
      ? value
      : fail(`${at} must be a number in ${interval(schema)}`));
};

export const boolean = (schema: { default?: boolean; description?: string }) =>
  field("boolean", schema, (value, at) => typeof value === "boolean" ? value : fail(`${at} must be true or false`));

// Trimmed, and never blank. `maxLength` caps a string whose schema states none.
export const string = (
  schema: { minLength?: number; maxLength?: number; default?: string; description?: string },
  { maxLength = Infinity }: { maxLength?: number } = {},
) => {
  const min = Math.max(schema.minLength ?? 1, 1);
  const max = schema.maxLength ?? maxLength;
  const shape = max === Infinity
    ? (min > 1 ? `a string of at least ${min} characters` : "a non-empty string")
    : (min > 1 ? `a string of ${min} to ${max} characters` : `a non-empty string of at most ${max} characters`);
  return field("string", schema, (value, at) =>
    typeof value === "string" && value.trim().length >= min && value.length <= max
      ? value.trim()
      : fail(`${at} must be ${shape}`));
};

// `trimmedTo` first reads it as a trimmed string of at most that many characters.
export const uuid = (schema: { description?: string } = {}, { trimmedTo }: { trimmedTo?: number } = {}) => {
  const text = trimmedTo === undefined ? undefined : string({}, { maxLength: trimmedTo });
  return field("string", schema, (value, at) => {
    const id = text ? text.parse(value, at) : value;
    return typeof id === "string" && UUID.test(id) ? id : fail(`${at} must be an id (a UUID)`);
  });
};

export const oneOf = <const V extends readonly string[]>(schema: { enum: V; default?: V[number]; description?: string }) =>
  field("string", schema, (value, at) =>
    schema.enum.includes(value as string) ? value as V[number] : fail(`${at} must be one of ${schema.enum.join(", ")}`));

export const array = <T>(items: Field<T>, schema: { minItems: number; maxItems: number; description?: string }) =>
  field("array", { ...schema, items: items.schema }, (value, at) =>
    Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems
      ? value.map((item, i) => items.parse(item, `${at}[${i}]`))
      : fail(`${at} must list ${schema.minItems}-${schema.maxItems} items`));

// Its fields in order, read from any value (a missing or non-object one has
// none), each named by its path.
export const object = <F extends Fields>(properties: F): Field<Infer<F>> => {
  const required = Object.keys(properties).filter((key) => properties[key].required);
  return {
    schema: { type: "object", properties: mapValues(properties, (f) => f.schema), ...(required.length ? { required } : {}) },
    required: true,
    parse: (value, at) => {
      const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      return mapValues(properties, (f, key) => f.parse(record[key], at ? `${at}.${key}` : key)) as Infer<F>;
    },
  };
};

// Absent (null or left out) reads as undefined; anything else must parse.
export const optional = <T>({ schema, parse }: Field<T>): Field<T | undefined> => ({
  schema,
  required: false,
  parse: (value, at) => value == null ? undefined : parse(value, at),
});

export const map = <T, U>({ schema, required, parse }: Field<T>, f: (value: T) => U): Field<U> => ({
  schema,
  required,
  parse: (value, at) => f(parse(value, at)),
});

function mapValues<V, U>(record: { readonly [key: string]: V }, f: (value: V, key: string) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value, key)]));
}
