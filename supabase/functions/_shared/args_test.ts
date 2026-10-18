import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { array, boolean, integer, InvalidArgs, map, number, object, oneOf, optional, string, uuid } from "./args.ts";

const ID = "11111111-1111-4111-8111-111111111111";

const input = object({
  limit: integer({ minimum: 1, maximum: 50, default: 20, description: "How many." }),
  query: string({ minLength: 1, maxLength: 5 }),
  parent: optional(map(string({}, { maxLength: 10 }), (s) => s.toLowerCase())),
  status: oneOf({ enum: ["open", "closed"], default: "open" }),
  flag: boolean({ default: false }),
  examples: array(object({ link_id: uuid(), p: number({ exclusiveMinimum: 0, maximum: 1, default: 1 }) }), {
    minItems: 1,
    maxItems: 2,
  }),
});

Deno.test("an object's schema is its fields' schemas as written, required ones listed", () => {
  assertEquals(JSON.stringify(input.schema), JSON.stringify({
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "How many." },
      query: { type: "string", minLength: 1, maxLength: 5 },
      parent: { type: "string" },
      status: { type: "string", enum: ["open", "closed"], default: "open" },
      flag: { type: "boolean", default: false },
      examples: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            link_id: { type: "string" },
            p: { type: "number", exclusiveMinimum: 0, maximum: 1, default: 1 },
          },
          required: ["link_id"],
        },
      },
    },
    required: ["query", "examples"],
  }));
});

Deno.test("parsing fills defaults, trims, maps and leaves optional fields out", () => {
  const args: {
    limit: number;
    query: string;
    parent: string | undefined;
    status: "open" | "closed";
    flag: boolean;
    examples: { link_id: string; p: number }[];
  } = input.parse({ query: " hi ", parent: "AI", limit: null, examples: [{ link_id: ID }] }, "");
  // @ts-expect-error: the parsed types are inferred from the fields, not any.
  const _limit: string = args.limit;
  assertEquals(args, {
    limit: 20,
    query: "hi",
    parent: "ai",
    status: "open",
    flag: false,
    examples: [{ link_id: ID, p: 1 }],
  });
  assertEquals(input.parse({ query: "x", parent: null, examples: [{ link_id: ID }] }, "").parent, undefined);
});

Deno.test("a value outside its schema is refused, named by its path", () => {
  const refused = (value: unknown, message: string) =>
    assertThrows(() => input.parse({ query: "x", examples: [{ link_id: ID }], ...(value as object) }, ""), InvalidArgs, message);
  refused({ limit: 51 }, "limit must be an integer from 1 to 50");
  refused({ limit: 1.5 }, "limit must be an integer from 1 to 50");
  refused({ query: "  " }, "query must be a non-empty string of at most 5 characters");
  refused({ query: "toolong" }, "query must be a non-empty string of at most 5 characters");
  refused({ parent: "x".repeat(11) }, "parent must be a non-empty string of at most 10 characters");
  refused({ status: "gone" }, "status must be one of open, closed");
  refused({ flag: "yes" }, "flag must be true or false");
  refused({ examples: [] }, "examples must list 1-2 items");
  refused({ examples: [{ link_id: "x" }] }, "examples[0].link_id must be an id (a UUID)");
  refused({ examples: [{ link_id: ID }, { link_id: ID, p: 0 }] }, "examples[1].p must be a number in (0, 1]");
  assertThrows(() => string({ minLength: 2, maxLength: 4 }).parse(" a ", "name"), InvalidArgs, "name must be a string of 2 to 4 characters");
});

Deno.test("a missing or non-object value reads as an object without fields", () => {
  const defaults = object({ limit: integer({ minimum: 0, default: 0 }) });
  assertEquals(defaults.parse(undefined, ""), { limit: 0 });
  assertEquals(defaults.parse("x", ""), { limit: 0 });
  assertEquals(defaults.schema, { type: "object", properties: { limit: { type: "integer", minimum: 0, default: 0 } } });
});

Deno.test("a uuid is strict unless it is read as a trimmed string first", () => {
  const strict = uuid();
  const padded = uuid({}, { trimmedTo: 40 });
  assertThrows(() => strict.parse(` ${ID} `, "id"), InvalidArgs, "id must be an id (a UUID)");
  assertEquals(padded.parse(` ${ID} `, "id"), ID);
  assertThrows(() => padded.parse(`${ID}${" ".repeat(5)}`, "id"), InvalidArgs, "id must be a non-empty string of at most 40 characters");
  assertThrows(() => padded.parse(undefined, "id"), InvalidArgs, "id must be a non-empty string of at most 40 characters");
  assertThrows(() => padded.parse(" abc ", "id"), InvalidArgs, "id must be an id (a UUID)");
  assertEquals(padded.schema, { type: "string" });
});
