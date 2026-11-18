import { extractAnsiCode } from "@earendil-works/pi-tui/dist/utils.js";
import type { TuiMouseDispatchResult } from "@earendil-works/pi-tui/dist/tui.js";
import { stripVTControlCharacters } from "node:util";
import { formatDuration } from "./format.ts";
import { attachmentLine, type AttachmentSummary } from "./attachments.ts";
import { accent, dim, gray, safeText, formatNotification } from "./theme.ts";
import { formatStats, type SessionStats } from "./stats.ts";
import { detailText } from "./detail.ts";
import {
  Editor,
  Input,
  Text,
  Container,
  Loader,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export function activityLine(summary: string) {
  return accent(summary.slice(0, 1)) + dim(summary.slice(1));
}

// Official deepseek.com SVG silhouette sampled into 2×4 Braille cells (52×44 pixels).
const whale = [
  "    ⣀⣤⣤⣤⣤⣤⣴⣶⣿⠃   ⣸⣧⣀    ⢀⣀",
  " ⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣄  ⢸⣿⣿⣷⣴⣶⣶⣿⡏",
  "⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄ ⠙⢿⣿⣿⣿⡿⠋",
  "⣼⣿⠉⠉⠉⠙⠛⠿⣿⣿⣿⣿⣿⡿⠛⢿⣿⣷⣦⣿⣿⡏",
  "⣿⣿⡀     ⠈⠻⣿⣿⣿⣯⣷ ⠙⣿⣿⣿⣿⠃",
  "⠸⣿⣧       ⠈⢻⣿⣿⣿⣷⣶⣿⣿⣿⠏",
  " ⠻⣿⣷⡀   ⢀⣀  ⠙⣿⣿⣿⣿⣿⣿⠋",
  "  ⠙⢿⣿⣶⣄⣀⣈⣿⣷⣦⣀⠈⠻⣿⣿⣿⣧⣄⡀",
  "    ⠙⠻⢿⣿⣿⣿⣿⣿⣿⣿⠷⠊⠉⠛⠛⠋⠁",
  "        ⠈⠉⠉⠉⠁",
];

export class StartupBanner implements Component {
  invalidate() {}
  render(width: number): string[] {
    const toolDescription = "A lazier terminal UI for DeepSeek Harness.";

    if (width < Math.max(64, visibleWidth(toolDescription) + 30))
      return new Text(
        `\n${whale.map((line) => accent(line)).join("\n")}\n\nlazydsh · ${dim(toolDescription)} `,
        0,
        0,
      ).render(width);
    return [
      "",
      ...whale.map((line, index) => {
        const label = index === 2 ? "lazydsh" : index === 3 ? dim(toolDescription) : "";
        return `  ${accent(line.padEnd(28))}${label}`;
      }),
      "",
    ];
  }
}

export class StatusPanel extends Text {
  constructor(stats: SessionStats) {
    super("", 2, 1);
    this.updateStats(stats);
  }
  updateStats(stats: SessionStats) {
    const gray = (text: string) => `\x1b[38;2;160;166;172m${text}\x1b[39m`;
    const content = safeText(formatStats(stats))
      .split("\n")
      .map((line) =>
        line
          .replace(/^([^:]+: +)/, gray)
          .replace(/\([^)]*\)/g, gray)
          .replace(/░+/g, (cells) => `\x1b[38;2;60;63;68m${"█".repeat(cells.length)}\x1b[39m`)
          .replace(/·+/g, gray),
      )
      .join("\n");
    this.setText(content);
  }
}

interface StackRow {
  component: Component;
  /** First displayed line of the row in the stack. */
  start: number;
  height: number;
  /** First line of the child's own render that is displayed. */
  localStart: number;
  /** The child's complete rendered height, including skipped leading blanks. */
  total: number;
}

function stackRows(
  children: readonly Component[],
  width: number,
): { lines: string[]; rows: StackRow[] } {
  const lines: string[] = [];
  const rows: StackRow[] = [];
  const blank = (line: string) => !stripVTControlCharacters(line).trim();
  for (const child of children) {
    const next = child.render(width);
    if (!next.length) continue;
    if (child instanceof ThinkingView && lines.length && !blank(lines.at(-1)!)) lines.push("");
    // Drop only this child's leading blank rows when the previous child already
    // ended with one. Never mutate `next`: cached components reuse that array.
    let start = 0;
    if (lines.length && blank(lines.at(-1)!)) {
      while (start < next.length && blank(next[start])) start++;
    }
    const rowStart = lines.length;
    for (let index = start; index < next.length; index++) lines.push(next[index]);
    // Keep one empty row under a Thinking block so the answer (or tool/summary)
    // that follows starts as its own block instead of hugging the header.
    if (child instanceof ThinkingView && lines.length && !blank(lines.at(-1)!)) lines.push("");
    const height = next.length - start;
    if (height > 0)
      rows.push({
        component: child,
        start: rowStart,
        height,
        localStart: start,
        total: next.length,
      });
  }
  return { lines, rows };
}

