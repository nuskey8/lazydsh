import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { detailDiff, detailText, prettyArguments, readFileDiffs } from "../src/detail.ts";

test("tool arguments pretty-print when valid and stay readable when partial", () => {
  assert.equal(
    prettyArguments('{"path":"a.ts","limit":2}'),
    '{\n  "path": "a.ts",\n  "limit": 2\n}',
  );
  assert.equal(prettyArguments(""), "(no arguments)");
  assert.equal(prettyArguments('{"path":'), '{"path":');
  assert.equal(prettyArguments('"plain"'), "plain");
});

test("only well-formed diff metadata is surfaced", () => {
  assert.equal(readFileDiffs(undefined), undefined);
  assert.equal(readFileDiffs({}), undefined);
  assert.equal(readFileDiffs({ diffs: [] }), undefined);
  assert.equal(
    readFileDiffs({ diffs: [{ path: "a.ts", oldText: null, newText: "a" }] })?.[0]?.path,
    "a.ts",
  );
  assert.equal(readFileDiffs({ diffs: [{ path: "a.ts", oldText: 1, newText: "a" }] }), undefined);
});

test("detail text is indented, wrapped, and capped", () => {
  const text = "first\nsecond\n".repeat(500);
  const lines = detailText(text, 40);
  assert.ok(lines.length > 1 && lines.length <= 401);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
  assert.ok(lines.every((line) => stripVTControlCharacters(line).startsWith("  │")));
  assert.ok(lines.some((line) => stripVTControlCharacters(line).includes("lines omitted")));
  assert.ok(detailText("a".repeat(10_000), 20).every((line) => visibleWidth(line) <= 20));
});

test("diffs mark added, removed and context lines", () => {
  const lines = detailDiff(
    [{ path: "src/main.ts", oldText: "keep\nold", newText: "keep\nnew" }],
    80,
  ).map((line) => stripVTControlCharacters(line));
  assert.ok(lines.some((line) => line.includes("Diff src/main.ts")));
  assert.ok(lines.some((line) => line.includes("  keep")));
  assert.ok(lines.some((line) => line.includes("- old")));
  assert.ok(lines.some((line) => line.includes("+ new")));
  assert.ok(
    detailDiff([{ path: "new.ts", oldText: null, newText: "one\ntwo" }], 80)
      .map((line) => stripVTControlCharacters(line))
      .every((line) => !line.includes("- ")),
  );
});
