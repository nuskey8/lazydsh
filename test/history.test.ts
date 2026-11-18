import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { accent } from "../src/theme.ts";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { historyRows, continuationCommand } from "../src/history.ts";
import { ToolRow } from "../src/tools.ts";
import { ThinkingView } from "../src/presentation.ts";

test("saved history restores prompts, replies and collapsed tool results in order", () => {
  const events = [
    { type: "turn/start", time: 1000, data: {} },
    {
      type: "user/message",
      time: 1000,
      data: { source: { kind: "user" }, content: [{ type: "text", text: "read file" }] },
    },
    { type: "step/start", time: 1000, data: {} },
    {
      type: "tool/call",
      time: 1200,
      data: { callId: "a", name: "read", arguments: '{"path":"file.ts"}' },
    },
    {
      type: "tool/result",
      time: 1500,
      data: {
        message: { toolCallId: "a", content: [{ type: "text", text: "private file contents" }] },
      },
    },
    {
      type: "assistant/message",
      time: 2000,
      data: {
        message: {
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "answer" },
          ],
        },
        usage: { inputTokens: 2, outputTokens: 13 },
        stream: [],
      },
    },
    { type: "turn/end", time: 3000, data: {} },
  ] as unknown as SessionEvent[];
  const rows = historyRows(events, "session");
  assert.deepEqual(rows[0], { kind: "user", text: "read file" });
  assert.ok(rows[1] instanceof ToolRow);
  assert.equal(rows[1].summary, "✓ read file.ts");
  assert.ok(rows[2] instanceof ThinkingView);
  assert.equal(rows[2].hasReasoning, true);
  assert.match(rows[2].render(80).map(stripVTControlCharacters).join("\n"), /✓ Thinking \(1s\)/);
  assert.deepEqual(rows[3], { kind: "assistant", text: "answer" });
  assert.deepEqual(rows[4], { kind: "metrics", text: "2s (↑2 ↓13)" });
  const collapsed = rows
    .flatMap((row) => (row instanceof ToolRow ? row.render(80) : []))
    .map(stripVTControlCharacters)
    .join("\n");
  assert.ok(!collapsed.includes("private file contents"));
  const large = structuredClone(events);
  const reply = large.find((event) => event.type === "assistant/message")!;
  if (reply.type === "assistant/message")
    reply.data.usage = { inputTokens: 1200, cacheReadTokens: 300, outputTokens: 3200000 };
  assert.deepEqual(historyRows(large, "session").at(-1), {
    kind: "metrics",
    text: "2s (↑1.5K ↓3.2M)",
  });
});

test("continuation indents the command and highlights its quoted session ID", () => {
  assert.equal(
    stripVTControlCharacters(continuationCommand("session-id")),
    "Continue session with:\n  lazydsh resume session-id",
  );
  assert.equal(
    stripVTControlCharacters(continuationCommand("session-id", ["--home", "/path with spaces"])),
    "Continue session with:\n  lazydsh resume session-id --home '/path with spaces'",
  );
  assert.ok(continuationCommand("session-id").includes(accent("session-id")));
  assert.ok(continuationCommand("session'id").includes(accent("'session'\\''id'")));
});

test("resume hides internal user-role messages by source without stripping actual user text", () => {
  const message = (kind: string | undefined, text: string) => ({
    type: "user/message",
    time: 1000,
    data: { ...(kind ? { source: { kind } } : {}), content: [{ type: "text", text }] },
  });
  const events = [
    message("agent-instructions", "<system-reminder>Read instructions</system-reminder>"),
    message("working-directory", "Internal cwd transition"),
    message("goal", "Internal goal reminder"),
    message("compaction", "Internal summary"),
    message("schedule", "Scheduled internal prompt"),
    message("unrecognized-plugin", "Internal plugin text"),
    message(undefined, "Unknown origin"),
    message("user", "Explain <system-reminder> in this file"),
  ] as unknown as SessionEvent[];
  assert.deepEqual(historyRows(events, "session"), [
    { kind: "user", text: "Explain <system-reminder> in this file" },
  ]);
});

test("internal-only turns do not leave orphaned duration rows on resume", () => {
  const events = [
    { type: "turn/start", time: 1000, data: {} },
    {
      type: "user/message",
      time: 1000,
      data: {
        source: { kind: "agent-instructions" },
        content: [{ type: "text", text: "internal" }],
      },
    },
    { type: "step/start", time: 1000, data: {} },
    { type: "turn/end", time: 2000, data: {} },
  ] as unknown as SessionEvent[];
  assert.deepEqual(historyRows(events, "session"), []);
});

test("history keeps one Thinking row per assistant step around tool calls", () => {
  const assistant = (reasoning: string, text: string, time: number) => ({
    type: "assistant/message",
    time,
    data: {
      message: {
        content: [
          { type: "reasoning", text: reasoning },
          { type: "text", text },
        ],
      },
      stream: [],
    },
  });
  const events = [
    { type: "turn/start", time: 1000, data: {} },
    {
      type: "user/message",
      time: 1000,
      data: { source: { kind: "user" }, content: [{ type: "text", text: "inspect" }] },
    },
    { type: "step/start", time: 1000, data: {} },
    assistant("first thought", "reading", 1200),
    {
      type: "tool/call",
      time: 1300,
      data: { callId: "a", name: "read", arguments: '{"path":"a.ts"}' },
    },
    {
      type: "tool/result",
      time: 1400,
      data: { message: { toolCallId: "a", content: [{ type: "text", text: "contents" }] } },
    },
    {
      type: "tool/call",
      time: 1500,
      data: { callId: "b", name: "glob", arguments: '{"pattern":"**/*.ts"}' },
    },
    {
      type: "tool/result",
      time: 1600,
      data: { message: { toolCallId: "b", content: [{ type: "text", text: "a.ts" }] } },
    },
    assistant("second thought", "done", 1800),
    { type: "turn/end", time: 2000, data: {} },
  ] as unknown as SessionEvent[];
  const rows = historyRows(events, "session");
  const kinds = rows.map((row) =>
    row instanceof ThinkingView ? "thinking" : row instanceof ToolRow ? "tool" : row.kind,
  );
  assert.deepEqual(kinds, [
    "user",
    "thinking",
    "assistant",
    "tool",
    "tool",
    "thinking",
    "assistant",
    "metrics",
  ]);
});

test("resumed prompts keep attachment names instead of placeholders", () => {
  const events = [
    {
      type: "user/message",
      time: 1000,
      data: {
        source: { kind: "user" },
        content: [
          { type: "text", text: "Review these" },
          {
            type: "image",
            attachment: {
              attachmentId: "image-id",
              mediaType: "image/png",
              bytes: 128,
              width: 64,
              height: 32,
              name: "shot.png",
            },
          },
          {
            type: "file",
            attachment: { attachmentId: "file-id", name: "notes.pdf", bytes: 2048 },
          },
        ],
      },
    },
  ] as unknown as SessionEvent[];
  const row = historyRows(events, "session")[0];
  assert.ok(row && !(row instanceof ToolRow) && !(row instanceof ThinkingView));
  assert.equal(row.kind, "user");
  assert.equal(row.text, "Review these");
  assert.deepEqual(row.attachments, [
    { name: "shot.png", kind: "image", detail: "128 B · 64×32" },
    { name: "notes.pdf", kind: "file", detail: "2 KB" },
  ]);
});
