import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { validateRoute } from "../src/catalog.ts";
import { isAuthFailure } from "../src/runtime.ts";
import { canRunDuringTurn, shouldQueueDuringTurn } from "../src/ui.ts";
import { formatNotification, safeText } from "../src/theme.ts";

test("route validation allows configured providers and rejects missing models", () => {
  assert.throws(() => validateRoute("typo", "model"));
  assert.deepEqual(validateRoute("codex", "gpt-test"), {
    provider: "openai-codex",
    model: "gpt-test",
  });
  assert.throws(() => validateRoute("opencode", ""));
  assert.deepEqual(validateRoute("custom", "model", ["patch.yml"]), {
    provider: "custom",
    model: "model",
  });
});

test("authentication failures are distinguished from routing and network errors", () => {
  assert.equal(isAuthFailure({ code: "AUTH", message: "Unauthorized" }), true);
  assert.equal(
    isAuthFailure(Object.assign(new Error("Login required"), { code: "UNAUTHORIZED" })),
    true,
  );
  assert.equal(isAuthFailure(Object.assign(new Error("Login required"), { status: 401 })), true);
  assert.equal(isAuthFailure(new Error("Connection refused")), false);
  assert.equal(isAuthFailure(null), false);
  assert.equal(
    isAuthFailure({ code: "PI_AI_ERROR", message: "Provider is not configured: opencode-go" }),
    true,
  );
  assert.equal(isAuthFailure({ code: "INVALID_REQUEST", message: "Missing session ID" }), false);
  assert.equal(isAuthFailure({ code: "TRANSPORT", message: "Connection refused" }), false);
});

test("terminal control sequences are removed from displayed text", () => {
  assert.equal(safeText("\x1b[2Jhello\x1b]52;c;YWJj\x07\n日本語\r"), "hello\n日本語");
});

test("running turns allow inspection and settings while rejecting concurrent messages and session switches", () => {
  for (const command of [
    "/status",
    "/ps",
    "/stop",
    "/stop bash-test",
    "/session",
    "/plan",
    "/plan off",
    "/permission",
    "/effort high",
    "/cd",
    "/quit",
  ])
    assert.equal(canRunDuringTurn(command), true, command);
  for (const input of [
    "hello",
    "/model",
    "/new",
    "/clear",
    "/resume",
    "/sessions",
    "/rename",
    "/fork",
    "/archive",
    "/restore",
    "/pin",
    "/unpin",
    "/compact",
    "/statusanything",
    "/mode",
    "/plan write a plan",
  ])
    assert.equal(canRunDuringTurn(input), false, input);
});

test("plain prompts typed during a running turn are queued while commands stay immediate", () => {
  for (const input of ["hello", "  keep going", "review @src/main.ts", "続けて"])
    assert.equal(shouldQueueDuringTurn(input), true, input);
  for (const input of ["/status", "/model", "  /dsh status", "", "   "])
    assert.equal(shouldQueueDuringTurn(input), false, input);
});

test("notifications without a message show only the label", () => {
  assert.equal(formatNotification("Interrupted", "", false), "✓ interrupted");
  assert.equal(formatNotification("Error", "Failed", false), "✗ error: Failed");
});
