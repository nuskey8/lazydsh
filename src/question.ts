import {
  Input,
  Text,
  SelectList,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { AskUserQuestionItem, AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";
import { heightBudget, selectionTheme } from "./picker.ts";
import { accent, dim, safeText } from "./theme.ts";

type Question = AskUserQuestionItem;
type Answer = AskUserQuestionAnswer["answers"][number];
type State = { index: number; selected: Set<number>; input: Input; answer?: Answer };

/** Upper bound on option rows; more choices scroll inside the list. */
const MAX_VISIBLE_OPTIONS = 10;

export class QuestionPanel implements Component {
  readonly capturesViewportInput = true;
  onAnswer?: (answer: AskUserQuestionAnswer) => void;
  onCancel?: () => void;
  private readonly questions: Question[];
  private readonly states: State[];
  private current = 0;
  private active = false;
  /**
   * Lines the composer gives the panel, excluding the status row below it. A
   * callback keeps the panel inside the screen when the terminal is resized
   * while the question is open.
   */
  private readonly height?: number | (() => number);

  constructor(questions: Question[], height?: number | (() => number)) {
    if (!questions.length) throw new Error("No questions supplied");
    this.questions = questions;
    this.height = height;
    this.states = questions.map(() => {
      const input = new Input({ prompt: accent("┃ "), placeholder: "Type your answer…" });
      input.onSubmit = () => this.confirm();
      return { index: 0, selected: new Set(), input };
    });
  }
  get focused() {
    return this.active;
  }
  set focused(value: boolean) {
    this.active = value;
    this.states.forEach((state, index) => {
      state.input.focused = value && index === this.current;
    });
  }
  invalidate() {
    this.states.forEach((state) => state.input.invalidate());
  }
  private get question() {
    return this.questions[this.current];
  }
  private get state() {
    return this.states[this.current];
  }
  private get customAllowed() {
    return this.question.intent?.kind !== "approval";
  }
  private get optionCount() {
    return (this.question.options?.length ?? 0) + (this.customAllowed ? 1 : 0);
  }
  private get editing() {
    return this.customAllowed && this.state.index === (this.question.options?.length ?? 0);
  }

  private switchQuestion(direction: number) {
    this.current = (this.current + direction + this.questions.length) % this.questions.length;
    this.focused = this.active;
  }
  private confirm() {
    const options = this.question.options ?? [];
    const state = this.state;
    const selected = this.question.multiSelect
      ? [...state.selected].map((index) => options[index].label)
      : state.index < options.length
        ? [options[state.index].label]
        : [];
    const custom = this.editing ? state.input.getValue().trim() : "";
    if (this.editing && !custom) return;
    if (!selected.length && !custom) return;
    state.answer = { id: this.question.id, selected, ...(custom ? { custom } : {}) };
    const next = this.states.findIndex((item) => !item.answer);
    if (next < 0) this.onAnswer?.({ answers: this.states.map((item) => item.answer!) });
    else {
      this.current = next;
      this.focused = this.active;
    }
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape")) {
      if (this.current > 0) {
        this.current--;
        this.focused = this.active;
      } else this.onCancel?.();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.switchQuestion(matchesKey(data, "shift+tab") ? -1 : 1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const direction = matchesKey(data, "up") ? -1 : 1;
      this.state.index = (this.state.index + direction + this.optionCount) % this.optionCount;
      this.state.answer = undefined;
      return;
    }
    if (matchesKey(data, "enter")) {
      this.confirm();
      return;
    }
    if (this.editing) {
      this.state.answer = undefined;
      this.state.input.handleInput(data);
      return;
    }
    if (this.question.multiSelect && data === " ") {
      this.toggle(this.state.index);
      return;
    }
    if (/^[1-9]$/.test(data) && Number(data) <= this.optionCount) {
      this.state.index = Number(data) - 1;
      this.state.answer = undefined;
      if (this.editing) return;
      if (this.question.multiSelect) this.toggle(this.state.index);
      else this.confirm();
    }
  }
  private toggle(index: number) {
    if (this.state.selected.has(index)) this.state.selected.delete(index);
    else this.state.selected.add(index);
    this.state.answer = undefined;
  }
  /** Current height budget in rows; unlimited when the caller gave none. */
  private budget() {
    return heightBudget(this.height);
  }
  /**
   * Option rows that fit within the panel's height budget. Long question or
   * detail text shrinks the list instead of pushing choices off screen, and a
   * clipped list always leaves one row for SelectList's scroll indicator.
   */
  private optionRows(total: number, fixed: number) {
    const cap = Math.min(MAX_VISIBLE_OPTIONS, total);
    const height = this.budget();
    if (height === Number.POSITIVE_INFINITY) return cap;
    const room = height - fixed;
    if (room < 1) return 0;
    if (room >= total) return Math.min(cap, total);
    return Math.max(1, Math.min(cap, room - 1));
  }
  render(width: number): string[] {
    const text = (value: string) => new Text(value, 2, 0).render(width);
    const options = this.question.options ?? [];
    const labels = [
      ...options.map((option) => safeText(option.label)),
      ...(this.customAllowed ? ["Other"] : []),
    ];
    const question = text(safeText(this.question.question));
    const detail = this.question.detail ? text(dim(safeText(this.question.detail))) : [];
    const input = this.editing
      ? this.state.input
          .render(Math.max(1, width - 4))
          .map((line) => truncateToWidth("  " + line, width))
      : [];
    const help = this.editing
      ? "type answer"
      : this.question.multiSelect
        ? "Space toggle"
        : `1–${Math.min(9, labels.length)} choose now`;
    // Only mention Tab when there is more than one question; the shorter hint
    // fits one row on mid-width terminals and leaves room for choices.
    const keys = this.editing
      ? `${help} · Enter confirm · Esc back`
      : [
          "↑↓ move",
          help,
          ...(this.questions.length > 1 ? ["Tab questions"] : []),
          "Enter select",
          "Esc back",
        ].join(" · ");
    const helpLines = text(dim(keys));
    const heading = text(dim("Question"));
    const budget = this.budget();
    const chrome = (includeDetail: boolean, includeHelp: boolean) =>
      question.length +
      (includeDetail ? detail.length : 0) +
      (this.editing ? 1 + input.length : 0) +
      (includeHelp ? helpLines.length : 0);
    const fittedOptions = (includeDetail: boolean, includeHelp: boolean) =>
      this.optionRows(labels.length, chrome(includeDetail, includeHelp));

    // Start with the full chrome and drop the detail or help line only when that
    // is what makes a couple of choices visible on a short terminal.
    const need = Math.min(2, labels.length);
    let showDetail = true;
    let showHelp = true;
    let visible = fittedOptions(true, true);
    for (const candidate of [
      { detail: true, help: false },
      { detail: false, help: false },
    ]) {
      if (visible >= need) break;
      const rows = fittedOptions(candidate.detail, candidate.help);
      if (rows > visible) {
        visible = rows;
        showDetail = candidate.detail;
        showHelp = candidate.help;
      }
    }

    if (visible < 1) {
      // Not even one choice fits: keep the question readable, and the input line
      // when the user is typing an "Other" answer, without clipping the frame.
      const limited = Math.max(1, Math.floor(budget));
      if (!this.editing) return question.slice(0, limited);
      const head = question.slice(0, Math.max(0, limited - input.length));
      return [...head, ...input].slice(-limited);
    }

    let head = [...question, ...(showDetail ? detail : [])];
    let foot = this.editing ? ["", ...input] : [];
    if (showHelp) foot.push(...helpLines);

    // Spend leftover rows on the decorative frame (heading and separators) only
    // when that does not cost any visible choices.
    const listCount = visible + (visible < labels.length ? 1 : 0);
    const spare =
      budget === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : budget - (head.length + foot.length + listCount);
    if (showHelp && spare >= 4) {
      head = [...heading, "", ...head, ""];
      foot = [
        ...foot.slice(0, foot.length - helpLines.length),
        "",
        ...foot.slice(foot.length - helpLines.length),
      ];
    }

    const room =
      budget === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, budget - head.length - foot.length);
    const list = new SelectList(
      labels.map((label, index) => {
        const checked =
          this.question.multiSelect && index < options.length
            ? this.state.selected.has(index)
              ? "[x] "
              : "[ ] "
            : "";
        return {
          value: String(index),
          label: `${index + 1}) ${checked}${label}`,
          description:
            options[index]?.description &&
            safeText(options[index].description!).replace(/\s+/g, " "),
        };
      }),
      visible,
      selectionTheme,
    );
    list.setSelectedIndex(this.state.index);
    let listLines = list
      .render(Math.max(1, width - 4))
      .map((line) => truncateToWidth("  " + line, width));
    if (listLines.length > room) listLines = listLines.slice(0, room);
    return [...head, ...listLines, ...foot];
  }
}