function renderStack(children: readonly Component[], width: number): string[] {
  return stackRows(children, width).lines;
}

export class Transcript extends Container {
  private mouseWidth = -1;
  private mouseRows: StackRow[] = [];
  override addChild(component: Component) {
    super.addChild(component);
    this.mouseRows = [];
    this.mouseWidth = -1;
  }

  override removeChild(component: Component) {
    super.removeChild(component);
    this.mouseRows = [];
    this.mouseWidth = -1;
  }

  override clear() {
    super.clear();
    this.mouseRows = [];
    this.mouseWidth = -1;
  }

  override invalidate() {
    super.invalidate();
    this.mouseRows = [];
    this.mouseWidth = -1;
  }

  private layout(width: number): { lines: string[]; rows: StackRow[] } {
    const { lines, rows } = stackRows(this.children, width);
    const blank = (line: string) => !stripVTControlCharacters(line).trim();
    while (lines.length && blank(lines.at(-1)!)) lines.pop();
    const height = lines.length;
    const visible = rows
      .filter((row) => row.start < height)
      .map((row) => ({
        ...row,
        height: Math.min(row.height, height - row.start),
      }))
      .filter((row) => row.height > 0);
    return { lines: lines.length ? [...lines, ""] : [], rows: visible };
  }

  override render(width: number): string[] {
    const { lines, rows } = this.layout(width);
    this.mouseWidth = width;
    this.mouseRows = rows;
    return lines;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    const rows = this.mouseWidth === event.width ? this.mouseRows : this.layout(event.width).rows;
    const row = rows.find((item) => event.y >= item.start && event.y < item.start + item.height);
    if (!row) return undefined;
    const result: TuiMouseEventResult | undefined = row.component.handleMouse?.({
      ...event,
      y: event.y - row.start + row.localStart,
      height: row.total,
    });
    if (!result) return undefined;
    return {
      ...result,
      handled: true,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }
}

// Pending prompts wait below the transcript until the running turn finishes.
export class QueueView extends Container {
  override render(width: number): string[] {
    const lines = renderStack(this.children, width);
    const blank = (line: string) => !stripVTControlCharacters(line).trim();
    while (lines.length && blank(lines[0])) lines.shift();
    while (lines.length && blank(lines.at(-1)!)) lines.pop();
    return lines.length ? [...lines, ""] : [];
  }
}

export class Notification extends Text {
  constructor(label: string, text: unknown = "") {
    super(formatNotification(label, text), 2, 1);
  }
}

function highlightReferences(text: string) {
  const parts: string[] = [];
  let start = 0;
  for (let index = text.indexOf("\x1b"); index >= 0; index = text.indexOf("\x1b", index + 1)) {
    const sequence = extractAnsiCode(text, index);
    if (!sequence) continue;
    parts.push(text.slice(start, index), sequence.code);
    start = index + sequence.length;
    index = start - 1;
  }
  parts.push(text.slice(start));
  const plain = parts.filter((_, index) => index % 2 === 0).join("");
  const ranges = [
    ...plain.matchAll(
      /(?<!\S)(?:@"[^"\n]*(?:"|$)|@[^\s"]+|"(?:\/|\.\.?\/)[^"\n]*"|'(?:\/|\.\.?\/)[^'\n]*'|(?:file:\/\/|\/|\.\.?\/|[A-Za-z]:[\\/])[^\s]+|\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]|\[(?:Image|File) #\d+\])/g,
    ),
  ];
  if (!ranges.length) return text;
  let offset = 0;
  return parts
    .map((part, index) => {
      if (index % 2) return part;
      const start = offset;
      offset += part.length;
      let result = "";
      let cursor = 0;
      for (const match of ranges) {
        const from = Math.max(0, match.index - start);
        const to = Math.min(part.length, match.index + match[0].length - start);
        if (from >= to) continue;
        result += part.slice(cursor, from) + `\x1b[38;2;77;107;254m${part.slice(from, to)}\x1b[39m`;
        cursor = to;
      }
      return result + part.slice(cursor);
    })
    .join("");
}

