import { formatNotification, terminalColor } from "./theme.ts";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { JsonProjection } from "./json-stream.ts";
import type { Runtime } from "./runtime.ts";

export type CommandOptions = {
  command: "ask" | "login" | "logout";
  provider?: string;
  model?: string;
  prompt?: string;
  resume?: string;
  permission?: string;
  /** Emit the DSH-compatible newline-delimited event stream instead of final text. */
  json?: boolean;
};

export async function runCommand(runtime: Runtime, config: CommandOptions, signal: AbortSignal) {
  if (config.command === "login") {
    const { terminalAuth } = await import("./terminal-login.ts");
    const result = await terminalAuth(runtime, "login", config.provider, signal);
    if (result.notice !== undefined) {
      console.log(formatNotification("Login", result.notice, terminalColor(process.stdout)));
      return;
    }
    console.log(formatNotification("Logged in", result.provider, terminalColor(process.stdout)));
    return;
  }
  if (config.command === "logout") {
    let provider = config.provider;
    if (provider === undefined) {
      const { terminalAuth } = await import("./terminal-login.ts");
      provider = (await terminalAuth(runtime, "logout", undefined, signal)).provider;
    }
    const remaining = await runtime.logout(provider);
    if (remaining === undefined) {
      console.log(
        formatNotification(
          "Logout",
          `Not logged in to ${provider}.`,
          terminalColor(process.stdout),
        ),
      );
      return;
    }
    console.log(formatNotification("Logged out", provider, terminalColor(process.stdout)));
    if (remaining.length)
      console.error(
        `Credentials are still available from ${remaining.join(", ")}. Unset them to disconnect.`,
      );
    return;
  }
  if (!config.provider) throw new Error("Choose a provider with --provider before using ask.");
  if (!config.model) throw new Error("Choose a model with --model before using ask.");
  if (!config.prompt?.trim()) throw new Error("Provide a prompt as an argument or through stdin.");
  let interactionError: Error | undefined;
  const stopForInteraction = (message: string) => {
    interactionError = new Error(message);
    void runtime.cancel().catch(() => {});
  };
  let projection: JsonProjection | undefined;
  try {
    const sessionId = await runtime.open(
      { provider: config.provider, model: config.model },
      {
        resume: config.resume,
        onAuth: async () => {
          throw new Error(
            `Login required. Run lazydsh login ${config.provider} in a terminal first.`,
          );
        },
        onApproval: async () => {
          stopForInteraction(
            "Approval is required. Set an appropriate --permission preset before using ask.",
          );
          return { outcome: "rejected" };
        },
        onUserQuestion: async () => {
          stopForInteraction("Interactive questions are unavailable in ask mode.");
          return { cancelled: true };
        },
      },
    );
    if (config.permission) await runtime.choices("permissions", config.permission);
    if (config.json) {
      const { openJsonProjection } = await import("./json-stream.ts");
      projection = openJsonProjection(
        sessionId,
        runtime.session?.header.cwd ?? process.cwd(),
        process.stdout,
      );
    }
    const activeProjection = projection;
    const result = await runtime.run(
      config.prompt,
      activeProjection === undefined
        ? undefined
        : (event) => {
            if (event.method === "session.event")
              activeProjection.event(event.params.sessionId, event.params.event);
          },
      [],
      { commands: false, authenticate: false },
    );
    if (interactionError) throw interactionError;
    if (projection !== undefined) {
      const reason = result.events.findLast((event) => event.type === "turn/end")?.data.reason;
      projection.finish(result.finalResponse, reason);
      if (result.finishReason !== "completed") {
        const { ReportedJsonError } = await import("./json-stream.ts");
        throw new ReportedJsonError(failureMessage(reason, result.finishReason));
      }
      return;
    }
    if (result.finishReason !== "completed")
      throw new Error(result.finalResponse || `Request ${result.finishReason}.`);
    process.stdout.write(result.finalResponse + (result.finalResponse.endsWith("\n") ? "" : "\n"));
  } finally {
    projection?.dispose();
    await runtime.close();
  }
}

/** Describe a durable turn reason for the human-readable stderr line. */
function failureMessage(
  reason: SessionEvent<"turn/end">["data"]["reason"] | undefined,
  finishReason: string,
): string {
  switch (reason?.kind) {
    case "error":
      return reason.error.message;
    case "aborted":
      return "Request aborted.";
    case "blocked":
      return "Request blocked.";
    case "max-tokens":
      return "The response reached its output-token limit.";
    default:
      return `Request ${finishReason}.`;
  }
}
