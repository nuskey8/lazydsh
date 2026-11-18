import { formatDuration, formatTokens } from "./format.ts";
import { accent, dim } from "./theme.ts";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { eventText, reasoningText } from "./runtime-events.ts";
import { latestRequestStats } from "./stats.ts";
import { ToolLog, ToolRow } from "./tools.ts";
import { ThinkingView } from "./presentation.ts";

type HistoryRow =
  | ToolRow
  | ThinkingView
  | { kind: "user" | "assistant" | "metrics" | "notice"; text: string; label?: string };

export function historyRows(events: readonly SessionEvent[], sessionId: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const tools = new ToolLog();
  let started: number | undefined;
  let input = 0;
  let output = 0;
  let known = false;
  let turnStartRow = 0;
  for (const event of events) {
    if (event.type === "turn/start") {
      started = undefined;
      input = output = 0;
      known = false;
      turnStartRow = rows.length;
    }
    if (event.type === "step/start") started ??= event.time;
    if (event.type === "user/message" && event.data.source?.kind === "user") {
      const text = event.data.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "image"
              ? "[image]"
              : block.type === "file"
                ? "[file]"
                : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) rows.push({ kind: "user", text });
    }
    if (event.type === "command/run")
      rows.push({ kind: "user", text: "/" + event.data.name + (event.data.args ?? "") });
    if (event.type === "command/done" && event.data.text)
      rows.push({
        kind: "notice",
        label: event.data.kind === "error" ? "Error" : "dsh",
        text: event.data.text,
      });
    if (event.type === "assistant/message" || event.type === "assistant/attempt") {
      const usage = latestRequestStats([event]).latest;
      if (usage) {
        known = true;
        input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        output += usage.outputTokens;
      }
    }
    if (event.type === "assistant/message") {
      const reasoning = reasoningText(event.data.message.content);
      if (reasoning.trim())
        rows.push(
          new ThinkingView(undefined, {
            text: reasoning,
            duration:
              started === undefined ? undefined : Math.max(0, (event.time - started) / 1000),
          }),
        );
    }
    const item = eventText({ method: "session.event", params: { sessionId, event } });
    if (item?.kind === "assistant") {
      if (item.text) rows.push({ kind: "assistant", text: item.text });
    } else if (item) {
      const row = tools.record(item);
      if (row) rows.push(row);
    }
    if (event.type === "turn/end" && started !== undefined && rows.length > turnStartRow)
      rows.push({
        kind: "metrics",
        text: `${formatDuration((event.time - started) / 1000)}${known ? ` (↑${formatTokens(input)} ↓${formatTokens(output)})` : ""}`,
      });
  }
  return rows;
}

export function continuationCommand(sessionId: string, args: string[] = []) {
  const quote = (value: string) =>
    /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  const command = ["lazydsh", "resume", accent(quote(sessionId)), ...args.map(quote)].join(" ");
  return `${dim("Continue session with:")}\n  ${command}`;
}
