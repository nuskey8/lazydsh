import { lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm/assistant-stream";
import type { ContentBlock, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";

/**
 * `lazydsh ask --json` projection: the same newline-delimited event stream
 * `dsh --json` writes, derived from one Agent's durable Session events.
 *
 * This mirrors `@deepseek-ai/dsh-headless`'s `json-stream` module. It is ported
 * rather than imported because that package does not export the subpath, and
 * every projected event is a commit point: text and reasoning come from
 * committed `assistant/message` content, never from a live attempt that may
 * still be retried or discarded.
 */

/** Default per-string and per-key cap applied to every bounded projected payload. */
export const MAX_STRING_BYTES = 8 * 1024;
/** Default cap on one projected event's serialized bytes, newline included; the terminal `final` is exempt. */
export const MAX_EVENT_BYTES = 32 * 1024;
/** Bytes every newline-delimited writer appends after one serialized event. */
const LINE_TERMINATOR_BYTES = 1;
/** Maximum container depth one projected payload keeps before the tail is cut. */
const MAX_DEPTH = 64;

/** The stdout sink a projection writes newline-delimited events to. */
export interface JsonSink {
  /** Write one chunk of the event stream. */
  write(chunk: string): unknown;
}

/** Tunables for {@link openJsonProjection}; every field defaults. */
export interface JsonProjectionOptions {
  /** Per-string and per-key byte cap; longer values are truncated and flagged. */
  maxStringBytes?: number;
}

/** The live handle of one JSON projection. */
export interface JsonProjection {
  /** Project one durable Session event; events from other Sessions are ignored. */
  event(sessionId: string, event: SessionEvent): void;
  /** Write the answer and durable turn reason; omission reports no terminal turn. */
  finish(text: string, reason?: TurnEndReason): void;
  /** Stop projecting events. */
  dispose(): void;
}

/**
 * An error whose failure was already reported as the terminal `final` event.
 * The CLI adds only the human-readable stderr line for it, not a second
 * `error` event.
 */
export class ReportedJsonError extends Error {
  readonly jsonReported = true;
}

/** Truncate one UTF-8 string to `maxBytes`, dropping a split trailing character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const decoded = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded;
}

/** Cap one object key, flagging the payload when it was cut. */
function boundKey(key: string, maxBytes: number, state: { truncated: boolean }): string {
  if (Buffer.byteLength(key, "utf8") <= maxBytes) return key;
  state.truncated = true;
  return truncateUtf8(key, maxBytes);
}

/** Recursively cap every string in one JSON-serializable value, keys included. */
function boundValue(
  value: unknown,
  maxBytes: number,
  state: { truncated: boolean },
  depth = 0,
): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    state.truncated = true;
    return truncateUtf8(value, maxBytes);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      return "[truncated: depth]";
    }
    return value.map((item) => boundValue(item, maxBytes, state, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      return "[truncated: depth]";
    }
    const bounded: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value))
      bounded[boundKey(key, maxBytes, state)] = boundValue(item, maxBytes, state, depth + 1);
    return bounded;
  }
  return value;
}

/** Bound every string and key in one projected payload, adding `truncated: true` when any was cut. */
function boundJsonEvent(event: Record<string, unknown>, maxStringBytes: number) {
  const state = { truncated: false };
  const bounded = boundValue(event, maxStringBytes, state) as Record<string, unknown>;
  if (state.truncated) bounded.truncated = true;
  return bounded;
}

/**
 * Serialize one projected payload under both limits: every string and key is
 * capped at `maxStringBytes`, and the serialized line at `maxEventBytes`. When
 * the line is still too long, scalar fields survive and structured fields are
 * dropped; when even those are too long, only `type` and `truncated` remain.
 */
export function boundJsonLine(
  event: Record<string, unknown>,
  maxStringBytes = MAX_STRING_BYTES,
  maxEventBytes = MAX_EVENT_BYTES,
): string {
  const limit = maxEventBytes - LINE_TERMINATOR_BYTES;
  const bounded = boundJsonEvent(event, maxStringBytes);
  const line = JSON.stringify(bounded);
  if (Buffer.byteLength(line, "utf8") <= limit) return line;
  const scalars: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(bounded))
    if (value === null || typeof value !== "object") scalars[key] = value;
  scalars.truncated = true;
  const short = JSON.stringify(scalars);
  if (Buffer.byteLength(short, "utf8") <= limit) return short;
  return JSON.stringify({ type: bounded.type, truncated: true });
}

/**
 * Parse raw tool-call arguments as the executor does: empty input is `{}`,
 * invalid or non-round-trippable JSON (a non-finite number) stays text.
 */
