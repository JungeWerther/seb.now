import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { InvalidArgs } from "./args.ts";
import { STYLE_TYPES } from "./constants.ts";
import { styleTypeName, styleValues, tokensOf } from "./style_args.ts";

const values = styleValues("Token values.");

Deno.test("token values pass through as given", () => {
  assertEquals(
    values.parse({ color_page: "#ebedf1", block_line: "0", font_body: "\"Inter\", sans-serif", weight: 400 }, "style"),
    { color_page: "#ebedf1", block_line: "0", font_body: "\"Inter\", sans-serif", weight: 400 },
  );
});

Deno.test("a value that could leave its declaration is refused", () => {
  for (
    const bad of [
      "url(https://evil.example/x.png)",
      "red; background: red",
      "#fff}body{display:none",
      "\\66 oo",
      "</style><script>",
      "#fff\n",
      "#fff\u0000",
    ]
  ) {
    assertThrows(() => values.parse({ color_page: bad }, "style"), InvalidArgs, "may not contain");
  }
});

Deno.test("a value must be a short string or a finite number", () => {
  for (const bad of [null, true, [], {}, "", "x".repeat(STYLE_TYPES.MAX_TOKEN_VALUE_LENGTH + 1), Infinity, NaN]) {
    assertThrows(() => values.parse({ color_page: bad }, "style"), InvalidArgs, "style.color_page");
  }
});

Deno.test("token names are lowercase identifiers", () => {
  for (const bad of ["Color", "--color-page", "color-page", "1st", "__proto__x", "a".repeat(65)]) {
    assertThrows(() => values.parse({ [bad]: "#ffffff" }, "style"), InvalidArgs, "isn't a token name");
  }
});

Deno.test("values must be an object of at most MAX_TOKENS tokens", () => {
  for (const bad of [null, "x", [], 3]) assertThrows(() => values.parse(bad, "style"), InvalidArgs, "JSON object");
  const many = Object.fromEntries(Array.from({ length: STYLE_TYPES.MAX_TOKENS + 1 }, (_, i) => [`t${i}`, "0"]));
  assertThrows(() => values.parse(many, "style"), InvalidArgs, "more than");
});

Deno.test("type names are 2-32 lowercase letters, digits or underscores", () => {
  assertEquals(styleTypeName.parse("palette", "type"), "palette");
  for (const bad of ["p", "Palette", "entity.style.palette", "a-b", "x".repeat(33)]) {
    assertThrows(() => styleTypeName.parse(bad, "type"), InvalidArgs);
  }
});

Deno.test("a type's tokens read back as what each takes", () => {
  assertEquals(
    tokensOf({
      properties: {
        color_page: { $ref: "#/$defs/color", description: "The page" },
        align: { enum: ["left", "center"] },
      },
    }),
    { color_page: { takes: "color", description: "The page" }, align: { takes: ["left", "center"] } },
  );
});
