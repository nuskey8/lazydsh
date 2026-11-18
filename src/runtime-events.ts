import type { ContentBlock, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

export type RuntimeEvent =
  | { method: "session.event"; params: { sessionId: string; event: SessionEvent } }
  | {
      method: "assistant.delta";
      params: { sessionId: string; attemptId: string; text: string; index: number };
    }
  | {
      method: "assistant.reasoning";
      params: { sessionId: string; attemptId: string; text: string; index: number };
    }
  | {
      method: "lazydsh.thinking";
      params: { sessionId: string; attemptId: string } & (
        | { type: "start" | "end" }
        | { type: "usage"; usage: TokenUsage }
      );
    };

export function isAuthFailure(failure: unknown) {
  if (typeof failure !== "object" || failure === null) return false;
  const { code, status, message } = failure as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  return (
    (typeof code === "string" &&
      ["AUTH", "MISSING_CREDENTIAL", "INVALID_API_KEY", "UNAUTHORIZED"].includes(
        code.toUpperCase(),
      )) ||
    status === 401 ||
    status === 403 ||
    (code === "PI_AI_ERROR" &&
      typeof message === "string" &&
      /not configured|not logged in|no api key|no credential|oauth/i.test(message))
  );
}

export function eventText(notification: RuntimeEvent) {
  if (notification.method !== "session.event") return;
  const { event, sessionId } = notification.params;
  if (event.type === "assistant/message") {
    return { kind: "assistant", text: contentText(event.data.message.content) } as const;
  }
  if (event.type === "tool/call")
    return {
      kind: "tool",
      sessionId: sessionId,
      callId: event.data.callId,
      name: event.data.name,
      text: event.data.arguments,
    } as const;
  if (event.type === "tool/result") {
    return {
      kind: event.data.message.isError ? "error" : "result",
      sessionId: sessionId,
      callId: event.data.message.toolCallId,
      text: contentText(event.data.message.content),
      reason: event.data.error?.reason,
      meta: event.data.meta,
    } as const;
  }
}

export function contentText(content: readonly ContentBlock[]) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** The model's visible reasoning blocks, joined for a collapsed thinking row. */
export function reasoningText(content: readonly ContentBlock[]) {
  return content
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("\n\n");
}
