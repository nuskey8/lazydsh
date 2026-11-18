import { ToolRow } from "../src/tools.ts";
import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  Container,
  ProcessTerminal,
  TuiMainScreen,
  Text,
  visibleWidth,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import {
  StartupBanner,
  StatusPanel,
  PromptEditor,
  SentMessage,
  QueuedMessage,
  QueueView,
  Notification,
  SecretInput,
  Transcript,
  ThinkingView,
  editorBorder,
} from "../src/presentation.ts";

const identity = (text: string) => text;
const theme = {
  borderColor: editorBorder,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

test("startup whale stays within narrow and wide terminal widths using DeepSeek blue", () => {
  const banner = new StartupBanner();
  for (const width of [1, 20, 48, 63, 64, 80, 120]) {
    const lines = banner.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `overflow at ${width}`,
    );
    assert.ok(lines.join("\n").includes("\x1b[38;2;77;107;254m"));
  }
  assert.match(banner.render(80).join("\n"), /lazydsh/);
});

test("shell prompt removes only editor borders, preserving multiline input and cursor", () => {
  const editor = new PromptEditor(new TuiMainScreen(new ProcessTerminal()), theme);
  editor.focused = true;
  editor.setText("日本語\nsecond line");
  for (const width of [1, 2, 6, 20, 80]) {
    const lines = editor.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `overflow at ${width}`,
    );
    assert.ok(lines.every((line) => !line.includes("\0border:")));
  }
  const text = editor.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(text, /┃ 日本語/);
  assert.match(text, /┃ second line/);
  assert.doesNotMatch(text, /─/);
  assert.equal(editor.getText(), "日本語\nsecond line");
});

test("status uses gray labels and numeric cache hits and fits narrow terminals", () => {
  const panel = new StatusPanel({
    context: { projectedTokens: 500, contextWindow: 1000 },
    latest: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 50 },
  });
  for (const width of [20, 48, 80])
    assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
  const output = panel.render(80).join("\n");
  assert.ok(output.includes("\x1b[38;2;160;166;172mContext window:"));
  assert.doesNotMatch(output, /[█░]/);
  assert.ok(!output.includes("\x1b[38;2;77;107;254m"));
  const lines = panel.render(80).map(stripVTControlCharacters);
  assert.match(lines.join("\n"), /50% left \(500 used \/ 1K\)/);
  const context = lines.find((line) => line.includes("Context window:"))!;
  const cache = lines.find((line) => line.includes("Cache hit:"))!;
  assert.equal(context.indexOf("50%"), cache.indexOf("50.0%"));
  panel.updateStats({ limits: { plan: "plus", windows: [] } });
  const updated = panel.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(updated, /Plan: +plus/);
  assert.doesNotMatch(updated, /Context window:|Cache hit:/);
});

test("sent messages keep the prompt rail on wrapped and multiline text", () => {
  const message = new SentMessage(
    "hello\n日本語 and a longer message that wraps across several rows",
  );
  for (const width of [1, 6, 20, 80])
    assert.ok(message.render(width).every((line) => visibleWidth(line) <= width));
  const lines = message
    .render(20)
    .map(stripVTControlCharacters)
    .filter((line) => line.trim());
  assert.equal(lines[0].trimEnd(), "  ┃ hello");
  assert.ok(lines.every((line) => line.startsWith("  ┃ ")));
});

test("submitted commands use the accent color without a prompt rail", () => {
  const message = new SentMessage("/status");
  const output = message.render(80).join("\n");
  assert.ok(output.includes("\x1b[38;2;77;107;254m/status"));
  assert.deepEqual(
    message.render(80).map((line) => stripVTControlCharacters(line).trimEnd()),
    ["", "  /status", ""],
  );
  const long = new SentMessage("/resume session-with-a-long-id");
  for (const width of [1, 6, 20, 80]) {
    const lines = long.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /┃/);
  }
});

test("queued messages use a gray prompt rail and gray text", () => {
  const message = new QueuedMessage("follow up on @src/main.ts");
  for (const width of [1, 6, 20, 80])
    assert.ok(message.render(width).every((line) => visibleWidth(line) <= width));
  const output = message.render(80).join("\n");
  assert.ok(output.includes("\x1b[38;2;160;166;172m┃"));
  assert.ok(output.includes("\x1b[38;2;160;166;172mfollow up on @src/main.ts"));
  assert.ok(!output.includes("\x1b[38;2;77;107;254m"));
  const lines = message
    .render(80)
    .map(stripVTControlCharacters)
    .filter((line) => line.trim());
  assert.equal(lines[0].trimEnd(), "  ┃ follow up on @src/main.ts");
});

