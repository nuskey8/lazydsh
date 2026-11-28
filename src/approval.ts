import {
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { heightBudget, selectionTheme } from "./picker.ts";
import { detailDiff, detailLabel, detailText, isRecord, prettyArguments } from "./detail.ts";
import { dim, gray, safeText } from "./theme.ts";

export type ApprovalChoice = "allowed-once" | "rejected";

export type ApprovalDetails = {
  toolName: string;
  reason?: string;
  /** Raw tool-call arguments (JSON), summarized and expandable as details. */
  arguments?: string;
};

const options: { value: ApprovalChoice; label: string; description: string }[] = [
  {
    value: "allowed-once",
    label: "Yes, allow once",
    description: "Run this tool call only",
  },
  {
    value: "rejected",
    label: "No, reject",
    description: "Do not run this tool call",
  },
];

const TOOL_TITLES: Record<string, string> = {
  bash: "Bash command",
  bash_persistent: "Bash command",
  write: "Write file",
  edit: "Edit file",
  apply_patch: "Apply patch",
  read: "Read file",
  read_image: "Read image",
};

/** Short action headline for the approval card (Claude/Codex-style). */
function toolTitle(toolName: string) {
  return TOOL_TITLES[toolName] ?? `Tool: ${toolName}`;
}

/** The most useful single field of a tool call, shown before the choices. */
type Operation = { value: string };

const OPERATION_FIELDS = [
  "command",
  "file_path",
  "filePath",
  "path",
  "url",
  "pattern",
  "query",
  "prompt",
  "input",
] as const;

function parseArguments(raw: string | undefined): Record<string, unknown> | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function operationOf(
  raw: string | undefined,
  args: Record<string, unknown> | undefined,
): Operation | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (!args) return { value: prettyArguments(text) };
  for (const key of OPERATION_FIELDS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return { value: safeText(value).trim() };
  }
  return undefined;
}

const MAX_OPERATION_LINES = 6;

export class ApprovalPanel implements Component {
  readonly capturesViewportInput = true;
  onSelect?: (choice: ApprovalChoice) => void;
  onCancel?: () => void;
  private readonly title: string;
  private readonly toolName: string;
  private readonly reason?: string;
  private readonly argumentsText?: string;
  private readonly args?: Record<string, unknown>;
  private readonly operation?: Operation;
  /**
   * Rows the composer gives the panel, excluding the status row below it. A
   * callback keeps long details inside the screen when the terminal is
   * resized while the question is open.
   */
  private readonly height?: number | (() => number);
  private index = 0;
  private expanded: boolean;
  private detailOffset = 0;
  private detailPage = 10;
  private cachedWidth = -1;
  private cachedDetails?: { name: string; body: string[] };

  constructor(details: ApprovalDetails, height?: number | (() => number)) {
    this.toolName = safeText(details.toolName).trim() || "unknown tool";
    this.title = toolTitle(this.toolName);
    const reason = details.reason === undefined ? "" : safeText(details.reason).trim();
    this.reason = reason || undefined;
    const args = details.arguments === undefined ? "" : details.arguments.trim();
    this.argumentsText = args || undefined;
    this.args = parseArguments(this.argumentsText);
    this.operation = operationOf(this.argumentsText, this.args);
    // Known operations are summarized above the choices; unknown shapes start
    // with the details open so the decision is never made blind.
    this.expanded = this.argumentsText !== undefined && this.operation === undefined;
    this.height = height;
  }

