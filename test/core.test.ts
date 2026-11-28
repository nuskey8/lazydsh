import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { validateRoute } from "../src/catalog.ts";
import { isAuthFailure } from "../src/runtime-events.ts";
import {
  canRunDuringTurn,
  notificationChannel,
  shouldQueueDuringTurn,
  turnNotification,
} from "../src/ui.ts";
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

test("notification channels follow Codex terminal detection", () => {
  for (const env of [
    { TERM_PROGRAM: "iTerm.app" },
    { TERM_PROGRAM: "WezTerm" },
    { TERM_PROGRAM: "WarpTerminal" },
    { TERM_PROGRAM: "ghostty" },
    { TERM: "xterm-kitty" },
    { KITTY_WINDOW_ID: "1" },
  ])
    assert.equal(notificationChannel(env), "osc9", JSON.stringify(env));
  for (const env of [
    { TERM_PROGRAM: "zed" },
    { TERM_PROGRAM: "Apple_Terminal" },
    { TERM_PROGRAM: "vscode" },
    { TERM: "xterm-256color" },
    { TERM_PROGRAM: "iTerm.app", STY: "1234.pts-0.host" },
  ])
    assert.equal(notificationChannel(env), "bel", JSON.stringify(env));
  assert.equal(
    notificationChannel({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux-501/default,1,0" }),
    "tmux",
  );
});

test("turn completion uses OSC 9, tmux passthrough, or BEL notifications", () => {
  assert.equal(turnNotification("osc9"), "\x1b]9;lazydsh: turn complete\x07");
  assert.equal(turnNotification("bel"), "\x07");
  assert.equal(turnNotification("tmux"), "\x1bPtmux;\x1b\x1b]9;lazydsh: turn complete\x07\x1b\\");
});