function parseArguments(raw: string): unknown {
  if (raw === "") return {};
  const seen = { nonFinite: false };
  try {
    const parsed: unknown = JSON.parse(raw, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) seen.nonFinite = true;
      return value;
    });
    return seen.nonFinite ? raw : parsed;
  } catch {
    return raw;
  }
}

/** Join the text blocks of a tool result's model-facing content. */
function resultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** The usage a provider reported in one attempt's stream, if any. */
function streamUsage(stream: SessionEvent<"assistant/attempt">["data"]["stream"]) {
  return lastAssistantStreamChunk(stream, "usage")?.usage;
}

type StepUsage = { usage: TokenUsage | undefined; complete: boolean };

/**
 * Accumulate one step's usage across its attempts. A retried attempt keeps its
 * usage only in its `assistant/attempt` stream, so the committed message alone
 * would under-report billed tokens. An attempt that reports no sample makes the
 * step total unknowable, so the step omits usage entirely rather than publish a
 * partial sum as if it were complete; an optional bucket is summed only when
 * every contribution reports it.
 */
function addUsage(state: StepUsage, next: TokenUsage | undefined): StepUsage {
  if (next === undefined) return { usage: state.usage, complete: false };
  if (state.usage === undefined) return { usage: next, complete: state.complete };
  const total = state.usage;
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? undefined : a + b;
  const totalTokens = sum(total.totalTokens, next.totalTokens);
  const cacheReadTokens = sum(total.cacheReadTokens, next.cacheReadTokens);
  const cacheWriteTokens = sum(total.cacheWriteTokens, next.cacheWriteTokens);
  const reasoningTokens = sum(total.reasoningTokens, next.reasoningTokens);
  return {
    usage: {
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    },
    complete: state.complete,
  };
}

/**
 * Open the `ask --json` projection and write the opening `session` event.
 *
 * Call this before submitting the task, then hand every durable Session event
 * of that run to {@link JsonProjection.event}. The terminal `final` event
 * carries the exact Session identity, the durable turn reason, and the
 * lossless answer; it is not bounded.
 */
export function openJsonProjection(
  sessionId: string,
  cwd: string,
  sink: JsonSink,
  options: JsonProjectionOptions = {},
): JsonProjection {
  const maxStringBytes = options.maxStringBytes ?? MAX_STRING_BYTES;
  let disposed = false;
  let stepUsage: StepUsage = { usage: undefined, complete: true };
  const write = (event: Record<string, unknown>) => {
    if (!disposed) sink.write(`${boundJsonLine(event, maxStringBytes)}\n`);
  };
  write({ type: "session", sessionId, cwd });
  return {
    event(subject, event) {
      if (disposed || subject !== sessionId) return;
      switch (event.type) {
        case "turn/start":
          write({ type: "status", phase: "turn_start", turn: event.data.turn });
          return;
        case "step/start":
          write({
            type: "status",
            phase: "step_start",
            turn: event.data.turn,
            step: event.data.step,
          });
          return;
        case "assistant/attempt":
          stepUsage = addUsage(stepUsage, streamUsage(event.data.stream));
          return;
        case "assistant/message":
          stepUsage = addUsage(stepUsage, event.data.usage ?? streamUsage(event.data.stream));
          for (const block of event.data.message.content)
            if (block.type === "reasoning") write({ type: "thinking", text: block.text });
            else if (block.type === "text") write({ type: "text", text: block.text });
          return;
        case "step/end": {
          const { usage, complete } = stepUsage;
          stepUsage = { usage: undefined, complete: true };
          write({
            type: "status",
            phase: "step_end",
            turn: event.data.turn,
            step: event.data.step,
            ...(complete && usage !== undefined ? { usage } : {}),
          });
          return;
        }
        case "turn/end":
          write({
            type: "status",
            phase: "turn_end",
            turn: event.data.turn,
            reason: event.data.reason,
          });
          return;
        case "tool/call":
          write({
            type: "tool_call",
            callId: event.data.callId,
            tool: event.data.name,
            input: parseArguments(event.data.arguments),
          });
          return;
        case "tool/result": {
          if (event.surfaceOp !== "append") return;
          const message = event.data.message;
          write({
            type: "tool_result",
            callId: message.toolCallId,
            status: message.isError === true ? "error" : "completed",
            result: resultText(message.content),
            ...(event.data.error === undefined ? {} : { error: event.data.error }),
          });
          return;
        }
        default:
          return;
      }
    },
    finish(text, reason) {
      if (disposed) return;
      sink.write(`${JSON.stringify({ type: "final", sessionId, reason: reason ?? null, text })}\n`);
    },
    dispose() {
      disposed = true;
    },
  };
}
