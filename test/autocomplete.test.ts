import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { Autocomplete } from "../src/autocomplete.ts";

test("@ completion combines native references and preserves quoted paths, skills, and subagent text", async () => {
  const queries: string[] = [];
  const items = [
    { value: '@"folder with spaces/file.ts"', label: "@folder with spaces/file.ts" },
    { value: "@src/", label: "@src/" },
    { value: "/test-skill", label: "@skill:test-skill" },
    { value: "@worker", label: "@worker", description: "Subagent" },
  ];
  const provider = new Autocomplete(
    [{ name: "ps", description: "List jobs" }],
    process.cwd(),
    async (query) => {
      queries.push(query);
      return items;
    },
  );
  const options = { signal: new AbortController().signal };
  const line = 'Read @"folder with';
  const suggestions = await provider.getSuggestions([line], 0, line.length, options);
  assert.equal(suggestions?.prefix, '@"folder with');
  assert.deepEqual(queries, ["folder with"]);
  assert.deepEqual(suggestions?.items, items);
  assert.ok(
    (await provider.getSuggestions(["/p"], 0, 2, options))?.items.some(
      (item) => item.value === "ps",
    ),
  );
  await provider.getSuggestions(["user@example.com"], 0, 16, options);
  assert.equal(queries.length, 1);
  assert.equal(await provider.getSuggestions(["@"], 0, 1, { signal: AbortSignal.abort() }), null);
});

test("@ image selections attach instead of inserting a text reference", async () => {
  const attached: string[] = [];
  const provider = new Autocomplete([], process.cwd(), async () => [
    { value: "@shot.png", label: "@shot.png", description: "file", path: "shot.png" },
    { value: "@src/main.ts", label: "@src/main.ts", description: "file", path: "src/main.ts" },
  ]);
  provider.onAttach = (path) => attached.push(path);
  const signal = new AbortController().signal;
  const line = "look at @shot";
  const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
  assert.ok(suggestions);
  const image = suggestions.items.find((item) => item.value === "@shot.png");
  assert.ok(image);
  assert.match(image.description ?? "", /attach/);
  const result = provider.applyCompletion([line], 0, line.length, image, suggestions.prefix);
  assert.deepEqual(attached, ["shot.png"]);
  assert.equal(result.lines[0], "look at ");
  assert.equal(result.cursorCol, 8);

  const file = suggestions.items.find((item) => item.value === "@src/main.ts");
  assert.ok(file);
  const inserted = provider.applyCompletion([line], 0, line.length, file, suggestions.prefix);
  assert.equal(inserted.lines[0], "look at @src/main.ts ");
});