test("queued prompts stack below the transcript with one blank row between", () => {
  const queue = new QueueView();
  assert.deepEqual(queue.render(80), []);
  queue.addChild(new QueuedMessage("first"));
  queue.addChild(new QueuedMessage("second"));
  const lines = queue.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.deepEqual(lines, ["  ┃ first", "", "  ┃ second", ""]);
  queue.removeChild(queue.children[0]!);
  assert.deepEqual(
    queue.render(80).map((line) => stripVTControlCharacters(line).trimEnd()),
    ["  ┃ second", ""],
  );
});

test("Thinking shows elapsed seconds and freezes them on finish", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const view = new ThinkingView(tui);
  try {
    now.mockReturnValue(2400);
    assert.match(view.render(80).map(stripVTControlCharacters).join("\n"), /Thinking \(1s\)/);
    assert.doesNotMatch(view.render(80).map(stripVTControlCharacters).join("\n"), /↑|↓/);
    now.mockReturnValue(4000);
    view.finish();
    now.mockReturnValue(9000);
    view.finish();
    assert.deepEqual(
      view.render(80).map((line) => stripVTControlCharacters(line).trimEnd()),
      ["  ✓ Thinking (3s)"],
    );
  } finally {
    view.finish();
    now.mockRestore();
  }
});

test("tool and Thinking groups keep one empty row before the composer and chat", () => {
  const transcript = new Transcript();
  assert.deepEqual(transcript.render(80), []);
  transcript.addChild(new ToolRow("✓ read src/main.ts"));
  let lines = transcript.render(80).map(stripVTControlCharacters);
  assert.match(lines.at(-2)!, /read src\/main.ts/);
  assert.equal(lines.at(-1), "");
  transcript.addChild(new Text("assistant answer", 2, 1));
  lines = transcript.render(80).map(stripVTControlCharacters);
  const answer = lines.findIndex((line) => line.includes("assistant answer"));
  assert.equal(lines[answer - 1].trim(), "");
  assert.match(lines[answer - 2], /read src\/main.ts/);
  assert.equal(lines.at(-1), "");
  assert.ok(lines.at(-2)?.trim());
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const view = new ThinkingView(tui);
  try {
    const activity = new Transcript();
    activity.addChild(new SentMessage("hello"));
    activity.addChild(view);
    view.finish();
    const rendered = activity.render(80).map(stripVTControlCharacters);
    const thought = rendered.findIndex((line) => /\d+s/.test(line));
    assert.equal(rendered[thought - 1].trim(), "");
    assert.match(rendered[thought - 2], /┃ hello/);
    assert.equal(rendered.at(-1), "");
  } finally {
    view.finish();
  }
});

test("notifications use icons and labels; adjacent message boundaries have one blank row", () => {
  const transcript = new Transcript();
  transcript.addChild(new SentMessage("hello"));
  transcript.addChild(new Notification("Error", "Could not connect"));
  transcript.addChild(new Notification("Resumed", "session 123"));
  transcript.addChild(new Text("First paragraph\n\nSecond paragraph", 2, 1));
  const lines = transcript.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.match(lines.join("\n"), /✗ error: Could not connect/);
  assert.match(lines.join("\n"), /✓ resumed: session 123/);
  const message = lines.findIndex((line) => line.includes("┃ hello"));
  const error = lines.findIndex((line) => line.includes("✗ error:"));
  assert.equal(error - message, 2);
  const resumed = lines.findIndex((line) => line.includes("✓ resumed:"));
  assert.equal(resumed - error, 2);
  assert.match(lines.join("\n"), /First paragraph\n\s*\n\s*Second paragraph/);
});

test("authentication input never renders its secret", () => {
  const input = new SecretInput();
  input.focused = true;
  input.handleInput("private-api-key");
  for (const width of [20, 80]) {
    const output = input.render(width).join("\n");
    assert.ok(!output.includes("private-api-key"));
    assert.ok(output.includes("•"));
  }
  assert.equal(input.getValue(), "private-api-key");
});

