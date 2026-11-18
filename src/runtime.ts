import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  SessionId,
  SessionSeq,
  SessionLogOffset,
  buildForkSeed,
  type SessionEvent,
  type Session,
} from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { ReasoningEffortId, TokenUsage } from "@deepseek-ai/dsh-llm";
import { credentialRef, credentialKey, type CredentialInfo } from "@deepseek-ai/dsh-credentials";
import { AuthorizationDeclinedError } from "@deepseek-ai/dsh-authorization";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import type {
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
} from "@deepseek-ai/dsh-user-questions";
import type { AdmittedPromptContentPart, ImageMediaType } from "@deepseek-ai/dsh-attachment";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-plan-mode";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-working-directory";
import type {} from "@deepseek-ai/dsh-token-meter/client";
import type { CommandDescriptor, CommandSubmitAttachment } from "@deepseek-ai/dsh-commands/types";
import { resolveCommand } from "@deepseek-ai/dsh-commands/builtin";
import { randomUUID } from "node:crypto";
import { access, readFile, stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { latestRequestStats, type SessionStats } from "./stats.ts";
import { readLimits, type AccountLimits } from "./limits.ts";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-workspace";
import type {} from "@deepseek-ai/dsh-file-reference";
import type {} from "@deepseek-ai/dsh-skill";
import { JobId } from "@deepseek-ai/dsh-jobs";
import { formatFileMention } from "@deepseek-ai/dsh-file-reference/grammar";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ReferenceAutocompleteItem } from "./autocomplete.ts";
import { registerCommands } from "./native-commands.ts";
import { contentText, isAuthFailure, type RuntimeEvent } from "./runtime-events.ts";

export { eventText, isAuthFailure } from "./runtime-events.ts";
export type { RuntimeEvent } from "./runtime-events.ts";

export type Route = { provider: string; model: string };
export type QuestionResult = AskUserQuestionAnswer | { cancelled: true };
/** Where the credential for a route currently comes from. */
export type CredentialSource = {
  kind: "environment" | "store" | "oauth" | "ambient" | "keyless" | "none" | "unknown";
  /** Human-readable description for notices. */
  label: string;
  /** Environment-variable name when `kind` is `environment`. */
  ref?: string;
};
export type RuntimeOptions = {
  cwd?: string;
  dshHome?: string;
  reasoningEffort?: ReasoningEffortId;
  signal?: AbortSignal;
};
export type ApprovalRequest = {
  toolName: string;
  reason?: string;
  displayReason?: { en: string; [locale: string]: string };
  callId?: string;
  signal?: AbortSignal;
};
export type Callbacks = {
  resume?: string;
  onAuth?: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  onApproval?: (
    params: ApprovalRequest,
  ) => Promise<{ outcome: "allowed-once" | "rejected" | "cancelled" }>;
  onUserQuestion?: (
    request: AskUserQuestionRequest,
    context: { signal: AbortSignal },
  ) => Promise<QuestionResult>;
};
export type RunResult = {
  sessionId: string;
  finalResponse: string;
  finishReason: "completed" | "error" | "aborted";
  events: SessionEvent[];
};

function describeCredentialRef(ref: string, info: CredentialInfo): CredentialSource {
  switch (info.source) {
    case "env":
      return { kind: "environment", ref, label: `${ref} (environment)` };
    case "project-env":
      return { kind: "environment", ref, label: `${ref} (.env)` };
    case "user-env":
      return { kind: "environment", ref, label: `${ref} (DSH .env)` };
    case "file":
      return { kind: "store", label: `${ref} (saved)` };
    default:
      return { kind: "ambient", label: info.source ? `${ref} (${info.source})` : ref };
  }
}