  invalidate() {
    this.cachedWidth = -1;
    this.cachedDetails = undefined;
  }
  private choose(index = this.index) {
    const option = options[index];
    if (option) this.onSelect?.(option.value);
  }
  private budget() {
    return heightBudget(this.height);
  }
  /** One argument field, with terminal control sequences removed. */
  private field(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.args?.[key];
      if (typeof value === "string") return safeText(value);
    }
    return undefined;
  }
  /**
   * Readable expanded details: the full command, file contents, a diff, or the
   * patch text. Unknown tools fall back to the raw arguments.
   */
  private detailsFor(width: number): { name: string; body: string[] } {
    if (this.cachedDetails && this.cachedWidth === width) return this.cachedDetails;
    const raw = () => detailText(prettyArguments(this.argumentsText ?? ""), width, gray);
    const command = this.field("command");
    const content = this.field("content");
    const path = this.field("file_path", "filePath", "path");
    const before = this.field("old_string");
    const after = this.field("new_string");
    const patch = this.field("input");
    let name = this.operation === undefined ? "Arguments" : "Full arguments";
    let body: string[];
    if ((this.toolName === "bash" || this.toolName === "bash_persistent") && command?.trim()) {
      name = "Full command";
      body = detailText(command, width);
    } else if (this.toolName === "write" && content !== undefined) {
      name = "Content";
      body = content === "" ? detailText("(empty file)", width, gray) : detailText(content, width);
    } else if (
      this.toolName === "edit" &&
      path !== undefined &&
      before !== undefined &&
      after !== undefined
    ) {
      name = "Changes";
      body = detailDiff([{ path, oldText: before, newText: after }], width, false);
    } else if (this.toolName === "apply_patch" && patch?.trim()) {
      name = "Full patch";
      body = detailText(patch, width);
    } else {
      body = raw();
    }
    const details = { name, body };
    this.cachedDetails = details;
    this.cachedWidth = width;
    return details;
  }
  /** Tool headline plus a short preview of the command/file/patch being approved. */
  private operationLines(width: number): readonly string[] {
    const text = (value: string, indent: number) => new Text(value, indent, 0).render(width);
    if (!this.operation) return text(this.title, 2);
    let value = text(this.operation.value, 4);
    if (value.length > MAX_OPERATION_LINES)
      value = [...value.slice(0, MAX_OPERATION_LINES), ...text(dim("…"), 4)];
    return [...text(this.title, 2), ...value];
  }
  handleInput(data: string) {
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.index =
        (this.index + (matchesKey(data, "up") ? -1 : 1) + options.length) % options.length;
      return;
    }
    if (matchesKey(data, "enter")) {
      this.choose();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.onCancel?.();
      return;
    }
    if (/^d$/i.test(data)) {
      if (this.argumentsText !== undefined) {
        this.expanded = !this.expanded;
        this.detailOffset = 0;
      }
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      if (this.expanded && this.argumentsText !== undefined) {
        const direction = matchesKey(data, "pageUp") ? -1 : 1;
        this.detailOffset = Math.max(0, this.detailOffset + direction * this.detailPage);
      }
      return;
    }
    if (/^[1-9]$/.test(data)) {
      this.choose(Number(data) - 1);
      return;
    }
    if (/^y$/i.test(data) || /^a$/i.test(data)) this.choose(0);
    else if (/^n$/i.test(data) || /^r$/i.test(data)) this.choose(1);
  }
  render(width: number): string[] {
    const budget = this.budget();
    const innerWidth = Math.max(1, width);
    const text = (value: string) => new Text(value, 2, 0).render(innerWidth);

    const operation = this.operationLines(innerWidth);
    const reason = this.reason
      ? [...(operation.length ? [""] : []), ...text(gray(`Why: ${this.reason}`))]
      : [];
    const head = [...text(dim("Approval required")), "", ...operation, ...reason];
    const question = text("Do you want to allow this?");
    // Descriptions only when they fit beside the labels; narrow terminals get
    // the full Yes/No text instead of a truncated label. The primary column is
    // sized to the longest label so descriptions start right after it.
    const labels = options.map((option, index) => `${index + 1}) ${option.label}`);
    const labelWidth = Math.max(...labels.map((label) => visibleWidth(label))) + 2;
    const list = new SelectList(
      options.map((option, index) => ({
        value: option.value,
        label: labels[index],
        description: innerWidth >= 50 ? option.description : undefined,
      })),
      options.length,
      selectionTheme,
      { minPrimaryColumnWidth: labelWidth, maxPrimaryColumnWidth: labelWidth },
    );
    list.setSelectedIndex(this.index);
    const listLines = list
      .render(Math.max(1, innerWidth - 2))
      .map((line) => truncateToWidth("  " + line, innerWidth));
    // Measure the widest possible footer first, so a long hint cannot push the
    // panel past the terminal budget.
    const maxFoot = [
      "",
      ...listLines,
      "",
      ...text(dim("↑↓ move · Enter confirm · Esc cancel · PgUp/PgDn scroll · d hide")),
    ];
    const content = this.expanded ? this.detailsFor(innerWidth) : undefined;
    const detailRows = content?.body.length ?? 0;
    const room =
      detailRows === 0
        ? 0
        : budget === Number.POSITIVE_INFINITY
          ? detailRows
          : Math.max(0, budget - head.length - 1 - question.length - maxFoot.length - 2);

    let details: string[] = [];
    let clipped = false;
    if (content && detailRows > 0 && room > 0) {
      this.detailOffset = Math.max(0, Math.min(this.detailOffset, detailRows - room));
      const visible = content.body.slice(this.detailOffset, this.detailOffset + room);
      this.detailPage = Math.max(1, visible.length);
      clipped = detailRows > visible.length;
      const label = clipped
        ? `${content.name} ${this.detailOffset + 1}–${this.detailOffset + visible.length} of ${detailRows}`
        : content.name;
      details = ["", ...detailLabel(label, innerWidth), ...visible];
    } else {
      this.detailOffset = 0;
      this.detailPage = 1;
    }

    const shownDetails = details.length > 0;
    const hint = [
      "↑↓ move",
      "Enter confirm",
      "Esc cancel",
      ...(shownDetails && clipped ? ["PgUp/PgDn scroll"] : []),
      ...(this.argumentsText === undefined ? [] : [shownDetails ? "d hide" : "d details"]),
    ].join(" · ");
    const foot = ["", ...listLines, "", ...text(dim(hint))];

    let lines = [...head, ...details, "", ...question, ...foot];
    if (budget !== Number.POSITIVE_INFINITY && lines.length > budget) {
      // Short terminal: drop the heading, details, reason, and hint in turn so
      // the question and both choices always stay visible.
      lines = [...operation, ...reason, "", ...question, "", ...listLines];
      if (lines.length > budget) lines = [...question, ...listLines];
      if (lines.length > budget) lines = lines.slice(-budget);
    }
    return lines;
  }
}
