import { Markdown, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { safeText } from "./theme.ts";
import { IncrementalHighlighter } from "./stream-highlight.ts";

type Fence = { char: "`" | "~"; length: number };

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Finds the end of the last completed Markdown block in a streamed answer.
 *
 * A trailing blank line normally marks a block boundary, but blank lines inside
 * fenced code or display math do not. Returning only completed blocks lets the
 * UI cache their rendered lines instead of re-parsing the whole growing answer
 * on every animation frame.
 */
export class StreamScanner {
  private offset = 0;
  private boundary = 0;
  private fence?: Fence;
  // Closing delimiter of the display-math block currently being scanned.
  private math?: "$$" | "\\]";

  reset() {
    this.offset = 0;
    this.boundary = 0;
    this.fence = undefined;
    this.math = undefined;
  }

  /** True while the streamed text ends inside fenced code or display math. */
  get insideBlock() {
    return this.fence !== undefined || this.math !== undefined;
  }

  /** Scans newly appended complete lines and returns the latest safe boundary. */
  update(text: string): number {
    let start = this.offset;
    while (start <= text.length) {
      const end = text.indexOf("\n", start);
      if (end < 0) break;
      const raw = text.slice(start, end);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      this.offset = end + 1;
      this.scanLine(line, this.offset);
      start = this.offset;
    }
    return this.boundary;
  }

  private scanLine(line: string, nextOffset: number) {
    if (this.fence) {
      const match = CLOSING_FENCE.exec(line);
      if (match && match[1][0] === this.fence.char && match[1].length >= this.fence.length)
        this.fence = undefined;
      return;
    }
    if (this.math) {
      if (line.includes(this.math)) this.math = undefined;
      return;
    }
    const fence = OPENING_FENCE.exec(line);
    if (fence) {
      this.fence = { char: fence[1][0] as "`" | "~", length: fence[1].length };
      return;
    }
    if (/^ {0,3}\$\$/.test(line)) {
      if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1) this.math = "$$";
      return;
    }
    if (/^ {0,3}\\\[/.test(line)) {
      if (!line.includes("\\]")) this.math = "\\]";
      return;
    }
    if (!line.trim()) this.boundary = nextOffset;
  }
}

/**
 * Markdown view for an assistant answer that is still streaming in.
 *
 * The answer is split into completed blocks (parsed once and cached) and a
 * small live tail. A code fence that is still open lives in that tail, so its
 * highlighting is incremental: `IncrementalHighlighter` carries the lexer state
 * across lines and only re-tokenizes the unstable part, instead of re-running
 * the whole snippet on every frame.
 */
export class StreamingMarkdown implements Component {
  private readonly theme: MarkdownTheme;
  private readonly tailTheme: MarkdownTheme;
  private readonly highlighter?: IncrementalHighlighter;
  private readonly scanner = new StreamScanner();
  private readonly parts = new Map<number, string>();
  private blocks: Markdown[] = [];
  private tail: Markdown;
  private source = "";
  private stableBoundary = 0;
  private tailText = "";
  private lastIndex = -1;
  private finalMarkdown?: Markdown;
  private final = false;
  private version = 0;
  private cachedVersion = -1;
  private cachedWidth = -1;
  private cachedLines?: string[];
  private stableLines?: string[];
  private stableWidth = -1;

  constructor(theme: MarkdownTheme) {
    this.theme = theme;
    if (theme.highlightCode) {
      const highlighter = new IncrementalHighlighter(theme.highlightCode);
      this.highlighter = highlighter;
      this.tailTheme = {
        ...theme,
        highlightCode: (code, language) => highlighter.highlight(code, language),
      };
    } else {
      this.tailTheme = theme;
    }
    this.tail = new Markdown("", 2, 0, this.tailTheme);
  }

  /** Appends a text delta at a content-block index. */
  append(index: number, text: string) {
    const next = safeText(text);
    if (!next) return;
    if (this.final) this.resetStream();
    this.parts.set(index, (this.parts.get(index) ?? "") + next);
    if (this.parts.size === 1) {
      this.source = this.parts.get(index)!;
    } else if (index === this.lastIndex) {
      this.source += next;
    } else if (index > this.lastIndex) {
      // A new content block always appends after the blocks already streamed.
      this.source += "\n" + next;
    } else {
      // Out-of-order deltas can rewrite an earlier block, so the cached blocks
      // and scanner position are no longer valid.
      this.source = [...this.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value)
        .join("\n");
      this.resetStream();
    }
    this.lastIndex = Math.max(this.lastIndex, index);
    this.final = false;
    this.advance();
  }

  /** Replaces the contents with already-complete text. */
  setText(text: string) {
    this.parts.clear();
    this.parts.set(0, safeText(text));
    this.lastIndex = 0;
    this.source = this.parts.get(0)!;
    this.resetStream();
    this.advance();
  }

  /**
   * Finishes streaming and renders the whole answer as one Markdown block.
   * This restores highlighting for a code fence that ended the answer and
   * releases the per-block caches.
   */
  setFinal(text: string) {
    this.parts.clear();
    this.parts.set(0, safeText(text));
    this.lastIndex = 0;
    this.source = this.parts.get(0)!;
    this.blocks = [];
    this.tailText = "";
    this.stableBoundary = 0;
    this.finalMarkdown ??= new Markdown("", 2, 1, this.theme);
    this.finalMarkdown.setText(this.source);
    this.final = true;
    this.version++;
  }

  invalidate() {
    for (const block of this.blocks) block.invalidate();
    this.tail.invalidate();
    this.finalMarkdown?.invalidate();
    this.cachedLines = undefined;
    this.stableLines = undefined;
    this.version++;
  }

  render(width: number): readonly string[] {
    if (this.final) return this.finalMarkdown!.render(width);
    if (!this.source.trim()) return [];
    if (this.cachedLines && this.cachedVersion === this.version && this.cachedWidth === width)
      return this.cachedLines;
    let stable = this.stableLines;
    if (!stable || this.stableWidth !== width) {
      stable = [];
      for (const block of this.blocks) {
        const lines = block.render(width);
        if (!lines.length) continue;
        if (stable.length) stable.push("");
        stable.push(...lines);
      }
      this.stableLines = stable;
      this.stableWidth = width;
    }
    const lines = ["", ...stable];
    if (this.tailText) {
      const tailLines = this.tail.render(width);
      if (tailLines.some((line) => stripVTControlCharacters(line).trim())) {
        if (stable.length) lines.push("");
        lines.push(...tailLines);
      } else if (stable.length) {
        lines.push("");
      }
    }
    if (stable.length && !this.scanner.insideBlock && /\n[ \t\r]*\n[ \t\r]*$/.test(this.source))
      lines.push("");
    lines.push("");
    this.cachedVersion = this.version;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private resetStream() {
    this.blocks = [];
    this.stableBoundary = 0;
    this.tailText = "";
    this.tail = new Markdown("", 2, 0, this.tailTheme);
    this.highlighter?.reset();
    this.scanner.reset();
    this.stableLines = undefined;
    this.final = false;
    this.version++;
  }

  private advance() {
    const boundary = this.scanner.update(this.source);
    if (boundary > this.stableBoundary) {
      const completed = this.source.slice(this.stableBoundary, boundary).replace(/^\n+|\n+$/g, "");
      if (completed) this.blocks.push(new Markdown(completed, 2, 0, this.theme));
      this.stableBoundary = boundary;
      this.stableLines = undefined;
      this.version++;
    }
    const rawTail = this.source.slice(this.stableBoundary);
    const tailText = this.scanner.insideBlock
      ? rawTail.replace(/^\n+/, "")
      : rawTail.replace(/^\n+|\n+$/g, "");
    if (tailText !== this.tailText) {
      this.tailText = tailText;
      this.tail.setText(tailText);
      this.version++;
    }
  }
}
