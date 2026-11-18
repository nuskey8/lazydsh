import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { activeAtToken } from "@deepseek-ai/dsh-file-reference/grammar";
import { isImagePath } from "./attachments.ts";

/** A file candidate that can also be attached rather than referenced as text. */
export type ReferenceAutocompleteItem = AutocompleteItem & {
  /** Absolute or cwd-relative path behind the mention. */
  path?: string;
};

type AttachItem = ReferenceAutocompleteItem & { attachPath?: string };

export class Autocomplete extends CombinedAutocompleteProvider {
  triggerCharacters = ["@", "/"];
  /** Called instead of inserting an image mention as text. */
  onAttach?: (path: string) => void;
  private readonly references: (
    query: string,
    signal: AbortSignal,
  ) => Promise<ReferenceAutocompleteItem[]>;
  constructor(
    commands: SlashCommand[],
    cwd: string,
    references: (query: string, signal: AbortSignal) => Promise<ReferenceAutocompleteItem[]>,
  ) {
    super(commands, cwd);
    this.references = references;
  }
  override async getSuggestions(
    ...args: Parameters<CombinedAutocompleteProvider["getSuggestions"]>
  ) {
    const [lines, line, col, options] = args;
    const token = activeAtToken(lines[line] ?? "", col);
    if (!token) return super.getSuggestions(...args);
    const items = await this.references(token.query, options.signal);
    if (options.signal.aborted || !items.length) return null;
    return {
      items: items.map((item): AttachItem => {
        // Images cannot be meaningfully referenced as text, so selecting one
        // attaches its bytes instead; the pending strip shows the result.
        if (item.path !== undefined && isImagePath(item.path))
          return { ...item, description: "image · attach", attachPath: item.path };
        return item;
      }),
      prefix: token.prefix,
    };
  }
  override applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    const attachPath = (item as AttachItem).attachPath;
    if (attachPath === undefined || this.onAttach === undefined)
      return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    this.onAttach(attachPath);
    // Drop the typed "@query" token: the attachment strip is the visible
    // reference, and leaving the path as text would duplicate its content.
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
    const after = line.slice(cursorCol);
    const next = [...lines];
    next[cursorLine] = before + after;
    return { lines: next, cursorLine, cursorCol: before.length };
  }
}
