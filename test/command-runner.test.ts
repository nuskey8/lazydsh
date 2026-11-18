import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { runCommand } from "../src/command-runner.ts";
import type { Callbacks, Runtime } from "../src/runtime.ts";

test("ask cancels and fails rather than waiting for human approval or questions", async () => {
  for (const question of [false, true]) {
    let callbacks: Callbacks = {};
    let cancelled = 0,
      closed = 0;
    const output = vi.spyOn(process.stdout, "write");
    const runtime = {
      open: async (_route: unknown, next: Callbacks) => {
        callbacks = next;
      },
      run: async () => {
        if (question)
          await callbacks.onUserQuestion!(
            { questions: [] },
            { signal: new AbortController().signal },
          );
        else await callbacks.onApproval!({ toolName: "test" });
        return { finishReason: "aborted", finalResponse: "" };
      },
      cancel: async () => {
        cancelled++;
      },
      close: async () => {
        closed++;
      },
    } as unknown as Runtime;
    try {
      await assert.rejects(
        runCommand(
          runtime,
          { command: "ask", provider: "test", model: "test", prompt: "hello" },
          new AbortController().signal,
        ),
        question ? /Interactive questions/ : /Approval is required/,
      );
      assert.equal(cancelled, 1);
      assert.equal(closed, 1);
      assert.equal(output.mock.calls.length, 0);
    } finally {
      output.mockRestore();
    }
  }
});

test("ask --json emits the event stream and reports a failed turn once", async () => {
  const events = [
    { type: "turn/start", seq: 1, time: 0, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "message-1",
          role: "assistant",
          source: { kind: "model" },
          content: [{ type: "text", text: "partial" }],
        },
        stream: [],
      },
    },
    {
      type: "turn/end",
      seq: 3,
      time: 0,
      data: { turn: 1, reason: { kind: "error", error: { code: "PROVIDER", message: "boom" } } },
    },
  ];
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  let closed = 0;
  const runtime = {
    open: async () => "session-1",
    get session() {
      return { header: { cwd: "/work" } };
    },
    run: async (_prompt: string, onEvent?: (event: unknown) => void) => {
      for (const event of events)
        onEvent?.({
          method: "session.event",
          params: { sessionId: "session-1", event },
        });
      return {
        sessionId: "session-1",
        finalResponse: "partial",
        finishReason: "error",
        events,
      };
    },
    close: async () => {
      closed++;
    },
  } as unknown as Runtime;
  try {
    const error = await runCommand(
      runtime,
      { command: "ask", provider: "test", model: "test", prompt: "hello", json: true },
      new AbortController().signal,
    ).then(
      () => assert.fail("expected the failed turn to reject"),
      (error: unknown) => error as { jsonReported?: boolean; message: string },
    );
    assert.equal(error.jsonReported, true);
    assert.equal(error.message, "boom");
    assert.equal(closed, 1);
    const projected = output.mock.calls.map((call) => JSON.parse(String(call[0])));
    assert.deepEqual(projected[0], { type: "session", sessionId: "session-1", cwd: "/work" });
    assert.deepEqual(projected[1], { type: "status", phase: "turn_start", turn: 1 });
    assert.deepEqual(projected[2], { type: "text", text: "partial" });
    assert.deepEqual(projected[3], {
      type: "status",
      phase: "turn_end",
      turn: 1,
      reason: { kind: "error", error: { code: "PROVIDER", message: "boom" } },
    });
    assert.deepEqual(projected[4], {
      type: "final",
      sessionId: "session-1",
      reason: { kind: "error", error: { code: "PROVIDER", message: "boom" } },
      text: "partial",
    });
  } finally {
    output.mockRestore();
  }
});
