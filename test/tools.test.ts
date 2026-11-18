import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolLog } from "../src/tools.ts";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { eventText } from "../src/runtime.ts";

function emit(log: ToolLog, type: string, data: unknown, sessionId = "root") {
  const output = eventText({
    method: "session.event",
    params: { sessionId, event: { type, data } as SessionEvent },
  });
  assert.ok(output && output.kind !== "assistant");
  return log.record(output);
}
const call = (id: string, path: string) => ({
  name: "read",
  callId: id,
  arguments: JSON.stringify({ path }),
});
const result = (id: string, text: string, isError = false) => ({
  message: { toolCallId: id, isError, content: [{ type: "text", text }] },
});

test("large read output updates one collapsed row without dumping arguments or contents", () => {
  const log = new ToolLog();
  const row = emit(log, "tool/call", call("a", "src/main.ts"));
  assert.ok(row);
  assert.equal(String(row.summary), "· read src/main.ts");
  const contents = "private file contents\n".repeat(10000);
  assert.equal(emit(log, "tool/result", result("a", contents)), undefined);
  assert.equal(String(row.summary), "✓ read src/main.ts");
  assert.ok(!row.summary.includes(contents));
  assert.equal(log.entries.size, 0);
  for (const width of [1, 20, 80]) {
    assert.equal(row.render(width).length, 1);
    assert.ok(visibleWidth(row.render(width)[0]) <= width);
  }
});

test("interleaved root and child calls stay paired; empty success and errors are visible", () => {
  const log = new ToolLog();
  const root = emit(log, "tool/call", call("a", "root.txt"));
  const child = emit(log, "tool/call", call("a", "child.txt"), "child");
  emit(log, "tool/result", result("a", ""));
  emit(log, "tool/result", result("a", "permission denied\nlong details", true), "child");
  assert.equal(root?.summary, "✓ read root.txt");
  assert.equal(child?.summary, "✗ read child.txt — permission denied");
  assert.equal(log.entries.size, 0);
});

function mouse(type: TuiMouseEvent["type"], y = 0, width = 80): TuiMouseEvent {
  return {
    type,
    button: "left",
    x: 0,
    y,
    screenX: 0,
    screenY: y,
    width,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test("clicking a tool row expands arguments, output and the applied diff", () => {
  const log = new ToolLog();
  const row = emit(log, "tool/call", {
    name: "edit",
    callId: "a",
    arguments: JSON.stringify({ file_path: "src/main.ts", old_string: "a\nb", new_string: "a\nc" }),
  });
  assert.ok(row);
  emit(log, "tool/result", {
    message: {
      toolCallId: "a",
      content: [{ type: "text", text: "Success. Updated src/main.ts." }],
    },
    meta: {
      diffs: [{ path: "src/main.ts", oldText: "a\nb", newText: "a\nc" }],
    },
  });

  assert.equal(row.render(80).length, 1);
  const header = stripVTControlCharacters(row.render(80)[0]!).trimEnd();
  assert.equal(header, "  ✓ edit src/main.ts");
  row.handleMouse(mouse("press"));
  row.handleMouse(mouse("click"));
  const lines = row.render(80).map(stripVTControlCharacters);
  assert.equal(lines[0]!.trimEnd(), header);
  assert.equal(lines[1]!.indexOf("│"), lines[0]!.indexOf("✓"));
  assert.doesNotMatch(lines.join("\n"), /[▸▾]/);
  assert.ok(lines.length > 1);
  assert.ok(lines.some((line) => line.includes("Arguments")));
  assert.ok(lines.some((line) => line.includes('"file_path": "src/main.ts"')));
  assert.ok(lines.some((line) => line.includes("Success. Updated src/main.ts.")));
  assert.ok(lines.some((line) => /- b/.test(line)));
  assert.ok(lines.some((line) => /\+ c/.test(line)));
  assert.ok(lines.slice(1).every((line) => line.startsWith("  │")));
  for (const width of [20, 48, 80])
    assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));

  row.handleMouse(mouse("press"));
  row.handleMouse(mouse("click"));
  assert.equal(row.render(80).length, 1);
});

test("expanded output is indented and bounded for very large results", () => {
  const log = new ToolLog();
  const row = emit(log, "tool/call", call("a", "src/main.ts"));
  assert.ok(row);
  emit(log, "tool/result", result("a", "line\n".repeat(5000)));
  row.handleMouse(mouse("click"));
  const lines = row.render(80);
  assert.ok(lines.length > 1 && lines.length < 450);
  assert.ok(lines.some((line) => stripVTControlCharacters(line).includes("lines omitted")));
  assert.ok(lines.slice(1).every((line) => stripVTControlCharacters(line).startsWith("  │")));
  for (const width of [1, 20, 80])
    assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
});

test("mouse clicks outside the header do not toggle details", () => {
  const log = new ToolLog();
  const row = emit(log, "tool/call", call("a", "src/main.ts"));
  assert.ok(row);
  row.setCall('{"path":"src/main.ts"}');
  assert.equal(row.handleMouse(mouse("click", 1)), undefined);
  assert.equal(row.isExpanded, false);
});