export class Runtime {
  readonly ctx: Context;
  readonly options: RuntimeOptions;
  private handle?: AgentHandle;
  private callbacks: Callbacks = {};
  private closing?: Promise<void>;
  private activity?: AbortController;
  private connection?: {
    contextWindow?: number;
    latest?: TokenUsage;
    generationMs?: number;
    outputTokensPerSecond?: number;
  };
  private limits?: AccountLimits;
  authFailed = false;
  constructor(ctx: Context, options: RuntimeOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    registerCommands(ctx);
    ctx.on("approval/request", async (request, next) => {
      if (!this.owns(request.agent)) return next();
      return (
        (
          await this.callbacks.onApproval?.({
            toolName: request.toolName,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
            ...(request.displayReason === undefined
              ? {}
              : { displayReason: request.displayReason }),
            ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
        )?.outcome ?? "rejected"
      );
    });
    ctx.on("user-questions/request", async (request, next) => {
      if (!request.agent || !this.owns(request.agent)) return next();
      const signal = request.signal ?? options.signal ?? new AbortController().signal;
      const result = await this.callbacks.onUserQuestion?.(request, { signal });
      if (!result || "cancelled" in result)
        throw new UserQuestionError(
          "Question cancelled",
          signal.aborted ? "ASK_ABORTED" : "ASK_CANCELLED",
        );
      return result;
    });
  }
  get session(): Session | undefined {
    return this.handle?.agent.session;
  }
  private get agent(): Agent {
    if (!this.handle) throw new Error("No model selected. Run /model.");
    return this.handle.agent;
  }
  private owns(agent: Agent) {
    if (agent === this.handle?.agent) return true;
    const subagents = this.ctx.get("subagents");
    if (!subagents || !this.handle) return false;
    try {
      return subagents.rootOf(agent) === this.handle.agent;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "UNAUTHORIZED"
      )
        return false;
      throw error;
    }
  }
  private selectModel(agent: Agent, route: Route) {
    const previous = agent.model.current();
    const reasoningEffort =
      this.options.reasoningEffort ??
      (previous?.provider === route.provider && previous.model === route.model
        ? previous.reasoningEffort
        : undefined);
    agent.model.select({ ...route, ...(reasoningEffort ? { reasoningEffort } : {}) });
  }
  async open(route: Route, callbacks: Callbacks = {}) {
    const ctx = this.ctx;
    this.connection = undefined;
    this.limits = undefined;
    const agentOptions = {
      ...route,
      ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
    };
    await ctx.llm.resolveCallConfig(agentOptions);
    if (callbacks.resume !== undefined && this.session?.id === callbacks.resume) {
      this.selectModel(this.agent, route);
      this.callbacks = callbacks;
      this.authFailed = false;
      return this.agent.session.id;
    }
    if (callbacks.resume) {
      if (ctx.get("workspaceRegistry")?.archivedSessionIds.includes(SessionId(callbacks.resume)))
        throw new Error("Session is archived. Run /restore.");
      const record = await ctx.get("sessionPersistence")?.stat(SessionId(callbacks.resume));
      if (record?.header.origin === "subagent")
        throw new Error("Resume the root session instead of a subagent.");
    }
    await this.close();
    this.callbacks = callbacks;
    this.authFailed = false;
    this.handle = callbacks.resume
      ? await ctx.agents.resume({
          resumeSessionId: SessionId(callbacks.resume),
          agentOptions,
          setup: (_scope, agent) => this.selectModel(agent, route),
        })
      : await ctx.agents.create({
          sessionId: SessionId("session-" + randomUUID().replaceAll("-", "")),
          meta: { cwd: this.options.cwd },
          agentOptions,
        });
    return this.agent.session.id;
  }
  async efforts() {
    const current = this.agent.model.current()!;
    const info = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
    return {
      current: current.reasoningEffort ?? "default",
      defaultEffort: info.reasoning?.defaultEffort,
      options: info.reasoning?.efforts ?? [],
    };
  }
  /** The current route and effort, suitable for persisting as a preference. */
  selection() {
    const current = this.agent.model.current();
    return current
      ? {
          provider: current.provider,
          model: current.model,
          ...(current.reasoningEffort ? { effort: current.reasoningEffort } : {}),
        }
      : undefined;
  }
  async history(): Promise<SessionEvent[]> {
    return [...this.agent.session.snapshotEvents()];
  }
  async sessions() {
    const query = this.ctx.get("sessionQuery");
    if (!query) throw new Error("Session history is unavailable.");
    const workspace = this.ctx.get("workspaceRegistry");
    const cache = this.ctx.get("sessionProjectionCache");
    const records = (await query.listSessions()).filter(
      (record) => record.persisted && record.header.origin !== "subagent",
    );
    const titles = new Map<string, string>();
    const missing: SessionId[] = [];
    for (const record of records) {
      const cached =
        cache?.cachedSnapshot(record.header, ["title"]) ??
        cache?.cachedPredecessorTitle(record.header);
      const title = cached?.values.title;
      // The projection's init state is `null`: a checkpoint written before the
      // first `session/title` event has a usable row but no title to show, so
      // fall through to the authoritative log instead of hiding the title.
      if (typeof title === "string" && title) titles.set(record.header.id, title);
      else missing.push(record.header.id);
    }
    if (missing.length) {
      const snapshots = await query.readTitleSnapshots(missing);
      for (const snapshot of snapshots)
        if (snapshot.status === "fulfilled" && snapshot.value.title)
          titles.set(snapshot.sessionId, snapshot.value.title.title);
    }
    // A checkpoint can lag the live log (e.g. right after a rename); the
    // connected Session's projection supersedes the cached value.
    const current = this.session;
    const liveTitle = current ? this.ctx.get("sessionTitle")?.get(current)?.title : undefined;
    if (current && liveTitle) titles.set(current.id, liveTitle);
    return records.map((record) => ({
      id: record.header.id,
      title: titles.get(record.header.id) ?? record.header.id,
      directory: record.header.cwd,
      archived: workspace?.archivedSessionIds.includes(record.header.id) ?? false,
      pinned: workspace?.pinnedSessionIds.includes(record.header.id) ?? false,
    }));
  }
  /** The effective directory recorded by a saved session, including later `/cd` changes. */
  async sessionDirectory(id: string) {
    const query = this.ctx.get("sessionQuery");
    if (!query) return undefined;
    const snapshot = await query.readSession(SessionId(id));
    let directory = snapshot.session.cwd;
    for (const event of snapshot.events)
      if (event.type === "working-directory/change") directory = event.data.cwd;
    return directory;
  }
  async renameSession(id: string, title: string) {
    const titles = this.ctx.get("sessionTitle");
    if (!titles) throw new Error("Session titles are unavailable.");
    if (id === this.session?.id) return titles.rename(this.agent.session, title).title;
    const saved = await this.ctx.get("sessionPersistence")?.stat(SessionId(id));
    if (!saved || saved.header.origin === "subagent")
      throw new Error("Choose a saved root session.");
    const current = this.agent.model.current()!;
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(id),
      agentOptions: current,
    });
    try {
      return titles.rename(handle.agent.session, title).title;
    } finally {
      await handle.dispose();
    }
  }
  async manageSession(id: string, action: "archive" | "restore" | "pin" | "unpin") {
    const workspace = this.ctx.get("workspaceRegistry");
    if (!workspace) throw new Error("Session management is unavailable.");
    const sessionId = SessionId(id);
    if (action === "archive") await workspace.archiveSession(sessionId);
    else if (action === "restore") await workspace.unarchiveSession(sessionId);
    else if (action === "pin") await workspace.pinSession(sessionId);
    else await workspace.unpinSession(sessionId);
  }
  forkPoints() {
    const events = this.agent.session.snapshotEvents();
    return events
      .filter((event) => event.type === "turn/end")
      .map((event) => {
        const prompt = events.findLast(
          (item) =>
            item.seq < event.seq &&
            item.type === "user/message" &&
            item.data.source?.kind === "user",
        );
        const text =
          prompt?.type === "user/message"
            ? prompt.data.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(" ")
            : "";
        return { value: String(event.seq), label: `Turn ${event.data.turn}`, description: text };
      });
  }
  async forkSession(boundary: number) {
    if (this.agent.status === "running") throw new Error("Stop the response before forking.");
    if (!this.forkPoints().some((point) => point.value === String(boundary)))
      throw new Error("Choose a completed turn.");
    const seed = buildForkSeed(this.agent.session.snapshotEvents(), SessionSeq(boundary));
    const current = this.agent.model.current()!;
    const child = await this.ctx.agents.create({
      sessionId: SessionId("session-" + randomUUID().replaceAll("-", "")),
      seed,
      inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { cwd: await this.cd(), isSeeded: true },
      agentOptions: current,
    });
    try {
      await this.close();
    } catch (error) {
      await child.dispose();
      throw error;
    }
    this.handle = child;
    return child.agent.session.id;
  }
  async jobs() {
    const registry = this.ctx.get("jobs");
    if (!registry) throw new Error("Background jobs are unavailable.");
    const descendants = await this.ctx.get("subagents")?.listDescendants(this.agent.session.id);
    const owners = [
      this.agent.session.id,
      ...(descendants ?? []).filter((child) => child.kind === "child").map((child) => child.id),
    ];
    return [
      ...new Map(
        owners.flatMap((owner) => registry.list(owner)).map((job) => [job.id, job]),
      ).values(),
    ];
  }
  async job(id: string, stop = false) {
    const job = (await this.jobs()).find((job) => job.id === id);
    if (!job) throw new Error("Job not found in this session.");
    const registry = this.ctx.get("jobs")!;
    if (stop) return registry.kill(JobId(id), job.owner, "Stopped from lazydsh");
    const output = registry.readAt(JobId(id), 0, job.owner);
    const text = output.chunks.map((chunk) => chunk.text).join("");
    return `${job.label} · ${job.status} · ${job.id}\n${output.lossy || text.length > 12000 ? "[Earlier output omitted]\n" : ""}${text.slice(-12000)}`;
  }
  async references(query: string, signal: AbortSignal): Promise<ReferenceAutocompleteItem[]> {
    const cwd = await this.cd();
    const [files, skills, children] = await Promise.all([
      query.startsWith("skill:") || query.startsWith("agent:")
        ? []
        : (this.ctx.get("fileReferences")?.list(this.agent, query, signal) ?? []),
      this.ctx.get("skills")?.list({ scope: this.agent, cwd, signal }) ?? [],
      this.ctx.get("subagents")?.listDescendants(this.agent.session.id, signal) ?? [],
    ]);
    const needle = query.replace(/^(skill|agent):/, "").toLowerCase();
    return [
      ...files.flatMap((file) => {
        const value = formatFileMention(file, false);
        return value
          ? [
              {
                value,
                label: "@" + file.path + (file.kind === "directory" ? "/" : ""),
                description: file.kind,
                ...(file.kind === "file" ? { path: file.path } : {}),
              },
            ]
          : [];
      }),
      ...skills
        .filter(
          (skill) =>
            !query.startsWith("agent:") &&
            skill.invocation.userInvocable &&
            skill.name.toLowerCase().includes(needle),
        )
        .map((skill) => ({
          value: "/" + skill.name,
          label: "@skill:" + skill.name,
          description: skill.description,
        })),
      ...children
        .filter(
          (child) =>
            !query.startsWith("skill:") &&
            child.kind === "child" &&
            (child.path ?? child.id).toLowerCase().includes(needle),
        )
        .map((child) => ({
          value: "@" + (child.path ?? child.id),
          label: "@" + (child.path ?? child.id),
          description: "Subagent · " + (child.kind === "child" ? child.activity : ""),
        })),
    ];
  }
  async choices(
    kind: "sessions" | "directories" | "mode" | "permissions",
    value?: string,
  ): Promise<{
    current?: string;
    options: { value: string; label: string; description?: string }[];
  }> {
    const ctx = this.ctx;
    if (kind === "sessions") {
      const records = await this.sessions();
      const current = this.session?.id;
      return {
        options: records
          .filter((record) => !record.archived && record.id !== current)
          .sort((a, b) => Number(b.pinned) - Number(a.pinned))
          .map((record) => ({
            value: record.id,
            label: (record.pinned ? "★ " : "") + record.title,
            description: record.directory,
          })),
      };
    }
    const agent = this.agent;
    if (kind === "directories") {
      const entries = await readdir(await this.cd(), { withFileTypes: true });
      return {
        options: [
          { value: "..", label: "..", description: "Parent directory" },
          ...entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ value: entry.name, label: entry.name })),
        ],
      };
    }
    if (kind === "mode") {
      const mode = ctx.get("planMode");
      if (!mode) throw new Error("Plan mode is unavailable.");
      if (value !== undefined) {
        if (value !== "default" && value !== "plan") throw new Error(`Unknown mode: ${value}.`);
        mode.set(agent, value === "plan");
      }
      const state = mode.get(agent);
      return {
        current: (state.pending ?? state.active) ? "plan" : "default",
        options: [
          { value: "default", label: "Default", description: "Normal coding mode" },
          { value: "plan", label: "Plan", description: "Plan changes before implementation" },
        ],
      };
    }
    const presets = ctx.get("permissionPresets");
    if (!presets) throw new Error("Permission presets are unavailable.");
    if (value !== undefined) presets.set(agent.session, value);
    return {
      current: presets.current(agent.session),
      options: presets.catalog().options.map((option) => ({
        value: option.value,
        label: option.name,
        description: option.description,
      })),
    };
  }
  async cd(path?: string) {
    return path === undefined
      ? this.ctx.workingDirectory.ensure(this.agent)
      : this.ctx.workingDirectory.set(this.agent, path);
  }
  authProviders() {
    return [
      { value: "deepseek-official", label: "DeepSeek", description: "deepseek-official · API key" },
      ...this.ctx.authorization
        .list()
        .filter((flow) => flow.key.startsWith("llm-pi-ai/"))
        .map((flow) => ({
          value: flow.key.slice("llm-pi-ai/".length),
          label: flow.label,
          description: `${flow.key.slice("llm-pi-ai/".length)} · ${flow.methods.map((method) => (method.id === "oauth" ? "OAuth" : "API key")).join(" / ")}`,
        })),
    ];
  }
  /**
   * Describe where a route's credentials come from.
   *
   * A stored login, a provider environment variable, and an ambient provider
   * source (AWS profiles, ADC files) are distinguished so the TUI can show
   * which one is active. Routes this build does not know — a provider added
   * through --patch — answer `unknown` rather than pretending to be logged out.
   */
  async credentialSource(provider?: string, signal?: AbortSignal): Promise<CredentialSource> {
    const route = provider ?? this.handle?.agent.model.current()?.provider;
    if (route === undefined) return { kind: "none", label: "No route selected" };
    if (route === "deepseek-official") {
      const ref = "DEEPSEEK_API_KEY";
      const info = await this.ctx.credentials.describe(credentialRef(ref));
      return info.configured
        ? describeCredentialRef(ref, info)
        : { kind: "none", label: "Not logged in" };
    }
    const record = await this.ctx.credentials.describeRecord(credentialKey("llm-pi-ai", route));
    if (record.configured)
      return record.kind === "grant"
        ? { kind: "oauth", label: "OAuth login (saved)" }
        : { kind: "store", label: "Saved credential" };
    // Prefer the route's declared ambient sources: this is a cheap answer and
    // avoids provider-specific credential resolution on every send.
    const native = this.ctx.llm
      .listConfigurableProviders()
      .find((item) => item.provider === route)?.nativeAuth;
    if (native) {
      for (const ref of native.env) {
        const info = await this.ctx.credentials.describe(credentialRef(ref));
        if (info.configured) return describeCredentialRef(ref, info);
      }
      // No ambient env source is declared at all: an OAuth-only route has no
      // stored login here, while a keyless route needs no credential.
      if (native.env.length === 0)
        return native.oauth
          ? { kind: "none", label: "Not logged in" }
          : { kind: "keyless", label: "No credentials required" };
    }
    const installed = builtinProviders().find((item) => item.id === route);
    if (!installed) return { kind: "unknown", label: "Provider-managed credentials" };
    const apiKey = installed.auth.apiKey;
    if (!apiKey)
      return installed.auth.oauth === undefined
        ? { kind: "keyless", label: "No credentials required" }
        : { kind: "none", label: "Not logged in" };
    const input = {
      ctx: {
        env: async (name: string) =>
          (await this.ctx.credentials.resolve(credentialRef(name)))?.value,
        fileExists: async (path: string) => {
          try {
            await access(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
            return true;
          } catch {
            return false;
          }
        },
      },
      signal: signal ?? this.options.signal ?? new AbortController().signal,
    };
    try {
      const result = await (apiKey.check ? apiKey.check(input) : apiKey.resolve(input));
      if (!result) return { kind: "none", label: "Not logged in" };
      const source = typeof result.source === "string" && result.source ? result.source : undefined;
      if (source) {
        const ref = native?.env.find((name) => source === name || source.includes(name));
        if (ref) return { kind: "environment", ref, label: `${ref} (environment)` };
        return { kind: "ambient", label: source };
      }
      return { kind: "ambient", label: "Provider credentials" };
    } catch {
      // Detection failure alone must not claim the route is logged out.
      return { kind: "unknown", label: "Provider-managed credentials" };
    }
  }
  async hasCredentials(provider?: string, signal?: AbortSignal) {
    return (await this.credentialSource(provider, signal)).kind !== "none";
  }
  /**
   * Log in to a provider.
   *
   * Explicit requests (`/login` and `lazydsh login`) refuse to replace a
   * working login. Automatic recovery from an expired token passes
   * `reauthenticate: true` so it is never blocked.
   *
   * Returns a short notice when login was skipped because it is unnecessary
   * or already active; `undefined` means the flow completed.
   */
  async authenticate(
    signal?: AbortSignal,
    options?: { provider?: string; onAuth?: Callbacks["onAuth"]; reauthenticate?: boolean },
  ): Promise<string | undefined> {
    const ctx = this.ctx;
    const provider = options?.provider ?? this.agent.model.current()!.provider;
    if (!options?.reauthenticate) {
      const source = await this.credentialSource(provider, signal);
      if (source.kind === "keyless") return `${provider} does not require credentials.`;
      if (source.kind !== "none" && source.kind !== "unknown")
        return `Already logged in to ${provider}.`;
    }
    const onAuth = options?.onAuth ?? this.callbacks.onAuth;
    const selections: string[] = [];
    let cursor = 0;
    let goingBack = false;
    const prompt = async (params: Record<string, unknown>, promptSignal = signal) => {
      const message =
        typeof params.message === "string" ? params.message.replace(/:\s*$/, "") : "Login";
      const codexMethod =
        params.kind === "select" && message === "Select OpenAI Codex login method";
      const display = codexMethod
        ? {
            ...params,
            message: "How would you like to log in to Codex?",
            options: (params.options as { id: string; label: string }[]).map((item) => ({
              ...item,
              label:
                item.id === "browser"
                  ? "Open a browser"
                  : item.id === "device_code"
                    ? "Use a device code"
                    : item.label,
              description:
                item.id === "browser"
                  ? "Log in on this computer"
                  : item.id === "device_code"
                    ? "Log in from another device"
                    : undefined,
            })),
          }
        : { ...params, message };
      if (params.kind === "select" && cursor < selections.length) return selections[cursor++];
      const answer = await onAuth?.("lazydsh/auth-prompt", display, promptSignal);
      promptSignal?.throwIfAborted();
      if (typeof answer !== "string" || !answer.trim()) {
        if (selections.length) {
          selections.pop();
          goingBack = true;
        }
        throw new AuthorizationDeclinedError();
      }
      if (params.kind === "select") {
        selections.push(answer);
        cursor++;
      }
      return answer;
    };
    while (true) {
      cursor = 0;
      goingBack = false;
      try {
        if (provider === "deepseek-official") {
          await ctx.credentials.set(
            credentialRef("DEEPSEEK_API_KEY"),
            (await prompt({ kind: "secret", message: "DeepSeek API key" })).trim(),
          );
        } else {
          const flow = ctx.authorization
            .list()
            .find((entry) => entry.key === `llm-pi-ai/${provider}`);
          if (!flow)
            throw new Error(`No login method for ${provider}. Configure credentials and retry.`);
          const method =
            flow.methods.length > 1
              ? await prompt({
                  kind: "select",
                  message: `How would you like to log in to ${flow.label}?`,
                  options: flow.methods.map((method) => ({
                    ...method,
                    label:
                      method.id === "oauth"
                        ? "Log in with your account"
                        : method.id === "api-key"
                          ? "Use an API key"
                          : method.label,
                    description: method.label,
                  })),
                })
              : (flow.methods.find((method) => method.id === "oauth")?.id ?? flow.methods[0]?.id);
          const result = await ctx.authorization.begin({
            key: flow.key,
            method,
            signal,
            interaction: {
              notify: (notice) => {
                void onAuth?.("lazydsh/auth-notice", { ...notice }).catch(() => {});
              },
              prompt: (question) =>
                prompt(
                  {
                    kind: question.kind,
                    message: question.message,
                    ...(question.kind === "select" ? { options: question.options } : {}),
                  },
                  question.signal && signal
                    ? AbortSignal.any([question.signal, signal])
                    : (question.signal ?? signal),
                ),
            },
          });
          signal?.throwIfAborted();
          if (result.status !== "authorized")
            throw new AuthorizationDeclinedError("Login cancelled");
        }
        break;
      } catch (error) {
        if (!goingBack || signal?.aborted) throw error;
      }
    }
    this.authFailed = false;
    return undefined;
  }
  /**
   * Remove saved credentials.
   *
   * Returns the credential refs that remain configured, or `undefined` when
   * there was nothing to log out of.
   */
  async logout(provider: string): Promise<string[] | undefined> {
    const source = await this.credentialSource(provider);
    if (source.kind === "none" || source.kind === "keyless") return undefined;
    if (provider === "deepseek-official")
      await this.ctx.credentials.unset(credentialRef("DEEPSEEK_API_KEY"));
    else {
      const key = credentialKey("llm-pi-ai", provider);
      if (!this.ctx.authorization.list().some((flow) => flow.key === key))
        throw new Error(`Unknown provider: ${provider}.`);
      this.ctx.authorization.cancel(key);
      await this.ctx.credentials.deleteRecord(key);
    }
    const refs =
      provider === "deepseek-official"
        ? ["DEEPSEEK_API_KEY"]
        : (this.ctx.llm.listConfigurableProviders().find((item) => item.provider === provider)
            ?.nativeAuth?.env ?? []);
    const remaining: string[] = [];
    for (const ref of refs)
      if ((await this.ctx.credentials.describe(credentialRef(ref))).configured) remaining.push(ref);
    return remaining;
  }
  private async checkConnection() {
    const agent = this.agent;
    const current = agent.model.current()!;
    const activity = new AbortController();
    this.activity = activity;
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, activity.signal])
      : activity.signal;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let firstToken: number | undefined;
        let latest: TokenUsage | undefined;
        let failure: { code: string; status?: number; message: string } | undefined;
        let finished = false;
        let finishedAt: number | undefined;
        for await (const chunk of this.ctx.llm.stream({
          provider: current.provider,
          model: current.model,
          sessionId: agent.session.id,
          messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }],
          maxTokens: 1,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        })) {
          if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && chunk.text)
            firstToken ??= performance.now();
          if (chunk.type === "usage") latest = chunk.usage;
          if (chunk.type === "finish") {
            finished = true;
            finishedAt = performance.now();
            if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")
              failure = chunk.reason.failure;
          }
        }
        if (failure) {
          if (isAuthFailure(failure)) {
            this.authFailed = true;
            if (attempt === 0) {
              await this.authenticate(signal, {
                provider: current.provider,
                reauthenticate: true,
              });
              continue;
            }
          }
          throw new Error(`[${failure.code}] ${failure.message}`);
        }
        if (!finished) throw new Error("Model connection check did not finish.");
        const info = await this.ctx.llm.resolveModelInfo(current.provider, current.model, signal);
        const generationMs =
          firstToken === undefined || finishedAt === undefined
            ? undefined
            : finishedAt - firstToken;
        this.connection = {
          contextWindow: info.context?.contextWindow,
          latest,
          generationMs,
          outputTokensPerSecond:
            latest && generationMs ? (latest.outputTokens * 1000) / generationMs : undefined,
        };
        this.authFailed = false;
        return;
      }
    } finally {
      if (this.activity === activity) this.activity = undefined;
    }
  }
  async stats(connect = false, onSnapshot?: (stats: SessionStats) => void): Promise<SessionStats> {
    if (connect) {
      if (onSnapshot && !this.authFailed) onSnapshot(await this.stats());
      await this.checkConnection();
    }
    if (this.authFailed) throw new Error("Login failed. Run /login.");
    const current = this.agent.model.current()!;
    const info = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
    if (connect)
      this.limits = await readLimits(this.ctx.credentials, current.provider, this.options.signal);
    const mode = this.ctx.get("planMode")?.get(this.agent);
    const permissions = this.ctx.get("permissionPresets");
    const preset = permissions?.current(this.agent.session);
    const policy = preset && preset !== "custom" ? permissions?.resolve(preset) : undefined;
    const values = this.ctx.sessionProjections.snapshot(this.agent.session, [
      "tokenUsage",
      "contextPressure",
    ]).values;
    const conversation = latestRequestStats(this.agent.session.snapshotEvents());
    const probe = !conversation.latest && this.connection;
    return {
      model: {
        provider: current.provider,
        name: current.model,
        effort:
          current.reasoningEffort ??
          info.reasoning?.defaultEffort ??
          (info.reasoning?.efforts.length ? "Provider default" : undefined),
        maxOutput: this.agent.options.maxTokens ?? info.defaultMaxTokens,
      },
      session: { id: this.agent.session.id, directory: await this.cd() },
      settings: {
        mode: mode ? ((mode.pending ?? mode.active) ? "Plan" : "Default") : undefined,
        permission: preset,
        sandbox: policy?.sandbox,
        approval: policy?.approval,
      },
      limits: this.limits,
      totals: values.tokenUsage ?? {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      context: {
        ...values.contextPressure,
        ...(values.contextPressure?.contextWindow === undefined && info.context?.contextWindow
          ? { contextWindow: info.context?.contextWindow }
          : {}),
      },
      ...conversation,
      ...(probe
        ? {
            latest: probe.latest,
            generationMs: probe.generationMs,
            outputTokensPerSecond: probe.outputTokensPerSecond,
            latestSource: "connection check" as const,
          }
        : {}),
    };
  }
  async commands(): Promise<CommandDescriptor[]> {
    return [...this.ctx.commands.list(this.agent)];
  }
  async attach(path: string): Promise<AdmittedPromptContentPart> {
    path = resolve(await this.cd(), path);
    const info = await stat(path);
    if (!info.isFile() || info.size > 20 * 1024 * 1024)
      throw new Error("Choose a regular file up to 20 MiB.");
    const data = (await readFile(path)).toString("base64");
    const mediaTypes: Record<string, ImageMediaType> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    };
    const mime = mediaTypes[path.split(".").at(-1)?.toLowerCase() ?? ""];
    if (mime)
      return (
        await this.ctx.attachments.admitPromptContent([
          { type: "image", data, mediaType: mime, name: basename(path) },
        ])
      )[0];
    return {
      type: "file",
      attachment: await this.ctx.attachments.admitEncodedFile({ data, name: basename(path) }),
    };
  }
  async run(
    text: string,
    onEvent?: (event: RuntimeEvent) => void,
    attachments: AdmittedPromptContentPart[] = [],
    options: { commands?: boolean; authenticate?: boolean } = {},
  ): Promise<RunResult> {
    const ctx = this.ctx;
    const agent = this.agent;
    const events: SessionEvent[] = [];
    let failure: unknown;
    let retriedAuth = false;
    const commandInput = options.commands !== false && text.trimStart().startsWith("/");
    const concurrent = agent.status === "running" && commandInput;
    const activity = new AbortController();
    if (!concurrent) this.activity = activity;
    const signal = this.options.signal
      ? AbortSignal.any([activity.signal, this.options.signal])
      : activity.signal;
    const disposers = concurrent
      ? []
      : [
          ctx.on("session/event", (session, event) => {
            const subject = ctx.agents.get(session.id);
            if (session !== agent.session && (!subject || !this.owns(subject))) return;
            if (session === agent.session) events.push(event);
            onEvent?.({ method: "session.event", params: { sessionId: session.id, event } });
          }),
          ctx.on("agent/error", (event) => {
            if (event.agent === agent) failure = event.error;
          }),
          ctx.on("agent/assistant-stream", ({ agent: subject, frame }) => {
            if (!this.owns(subject)) return;
            const params = { sessionId: subject.session.id, attemptId: frame.attemptId };
            if (frame.type === "start" || frame.type === "end")
              onEvent?.({
                method: "lazydsh.thinking",
                params: {
                  ...params,
                  type: frame.type,
                },
              });
            else if (frame.chunk.type === "usage")
              onEvent?.({
                method: "lazydsh.thinking",
                params: { ...params, type: "usage", usage: frame.chunk.usage },
              });
            else if (frame.chunk.type === "text-delta")
              onEvent?.({
                method: "assistant.delta",
                params: { ...params, text: frame.chunk.text, index: frame.chunk.index },
              });
            else if (frame.chunk.type === "reasoning-delta")
              onEvent?.({
                method: "assistant.reasoning",
                params: { ...params, text: frame.chunk.text, index: frame.chunk.index },
              });
          }),
          ctx.on("agent/request-error", async (request, next) => {
            if (request.agent !== agent || retriedAuth || !isAuthFailure(request.failure))
              return next();
            this.authFailed = true;
            if (options.authenticate === false)
              throw new Error(
                `Login required. Run lazydsh login ${agent.model.current()!.provider} in a terminal first.`,
              );
            retriedAuth = true;
            await this.authenticate(request.signal, {
              provider: agent.model.current()!.provider,
              reauthenticate: true,
            });
            return { kind: "retry" };
          }),
        ];
    try {
      let commandText: string | undefined;
      let commandError = false;
      const leading = commandInput ? /^\s*\/([^\s]+)/.exec(text)?.[1] : undefined;
      const skill =
        leading && !resolveCommand(leading, ctx.commands.list(agent))
          ? (await ctx.get("skills")?.list({ scope: agent, cwd: await this.cd(), signal }))?.some(
              (skill) => skill.name === leading && skill.invocation.userInvocable,
            )
          : false;
      if (commandInput && !skill) {
        const submitted: CommandSubmitAttachment[] = [];
        for (const attachment of attachments) {
          if (attachment.type !== "image")
            throw new Error("Attachments can only be sent with a message.");
          const image = await ctx.attachments.readImage(attachment.attachment, signal);
          submitted.push({
            type: "image",
            data: Buffer.from(image.data).toString("base64"),
            mediaType: image.ref.mediaType,
            ...(image.ref.name ? { name: image.ref.name } : {}),
          });
        }
        const commands = ctx.commands.list(agent);
        const match = /^\s*\/([^\s]+)([\s\S]*)$/.exec(text)!;
        const command = resolveCommand(match[1], commands);
        if (!command) throw new Error(`Unknown dsh command: /${match[1]}.`);
        const execution = await ctx.commands.execute(
          agent,
          `/${command.name}${match[2]}`,
          submitted,
          signal,
        );
        if (!execution) throw new Error("Command unavailable.");
        commandText = execution.result.text;
        commandError = execution.result.kind === "error";
      } else {
        const provider = agent.model.current()?.provider;
        if (provider !== undefined && !(await this.hasCredentials(provider, signal)))
          throw new Error(
            options.authenticate === false
              ? `Login required. Run lazydsh login ${provider} in a terminal first.`
              : `Not logged in to ${provider}. Run /login ${provider}.`,
          );
        agent.followup(
          createUserMessage({
            // An attachment-only prompt (e.g. a pasted image) carries no text.
            content: [...(text ? [{ type: "text" as const, text }] : []), ...attachments],
            source: { kind: "user" },
          }),
        );
      }
      if (!concurrent) await this.wait();
      if (failure) throw failure;
      const assistant = events.findLast((event) => event.type === "assistant/message");
      const attempt = events.findLast((event) => event.type === "assistant/attempt");
      const error = attempt && latestFailure(attempt);
      const end = events.findLast((event) => event.type === "turn/end");
      const aborted = end?.type === "turn/end" && end.data.reason.kind === "aborted";
      if (assistant) this.authFailed = false;
      return {
        sessionId: agent.session.id,
        finalResponse:
          assistant?.type === "assistant/message"
            ? contentText(assistant.data.message.content)
            : (commandText ?? error?.message ?? ""),
        finishReason: aborted
          ? "aborted"
          : commandError || (error && (!assistant || attempt!.seq > assistant.seq))
            ? "error"
            : "completed",
        events,
      };
    } finally {
      disposers.forEach((dispose) => dispose());
      if (this.activity === activity) this.activity = undefined;
    }
  }
  private async wait() {
    const agent = this.agent;
    const subagents = this.ctx.get("subagents");
    while (true) {
      await agent.whenIdle();
      const seq = agent.session.seq;
      const children = await subagents?.waitForTreeWork(agent);
      if (!children && agent.status === "idle" && agent.session.seq === seq) return;
    }
  }
  async cancel() {
    this.activity?.abort();
    this.agent.cancel({ kind: "user" });
    await this.wait();
  }
  async close() {
    if (this.closing) return this.closing;
    const handle = this.handle;
    if (!handle) return;
    this.activity?.abort();
    this.closing = handle.dispose();
    try {
      await this.closing;
    } finally {
      if (this.handle === handle) this.handle = undefined;
      this.closing = undefined;
    }
  }
}
function latestFailure(event: SessionEvent) {
  if (event.type !== "assistant/attempt") return;
  const finish = event.data.stream.findLast(
    (record) => record.type === "chunk" && record.chunk.type === "finish",
  );
  if (
    finish?.type === "chunk" &&
    finish.chunk.type === "finish" &&
    finish.chunk.reason.kind === "error"
  )
    return finish.chunk.reason.failure;
}
