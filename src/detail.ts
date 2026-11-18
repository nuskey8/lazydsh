import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { danger, dim, gray, safeText, success } from "./theme.ts";

const RAIL = "  " + dim("│") + " ";
const RAIL_WIDTH = visibleWidth(RAIL);
const MAX_LINES = 400;
const MAX_CHARS = 32_000;
const MAX_DIFF_CELLS = 250_000;

export interface FileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

type Change = { kind: "same" | "add" | "del"; text: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileDiff(value: unknown): value is FileDiff {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    (value.oldText === null || typeof value.oldText === "string") &&
    typeof value.newText === "string"
  );
}

/** Tool result metadata may carry one contextual diff per applied hunk. */
export function readFileDiffs(meta: unknown): FileDiff[] | undefined {
  if (!isRecord(meta) || !Array.isArray(meta.diffs) || meta.diffs.length === 0) return undefined;
  const diffs = meta.diffs.filter(isFileDiff);
  return diffs.length ? diffs : undefined;
}

/** Pretty-print tool arguments without throwing on partial or non-JSON input. */
export function prettyArguments(raw: string): string {
  const text = safeText(raw).trim();
  if (!text) return "(no arguments)";
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2) ?? text;
  } catch {
    return text;
  }
}

function capText(value: string): string {
  let text = value;
  if (text.length > MAX_CHARS) {
    const omitted = text.length - MAX_CHARS;
    text = text.slice(0, MAX_CHARS) + `\n… ${omitted.toLocaleString("en-US")} characters omitted`;
  }
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const omitted = lines.length - MAX_LINES;
  return (
    lines.slice(0, MAX_LINES).join("\n") + `\n… ${omitted.toLocaleString("en-US")} lines omitted`
  );
}

/** A dim section label on the detail rail. */
export function detailLabel(label: string, width: number): string[] {
  return [truncateToWidth(RAIL + dim(safeText(label)), Math.max(1, width))];
}

function capLines(lines: string[], width: number): string[] {
  if (lines.length <= MAX_LINES) return lines;
  const omitted = lines.length - MAX_LINES;
  return [
    ...lines.slice(0, MAX_LINES),
    truncateToWidth(
      RAIL + dim(`… ${omitted.toLocaleString("en-US")} lines omitted`),
      Math.max(1, width),
    ),
  ];
}

/** Wrapped detail text, indented behind a vertical rail. */
export function detailText(
  text: string,
  width: number,
  style: (value: string) => string = (value) => value,
): string[] {
  const contentWidth = Math.max(1, width - RAIL_WIDTH);
  return capLines(
    wrapTextWithAnsi(capText(safeText(text)), contentWidth).map((line) =>
      truncateToWidth(RAIL + style(line), Math.max(1, width)),
    ),
    width,
  );
}

function linesOf(value: string): string[] {
  const lines = safeText(value).replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineChanges(before: string[], after: string[]): Change[] {
  if (before.length * after.length > MAX_DIFF_CELLS)
    return [
      ...before.map((text): Change => ({ kind: "del", text })),
      ...after.map((text): Change => ({ kind: "add", text })),
    ];
  const stride = after.length + 1;
  const common = new Uint32Array((before.length + 1) * stride);
  for (let left = before.length - 1; left >= 0; left--) {
    for (let right = after.length - 1; right >= 0; right--) {
      common[left * stride + right] =
        before[left] === after[right]
          ? common[(left + 1) * stride + right + 1] + 1
          : Math.max(common[(left + 1) * stride + right], common[left * stride + right + 1]);
    }
  }
  const changes: Change[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      changes.push({ kind: "same", text: before[left] });
      left++;
      right++;
    } else if (common[(left + 1) * stride + right] >= common[left * stride + right + 1]) {
      changes.push({ kind: "del", text: before[left] });
      left++;
    } else {
      changes.push({ kind: "add", text: after[right] });
      right++;
    }
  }
  while (left < before.length) changes.push({ kind: "del", text: before[left++] });
  while (right < after.length) changes.push({ kind: "add", text: after[right++] });
  return changes;
}

function wrappedPrefix(
  firstPrefix: string,
  continuationPrefix: string,
  text: string,
  width: number,
  style: (value: string) => string,
): string[] {
  const contentWidth = Math.max(1, width - RAIL_WIDTH - visibleWidth(firstPrefix));
  const wrapped = wrapTextWithAnsi(text, contentWidth);
  const first = wrapped[0] ?? "";
  const lines = [truncateToWidth(RAIL + style(firstPrefix + first), Math.max(1, width))];
  for (const line of wrapped.slice(1))
    lines.push(truncateToWidth(RAIL + continuationPrefix + style(line), Math.max(1, width)));
  return lines;
}

/** One unified-diff block per applied hunk, colored and wrapped. */
export function detailDiff(diffs: readonly FileDiff[], width: number, showLabels = true): string[] {
  const lines: string[] = [];
  let currentPath: string | undefined;
  for (const diff of diffs) {
    if (showLabels && diff.path !== currentPath) {
      lines.push(...detailLabel(`Diff ${diff.path}`, width));
      currentPath = diff.path;
    }
    const changes =
      diff.oldText === null
        ? linesOf(diff.newText).map((text): Change => ({ kind: "add", text }))
        : lineChanges(linesOf(diff.oldText), linesOf(diff.newText));
    for (const change of changes) {
      const sign = change.kind === "add" ? "+" : change.kind === "del" ? "-" : " ";
      const style = change.kind === "add" ? success : change.kind === "del" ? danger : dim;
      lines.push(...wrappedPrefix(`${sign} `, "  ", change.text, width, style));
    }
  }
  return capLines(lines, width);
}

/** The usual Arguments / Result / Diff stack for one tool call. */
export function toolDetails(
  argumentsText: string | undefined,
  resultText: string | undefined,
  meta: unknown,
  width: number,
): string[] {
  const lines: string[] = [];
  if (argumentsText !== undefined) {
    lines.push(...detailLabel("Arguments", width));
    lines.push(...detailText(prettyArguments(argumentsText), width, gray));
  }
  const diffs = readFileDiffs(meta);
  if (resultText !== undefined) {
    lines.push(...detailLabel("Result", width));
    lines.push(
      ...detailText(
        resultText.trim() ? resultText : "(no output)",
        width,
        resultText.trim() ? (value) => value : gray,
      ),
    );
  }
  if (diffs) lines.push(...detailDiff(diffs, width));
  return capLines(lines, width);
}