export class SentMessage implements Component {
  private readonly content: Text;
  private readonly attachmentText?: Text;
  private readonly command: boolean;
  private readonly queued: boolean;
  private cachedWidth = -1;
  private cachedLines?: string[];
  constructor(
    text: string,
    options: { queued?: boolean; attachments?: readonly AttachmentSummary[] } = {},
  ) {
    this.command = /^\/\S/.test(text.trimStart());
    this.queued = options.queued === true;
    const value = safeText(text);
    this.content = new Text(
      this.queued ? gray(value) : this.command ? accent(value) : highlightReferences(value),
      0,
      0,
    );
    const attachments = options.attachments ?? [];
    if (attachments.length)
      this.attachmentText = new Text(
        attachments.map((file) => attachmentLine(file)).join("\n"),
        0,
        0,
      );
  }
  invalidate() {
    this.content.invalidate();
    this.attachmentText?.invalidate();
    this.cachedWidth = -1;
    this.cachedLines = undefined;
  }
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const rail = this.queued ? gray : accent;
    const prefix = this.command
      ? width >= 3
        ? "  "
        : ""
      : width >= 4
        ? `  ${rail("┃")} `
        : width >= 2
          ? rail("┃")
          : "";
    const inner = Math.max(1, width - visibleWidth(prefix));
    const lines = [
      "",
      ...[
        ...(this.attachmentText ? this.attachmentText.render(inner) : []),
        ...this.content.render(inner),
      ].map((line) => truncateToWidth(prefix + line, width)),
      "",
    ];
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export class QueuedMessage extends SentMessage {
  constructor(text: string, attachments?: readonly AttachmentSummary[]) {
    super(text, { queued: true, attachments });
  }
}

export class ThinkingView implements Component {
  private readonly staticView: boolean;
  private readonly loader?: Loader;
  private readonly preview = new Text("", 2, 0);
  private readonly started = performance.now();
  private ended?: number;
  private readonly fixedDuration?: number;
  private message = "";
  private reasoning = "";
  private expanded: boolean;
  private revision = 0;
  private cachedWidth = -1;
  private cachedRevision = -1;
  private cachedLines?: string[];

  constructor(tui?: TUI, options: { text?: string; expanded?: boolean; duration?: number } = {}) {
    this.staticView = tui === undefined;
    this.expanded = options.expanded ?? false;
    this.fixedDuration = options.duration;
    if (tui) {
      this.loader = new Loader(tui, accent, dim, "Thinking…");
      this.loader.setPaddingX(2);
    }
    if (options.text) this.reasoning = options.text;
    if (this.staticView) this.ended = performance.now();
  }

  get running() {
    return this.ended === undefined;
  }
  get hasReasoning() {
    return this.reasoning.trim().length > 0;
  }
  get isExpanded() {
    return this.expanded;
  }

  appendReasoning(text: string) {
    if (!text) return;
    this.reasoning += text;
    this.touch();
  }
  setReasoning(text: string) {
    if (text === this.reasoning) return;
    this.reasoning = text;
    this.touch();
  }
  private touch() {
    this.revision++;
    this.cachedLines = undefined;
    this.cachedRevision = -1;
    this.cachedWidth = -1;
  }

  private duration() {
    if (this.fixedDuration !== undefined) return formatDuration(this.fixedDuration);
    const seconds = Math.floor(((this.ended ?? performance.now()) - this.started) / 1000);
    return formatDuration(seconds);
  }

  private headerText() {
    if (this.staticView) {
      return this.fixedDuration === undefined ? "✓ Thinking" : `✓ Thinking (${this.duration()})`;
    }
    const label = `Thinking (${this.duration()})`;
    return this.running ? label : `✓ ${label}`;
  }

  toggle() {
    if (!this.hasReasoning) return false;
    this.expanded = !this.expanded;
    this.touch();
    return true;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || event.y !== 0 || !this.hasReasoning) return undefined;
    if (event.type === "press") return { handled: true, capture: true };
    if (event.type === "click") {
      this.toggle();
      return { handled: true, render: true };
    }
    if (event.type === "release") return { handled: true };
    return undefined;
  }

  invalidate() {
    this.loader?.invalidate();
    this.preview.invalidate();
    this.cachedLines = undefined;
    this.cachedRevision = -1;
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (
      !this.running &&
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedRevision === this.revision
    )
      return this.cachedLines;
    const header = this.headerText();
    let lines: string[];
    if (this.running && this.loader) {
      if (header !== this.message) {
        this.message = header;
        this.loader.setMessage(header);
      }
      lines = this.loader.render(width);
      if (lines[0] === "") lines = lines.slice(1);
    } else {
      this.preview.setText(activityLine(header));
      lines = this.preview.render(width);
    }
    if (this.expanded && this.hasReasoning)
      lines = [...lines, ...detailText(this.reasoning, width, dim)];
    if (!this.running) {
      this.cachedWidth = width;
      this.cachedRevision = this.revision;
      this.cachedLines = lines;
    }
    return lines;
  }

  finish() {
    if (this.ended !== undefined) return;
    this.ended = performance.now();
    this.loader?.stop();
    this.touch();
  }
}

// Mark only the Editor's own borders; input and autocomplete rows keep their original rendering.
export const editorBorder = (line: string) => `\0border:${line}`;

export class PromptEditor extends Editor {
  override render(width: number): string[] {
    // pi Editor needs room for a wide glyph plus its cursor; keep drafts intact on tiny resizes.
    if (width < 8) return ["…"];
    const prefix = `  ${accent("┃")} `;
    const lines: string[] = [];
    let content = false;
    for (const line of super.render(Math.max(1, width - visibleWidth(prefix)))) {
      if (line.startsWith("\0border:")) content = !content;
      else lines.push(prefix + (content ? highlightReferences(line) : line));
    }
    return lines;
  }
}

export class SecretInput extends Input {
  override render(width: number): string[] {
    const masked = new Input({ prompt: accent("┃ ") });
    masked.setValue("•".repeat(this.getValue().length));
    masked.focused = this.focused;
    return masked.render(width);
  }
}