test("Thinking keeps its place above later tools, answers and notifications", () => {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const transcript = new Transcript();
  const thinking = new ThinkingView(tui);
  try {
    transcript.addChild(thinking);
    transcript.addChild(new ToolRow("✓ read file"));
    transcript.addChild(new Text("answer", 2, 1));
    transcript.addChild(new Notification("Model", "provider / model"));
    const lines = transcript.render(80).map(stripVTControlCharacters);
    const thought = lines.findIndex((line) => /Thinking/.test(line));
    const tool = lines.findIndex((line) => /read file/.test(line));
    assert.ok(thought >= 0 && thought < tool);
    assert.equal(lines.at(-1), "");
    assert.deepEqual(
      transcript.children.map((item) => item.constructor.name),
      ["ThinkingView", "ToolRow", "Text", "Notification"],
    );
    thinking.finish();
    transcript.addChild(new SentMessage("next message"));
    assert.equal(transcript.children.at(0), thinking);
    assert.ok(transcript.children.at(-1) instanceof SentMessage);
  } finally {
    thinking.finish();
  }
});

test("tools and Thinking have exactly one blank row; unknown tokens stay hidden after completion", () => {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const transcript = new Transcript();
  const thinking = new ThinkingView(tui);
  transcript.addChild(new ToolRow("✓ read file"));
  transcript.addChild(thinking);
  try {
    let lines = transcript.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
    const index = lines.findIndex((line) => line.includes("Thinking"));
    assert.equal(lines[index - 1], "");
    assert.match(lines[index - 2], /read file/);
    thinking.finish();
    lines = transcript.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
    assert.match(lines.at(-2)!, /^  ✓ Thinking \(\d+s\)$/);
    assert.equal(lines.at(-3), "");
    assert.doesNotMatch(lines.join("\n"), /↑|↓/);
  } finally {
    thinking.finish();
  }
});

test("Thinking keeps one blank row below it before the next block", () => {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const transcript = new Transcript();
  const thinking = new ThinkingView(undefined, { text: "a thought", duration: 2000 });
  try {
    transcript.addChild(thinking);
    transcript.addChild(new Text("assistant answer", 2, 1));
    const lines = transcript.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
    const header = lines.findIndex((line) => /✓ Thinking/.test(line));
    const answer = lines.findIndex((line) => line.includes("assistant answer"));
    assert.equal(answer - header, 2);
    assert.equal(lines[header + 1], "");
    assert.equal(lines[header + 2]?.trim(), "assistant answer");
    assert.equal(lines.filter((line) => line === "").length, 2);
  } finally {
    thinking.finish();
  }
});

test("mentions and pasted paths are highlighted without changing text or cursor markers", () => {
  const text = 'Read @src/main.ts @"folder with spaces/file.ts" and ./notes.md user@example.com';
  const sent = new SentMessage(text);
  const output = sent.render(120).join("\n");
  assert.ok(output.includes("\x1b[38;2;77;107;254m@src/main.ts"));
  assert.ok(output.includes('\x1b[38;2;77;107;254m@"folder with spaces/file.ts"'));
  assert.ok(output.includes("\x1b[38;2;77;107;254m./notes.md"));
  assert.ok(!output.includes("\x1b[38;2;77;107;254muser@example.com"));
  assert.ok(stripVTControlCharacters(output).includes(text));

  const editor = new PromptEditor(new TuiMainScreen(new ProcessTerminal()), theme);
  editor.focused = true;
  editor.setText('@src/main.ts "/tmp/folder with spaces/file.ts" [paste #1 +20 lines]');
  const original = editor.getText();
  for (let i = 0; i < original.length - 5; i++) editor.handleInput("\x1b[D");
  const cursor = editor.getCursor();
  const rendered = editor.render(120).join("\n");
  assert.ok(rendered.includes("\x1b[38;2;77;107;254m@src/"));
  assert.ok(rendered.includes('\x1b[38;2;77;107;254m"/tmp/folder with spaces/file.ts"'));
  assert.ok(rendered.includes("\x1b[38;2;77;107;254m[paste #1 +20 lines]"));
  assert.ok(rendered.includes("\x1b_pi:c\x07"));
  assert.equal(editor.getText(), original);
  assert.deepEqual(editor.getCursor(), cursor);
  assert.ok(editor.render(30).every((line) => visibleWidth(line) <= 30));
});

