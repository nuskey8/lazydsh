import type { FileAttachmentRef, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { fileURLToPath } from "node:url";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatBytes } from "./format.ts";
import { accent, dim, safeText } from "./theme.ts";

/** The attachment-shaped subset shared by admitted parts and session blocks. */
export type AttachmentPart =
  | { readonly type: "image"; readonly attachment: ImageAttachmentRef }
  | { readonly type: "file"; readonly attachment: FileAttachmentRef };

export type AttachmentSummary = {
  readonly name: string;
  readonly kind: "image" | "file";
  /** Human-readable size plus image dimensions, when available. */
  readonly detail: string;
};

/** One pending attachment row, carrying the token inserted into the prompt. */
export type AttachmentRow = AttachmentSummary & { readonly token: string };

function displayName(value: string | undefined, fallback: string) {
  const name = value === undefined ? "" : safeText(value).replace(/\s+/g, " ").trim();
  return name || fallback;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** Whether a path names one of the raster formats the attachment service accepts. */
export function isImagePath(path: string): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension !== undefined && IMAGE_EXTENSIONS.has(extension);
}

// oxlint-disable-next-line no-control-regex -- Bracketed-paste markers are ESC sequences by design.
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/**
 * An image path pasted or dropped into the terminal. Terminals deliver a
 * dragged file as bracketed paste text, usually quoted or with escaped spaces;
 * only a single existing-looking image path qualifies, so ordinary pastes
 * keep flowing into the editor.
 */
export function pastedImagePath(data: string): string | undefined {
  const match = BRACKETED_PASTE.exec(data);
  if (!match) return undefined;
  let value = match[1].trim();
  if (!value || value.includes("\n") || value.includes("\r")) return undefined;
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  )
    value = value.slice(1, -1);
  // Drag-and-drop paths commonly escape spaces; keep Windows separators.
  value = value.replace(/\\( )/g, "$1");
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return isImagePath(value) ? value : undefined;
}

export function summarizeAttachment(part: AttachmentPart): AttachmentSummary {
  if (part.type === "image") {
    const image = part.attachment;
    return {
      name: displayName(image.name, `image.${image.mediaType.split("/")[1] ?? "png"}`),
      kind: "image",
      detail: `${formatBytes(image.bytes)} · ${image.width}×${image.height}`,
    };
  }
  return {
    name: displayName(part.attachment.name, "file"),
    kind: "file",
    detail: formatBytes(part.attachment.bytes),
  };
}

/** Codex-style placeholder for one pending attachment, e.g. `[Image #1]`. */
export function attachmentToken(kind: "image" | "file", number: number) {
  return `[${kind === "image" ? "Image" : "File"} #${number}]`;
}

export function attachmentLine(summary: AttachmentSummary, index?: number) {
  const prefix = index === undefined ? "" : `${dim(`[${index}]`)} `;
  return `${prefix}${safeText(summary.name)} ${dim(`· ${summary.kind} · ${summary.detail}`)}`;
}

const MAX_VISIBLE = 6;

/**
 * The pending attachments shown above the prompt. Empty renders no rows, so
 * the composer keeps its exact previous height until a file is attached.
 */
export class AttachmentView implements Component {
  private files: readonly AttachmentRow[] = [];
  private cachedWidth = -1;
  private cachedLines?: string[];

  setFiles(files: readonly AttachmentRow[]) {
    if (
      files.length === this.files.length &&
      files.every((file, index) => {
        const current = this.files[index];
        return (
          current !== undefined &&
          current.name === file.name &&
          current.kind === file.kind &&
          current.detail === file.detail &&
          current.token === file.token
        );
      })
    )
      return;
    this.files = files.slice();
    this.cachedLines = undefined;
  }

  invalidate() {
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (!this.files.length) return [];
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const max = Math.max(1, width);
    const count = this.files.length;
    const lines: string[] = [];
    for (const file of this.files.slice(0, MAX_VISIBLE)) {
      const meta = max >= 50 ? ` · ${file.detail}` : "";
      lines.push(
        truncateToWidth(`  ${accent(file.token)} ${safeText(file.name)}${dim(meta)}`, max),
      );
    }
    if (count > MAX_VISIBLE)
      lines.push(truncateToWidth(`  ${dim(`… ${count - MAX_VISIBLE} more`)}`, max));
    lines.push("");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
