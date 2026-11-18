import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionPanel } from "../src/question.ts";
import type { AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";

const question = {
  id: "pet",
  question: "犬と猫、どちらが好きですか？",
  options: [{ label: "犬" }, { label: "猫" }],
};
const plain = (panel: QuestionPanel, width = 80) =>
  panel.render(width).map(stripVTControlCharacters).join("\n");
const optionRowCount = (lines: readonly string[]) =>
  lines.filter((line) => /^\s*(?:›\s*)?\d+\)\s/.test(line)).length;

test("questions render numbered choices and one key answers with the original label and ID", () => {
  const panel = new QuestionPanel([question]);
  let result: AskUserQuestionAnswer | undefined;
  panel.onAnswer = (answer) => {
    result = answer;
  };
  assert.match(plain(panel), /› 1\) 犬/);
  assert.doesNotMatch(plain(panel), /Question \d|answered/);
  assert.doesNotMatch(plain(panel), /─/);
  assert.ok(panel.render(80).join("\n").includes("\x1b[38;2;77;107;254m"));
  assert.match(plain(panel), /3\) Other/);
  panel.handleInput("2");
  assert.deepEqual(result, { answers: [{ id: "pet", selected: ["猫"] }] });
  for (const width of [20, 48, 80])
    assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
});

test("the panel sizes its option list within the height budget", () => {
  const database = {
    id: "pick",
    question: "Which database should we use?",
    detail: "Pick the one your team already operates.",
    options: Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index + 1}` })),
  };
  const regular = new QuestionPanel([database], 12).render(80);
  assert.ok(regular.length <= 12, `panel used ${regular.length} lines`);
  assert.equal(optionRowCount(regular.map(stripVTControlCharacters)), 9);

  const short = new QuestionPanel([database], 9).render(80).map(stripVTControlCharacters);
  assert.ok(short.length <= 9, `panel used ${short.length} lines`);
  assert.doesNotMatch(short.join("\n"), /Question/);
  assert.equal(optionRowCount(short), 5);

  const cramped = new QuestionPanel(
    [
      {
        id: "pick",
        question: "Which database should we use?",
        options: Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index + 1}` })),
      },
    ],
    5,
  )
    .render(80)
    .map(stripVTControlCharacters);
  assert.equal(cramped.length, 5);
  assert.equal(optionRowCount(cramped), 2);

  const tall = new QuestionPanel(
    [
      {
        id: "letter",
        question: "Pick a letter",
        options: Array.from({ length: 12 }, (_, index) => ({ label: `Option ${index + 1}` })),
      },
    ],
    40,
  )
    .render(80)
    .map(stripVTControlCharacters);
  assert.equal(optionRowCount(tall), 10);
  assert.match(tall.join("\n"), /\(1\/13\)/);
});

test("the panel never exceeds its budget and follows live resizes", () => {
  const many = {
    id: "pick",
    question: "Which database should we use for the new service?",
    detail: "Consider operations, latency and how the team deploys today.",
    options: Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index + 1}` })),
  };
  for (const budget of [1, 2, 3, 4, 5, 6, 8, 10, 15, 20]) {
    for (const width of [24, 40, 80]) {
      const lines = new QuestionPanel([many], budget).render(width);
      assert.ok(
        lines.length <= budget,
        `budget ${budget} at width ${width} rendered ${lines.length} lines`,
      );
      assert.ok(lines.length >= 1);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }

  let budget = 12;
  const panel = new QuestionPanel([many], () => budget);
  for (const next of [12, 5, 2]) {
    budget = next;
    assert.ok(panel.render(80).length <= next, `live budget ${next}`);
  }
});

test("Tab preserves multiple selections, supports Other text and returns all answers together", () => {
  const panel = new QuestionPanel([
    { ...question, multiSelect: true },
    { id: "note", question: "Any notes?" },
  ]);
  let result: AskUserQuestionAnswer | undefined;
  panel.onAnswer = (answer) => {
    result = answer;
  };
  panel.handleInput("1");
  panel.handleInput("2");
  panel.handleInput("\t");
  panel.handleInput("hello");
  panel.handleInput("\r");
  assert.equal(result, undefined);
  panel.handleInput("\r");
  assert.deepEqual(result, {
    answers: [
      { id: "pet", selected: ["犬", "猫"] },
      { id: "note", selected: [], custom: "hello" },
    ],
  });
});

test("Other accepts free text, while approval questions only permit explicit options", () => {
  const panel = new QuestionPanel([question]);
  let answer: AskUserQuestionAnswer | undefined;
  panel.onAnswer = (value) => {
    answer = value;
  };
  panel.handleInput("3");
  panel.handleInput("bird");
  panel.handleInput("\r");
  assert.deepEqual(answer?.answers[0], { id: "pet", selected: [], custom: "bird" });
  const approval = new QuestionPanel([
    {
      id: "approval",
      question: "Allow?",
      intent: { kind: "approval", approve: "Yes", reject: "No" },
      options: [{ label: "No" }, { label: "Yes" }],
    },
  ]);
  assert.doesNotMatch(plain(approval), /Other/);
  let cancelled = false;
  approval.onCancel = () => {
    cancelled = true;
  };
  approval.handleInput("\x1b");
  assert.equal(cancelled, true);
});

test("Escape returns to the previous question and cancels only at the first", () => {
  const panel = new QuestionPanel([
    question,
    { id: "next", question: "Next question?", options: [{ label: "Yes" }] },
  ]);
  let cancelled = false;
  let result: AskUserQuestionAnswer | undefined;
  panel.onCancel = () => {
    cancelled = true;
  };
  panel.onAnswer = (answer) => {
    result = answer;
  };
  panel.handleInput("1");
  assert.match(plain(panel), /Next question/);
  panel.handleInput("\x1b");
  assert.equal(cancelled, false);
  assert.match(plain(panel), /犬と猫/);
  panel.handleInput("2");
  panel.handleInput("1");
  assert.deepEqual(result?.answers[0].selected, ["猫"]);
  const first = new QuestionPanel([question]);
  first.onCancel = () => {
    cancelled = true;
  };
  first.handleInput("\x1b");
  assert.equal(cancelled, true);
});
