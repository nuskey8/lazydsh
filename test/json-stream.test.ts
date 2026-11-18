import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  MAX_STRING_BYTES,
  ReportedJsonError,
  boundJsonLine,
  openJsonProjection,
} from "../src/json-stream.ts";

function capture() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => lines.push(chunk) };
}

function event(type: string, data: unknown, surfaceOp?: string) {
  return {
    type,
    seq: 1,
    time: 0,
    data,
    ...(surfaceOp ? { surfaceOp } : {}),
  } as unknown as SessionEvent;
}

function assistantMessage(
  text: string,
  options: { reasoning?: string; usage?: Record<string, number> } = {},
) {
  return event("assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id: "message-1",
      role: "assistant",
      source: { kind: "model" },
      content: [
        ...(options.reasoning === undefined
          ? []
          : [{ type: "reasoning", text: options.reasoning }]),
        { type: "text", text },
      ],
    },
    stream: [],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
}

test("projects committed session events as newline-delimited JSON", () => {
  const output = capture();
  const projection = openJsonProjection("session-1", "/work", output);
  projection.event("session-1", event("turn/start", { turn: 1 }));
  projection.event("session-1", event("step/start", { turn: 1, step: 1 }));
  projection.event("session-1", assistantMessage("hello", { reasoning: "think" }));
  projection.event("session-1", event("step/end", { turn: 1, step: 1 }));
  projection.event("session-1", event("turn/end", { turn: 1, reason: { kind: "completed" } }));
  projection.event("session-2", assistantMessage("leaked"));
  projection.finish("hello", { kind: "completed" });

  assert.deepEqual(
    output.lines.map((line) => JSON.parse(line)),
    [
      { type: "session", sessionId: "session-1", cwd: "/work" },
      { type: "status", phase: "turn_start", turn: 1 },
      { type: "status", phase: "step_start", turn: 1, step: 1 },
      { type: "thinking", text: "think" },
      { type: "text", text: "hello" },
      { type: "status", phase: "step_end", turn: 1, step: 1 },
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
      { type: "final", sessionId: "session-1", reason: { kind: "completed" }, text: "hello" },
    ],
  );
});

test("projects tool calls, results, and step usage", () => {
  const output = capture();
  const projection = openJsonProjection("session-1", "/work", output);
  projection.event(
    "session-1",
    event("assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [
        {
          type: "chunk",
          time: 0,
          chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
        },
      ],
    }),
  );
  projection.event(
    "session-1",
    assistantMessage("calling", { usage: { inputTokens: 2, outputTokens: 3 } }),
  );
  projection.event("session-1", event("step/end", { turn: 1, step: 1 }));
  projection.event(
    "session-1",
    event(
      "tool/call",
      { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"command":"ls"}' },
      "append",
    ),
  );
  projection.event(
    "session-1",
    event(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: {
          id: "message-2",
          role: "tool",
          source: { kind: "tool", callId: "call-1" },
          toolCallId: "call-1",
          content: [{ type: "text", text: "ok" }],
        },
      },
      "append",
    ),
  );

  const projected = output.lines.map((line) => JSON.parse(line));
  assert.deepEqual(projected[2], {
    type: "status",
    phase: "step_end",
    turn: 1,
    step: 1,
    usage: { inputTokens: 3, outputTokens: 4 },
  });
  assert.deepEqual(projected[3], {
    type: "tool_call",
    callId: "call-1",
    tool: "bash",
    input: { command: "ls" },
  });
  assert.deepEqual(projected[4], {
    type: "tool_result",
    callId: "call-1",
    status: "completed",
    result: "ok",
  });
});

test("bounds oversized projected payloads", () => {
  const parsed = JSON.parse(
    boundJsonLine({ type: "text", text: "x".repeat(MAX_STRING_BYTES + 10) }),
  );
  assert.equal(parsed.truncated, true);
  assert.equal(Buffer.byteLength(parsed.text, "utf8"), MAX_STRING_BYTES);
});

test("stops projecting after dispose and marks reported failures", () => {
  const output = capture();
  const projection = openJsonProjection("session-1", "/work", output);
  projection.dispose();
  projection.event("session-1", assistantMessage("ignored"));
  projection.finish("ignored");
  assert.equal(output.lines.length, 1);
  assert.equal(new ReportedJsonError("failed").jsonReported, true);
});
