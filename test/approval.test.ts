import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ApprovalPanel, type ApprovalChoice } from "../src/approval.ts";

const plain = (panel: ApprovalPanel, width = 80) =>
  panel.render(width).map(stripVTControlCharacters).join("\n");

test("approval renders the tool, reason, and clear choices", () => {
  const panel = new ApprovalPanel({ toolName: "bash", reason: "Needs network access" });
  const text = plain(panel);
  assert.match(text, /Approval required/);
  assert.match(text, /Bash command/);
  assert.match(text, /Needs network access/);
  assert.match(text, /Do you want to allow this\?/);
  assert.match(text, /› 1\) Yes, allow once/);
  assert.match(text, /2\) No, reject/);
  assert.doesNotMatch(text, /Type your answer|Other/);
  assert.doesNotMatch(text, /[╭╮╰╯]/);
  assert.match(stripVTControlCharacters(panel.render(80)[0]), /^  Approval required\s*$/);
  for (const width of [20, 48, 80])
    assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
});

test("approval keys select, reject, and cancel without free text", () => {
  const cases: [string, ApprovalChoice | "cancel"][] = [
    ["1", "allowed-once"],
    ["2", "rejected"],
    ["\r", "allowed-once"],
    ["y", "allowed-once"],
    ["n", "rejected"],
    ["\x1b", "cancel"],
  ];
  for (const [key, expected] of cases) {
    const panel = new ApprovalPanel({ toolName: "bash" });
    let choice: ApprovalChoice | "cancel" | undefined;
    panel.onSelect = (value) => {
      choice = value;
    };
    panel.onCancel = () => {
      choice = "cancel";
    };
    panel.handleInput(key);
    assert.equal(choice, expected, `key ${JSON.stringify(key)}`);
  }
});

test("approval summarizes the pending operation and hides raw JSON", () => {
  const panel = new ApprovalPanel({
    toolName: "bash",
    reason: "Needs network access",
    arguments: JSON.stringify({ command: "bun install", timeout: 5000 }),
  });
  let selected: ApprovalChoice | undefined;
  panel.onSelect = (value) => {
    selected = value;
  };
  let text = plain(panel);
  assert.match(text, /Bash command/);
  assert.match(text, /bun install/);
  assert.match(text, /d details/);
  assert.doesNotMatch(text, /Full command|"timeout"/);
  panel.handleInput("d");
  assert.equal(selected, undefined);
  text = plain(panel);
  assert.match(text, /Full command/);
  assert.match(text, /bun install/);
  assert.doesNotMatch(text, /"timeout"|sandbox_permissions/);
  assert.match(text, /d hide/);
  panel.handleInput("d");
  assert.doesNotMatch(plain(panel), /Full command|"timeout"/);
});

test("write details show content and edit details show a diff", () => {
  const write = new ApprovalPanel({
    toolName: "write",
    arguments: JSON.stringify({ file_path: "src/a.ts", content: "export const a = 1;\n" }),
  });
  let text = plain(write);
  assert.match(text, /Write file/);
  assert.match(text, /src\/a\.ts/);
  assert.doesNotMatch(text, /export const a = 1/);
  write.handleInput("d");
  text = plain(write);
  assert.match(text, /Content/);
  assert.match(text, /export const a = 1/);

  const edit = new ApprovalPanel({
    toolName: "edit",
    arguments: JSON.stringify({
      file_path: "src/a.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    }),
  });
  edit.handleInput("d");
  text = plain(edit);
  assert.match(text, /Changes/);
  assert.match(text, /- const a = 1;/);
  assert.match(text, /\+ const a = 2;/);
});

test("approval opens raw arguments for unknown tool shapes", () => {
  const panel = new ApprovalPanel({ toolName: "mystery", arguments: '{"foo":"bar"}' });
  const text = plain(panel);
  assert.match(text, /Tool: mystery/);
  assert.match(text, /Arguments/);
  assert.match(text, /"foo": "bar"/);
  assert.match(text, /d hide/);
});

test("long approval details scroll within the height budget", () => {
  const command = Array.from({ length: 40 }, (_, index) => `echo line-${index}`).join("\n");
  const panel = new ApprovalPanel({ toolName: "bash", arguments: JSON.stringify({ command }) }, 30);
  panel.handleInput("d");
  for (const width of [30, 60, 100]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= 30, `${width} columns rendered ${lines.length} rows`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  const text = plain(panel, 60);
  assert.match(text, /Full command 1–\d+ of \d+/);
  const flat = text.replace(/\s+/g, " ");
  assert.match(flat, /PgUp\/PgDn scroll/);
  panel.handleInput("\x1b[6~");
  const scrolled = plain(panel, 60);
  assert.doesNotMatch(scrolled, /Full command 1–/);
  assert.match(scrolled, /Full command \d+–\d+ of \d+/);
  panel.handleInput("\x1b[5~");
  assert.match(plain(panel, 60), /Full command 1–/);
});

test("approval keeps the question and choices on a short terminal", () => {
  const panel = new ApprovalPanel(
    { toolName: "bash", reason: "Needs network access", arguments: '{"command":"ls"}' },
    5,
  );
  const lines = panel.render(40);
  const text = lines.map(stripVTControlCharacters).join("\n");
  assert.ok(lines.length <= 5);
  assert.match(text, /Do you want to allow this\?/);
  assert.match(text, /1\) Yes, allow once/);
  assert.match(text, /2\) No, reject/);
});

test("approval wraps arrow selection and renders safely without a reason", () => {
  const panel = new ApprovalPanel({ toolName: "write" });
  let chosen: ApprovalChoice | undefined;
  panel.onSelect = (value) => {
    chosen = value;
  };
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.equal(chosen, "rejected");
  panel.handleInput("\x1b[A");
  panel.handleInput(" ");
  assert.equal(chosen, "rejected");
  const text = plain(panel);
  assert.match(text, /Write file/);
  assert.doesNotMatch(text, /undefined/);
});