test("finished rows reuse their rendered lines instead of re-truncating every frame", () => {
  const message = new SentMessage("hello @src/main.ts");
  assert.equal(message.render(80), message.render(80));
  assert.notEqual(message.render(79), message.render(80));
  message.invalidate();
  assert.equal(message.render(80), message.render(80));

  const row = new ToolRow("✓ read src/main.ts");
  assert.equal(row.render(80), row.render(80));
  row.setSummary("✗ read src/main.ts — denied");
  assert.match(row.render(80).join(""), /denied/);
});

test("the transcript never mutates a child's cached line array", () => {
  const cached = ["", "hello ", ""];
  const child = {
    invalidate() {},
    render: () => cached,
  };
  const transcript = new Transcript();
  transcript.addChild(new SentMessage("first"));
  transcript.addChild(child);
  const first = transcript.render(80);
  const second = transcript.render(80);
  assert.deepEqual(cached, ["", "hello ", ""]);
  assert.deepEqual(first, second);
  assert.equal(first.filter((line) => line.includes("hello")).length, 1);
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
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test("reasoning is collapsed by default and expands on a header click", () => {
  const view = new ThinkingView(undefined, { text: "first thought\nsecond thought" });
  assert.equal(view.hasReasoning, true);
  assert.equal(view.render(80).length, 1);
  const header = stripVTControlCharacters(view.render(80)[0]!).trimEnd();
  assert.equal(header, "  ✓ Thinking");
  assert.doesNotMatch(
    view.render(80).map(stripVTControlCharacters).join("\n"),
    /first thought|[▸▾]/,
  );

  assert.deepEqual(view.handleMouse(mouse("press")), { handled: true, capture: true });
  assert.deepEqual(view.handleMouse(mouse("click")), { handled: true, render: true });
  const lines = view.render(80).map(stripVTControlCharacters);
  assert.equal(lines[0]!.trimEnd(), header);
  assert.equal(lines[1]!.indexOf("│"), lines[0]!.indexOf("✓"));
  assert.doesNotMatch(lines.join("\n"), /[▸▾]/);
  assert.match(lines.join("\n"), /first thought\n\s+│ second thought/);
  assert.ok(lines.slice(1).every((line) => line.startsWith("  │")));
  for (const width of [20, 48, 80])
    assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));

  view.handleMouse(mouse("click"));
  assert.equal(view.render(80).length, 1);
  assert.equal(view.handleMouse(mouse("click", 1)), undefined);
});

test("transcript routes a header click to the row under the pointer", () => {
  const transcript = new Transcript();
  transcript.addChild(new Text("hello", 0, 0));
  const row = new ToolRow("✓ read main.ts");
  row.setCall('{"path":"main.ts"}');
  transcript.addChild(row);
  transcript.render(80);

  const history = new Container();
  history.addChild(transcript);
  history.render(80);
  const result = history.handleMouse(mouse("click", 1));
  assert.equal(result?.handled, true);
  assert.equal(row.isExpanded, true);
  assert.ok(row.render(80).length > 1);

  history.render(80);
  assert.equal(history.handleMouse(mouse("click", 2)), undefined);
  assert.equal(row.isExpanded, true);
});

test("successive Thinking blocks settle between the tools of each step", () => {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const transcript = new Transcript();
  const first = new ThinkingView(tui);
  const read = new ToolRow("✓ read a.ts");
  const glob = new ToolRow("✓ glob **/*.ts");
  const second = new ThinkingView(tui);
  try {
    transcript.addChild(first);
    transcript.addChild(read);
    transcript.addChild(glob);
    assert.deepEqual(
      transcript.children.map((item) => item.constructor.name),
      ["ThinkingView", "ToolRow", "ToolRow"],
    );
    first.finish();

    transcript.addChild(second);
    assert.deepEqual(
      transcript.children.map((item) => item.constructor.name),
      ["ThinkingView", "ToolRow", "ToolRow", "ThinkingView"],
    );
    second.finish();
    assert.deepEqual(
      transcript.children.map((item) => item.constructor.name),
      ["ThinkingView", "ToolRow", "ToolRow", "ThinkingView"],
    );
    assert.equal(transcript.children[0], first);
    assert.equal(transcript.children[3], second);
  } finally {
    first.finish();
    second.finish();
  }
});
