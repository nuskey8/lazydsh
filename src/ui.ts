import { QuestionPanel } from "./question.ts";
import { ApprovalPanel } from "./approval.ts";
import { historyRows, continuationCommand } from "./history.ts";
import { openAuthUrl } from "./open-url.ts";
import { homedir } from "node:os";
import { sep, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { preferencesPath, saveModel } from "./preferences.ts";
import { normalizeProvider } from "./provider.ts";
import { SearchPicker, selectionTheme } from "./picker.ts";
import { highlightCode } from "./highlight.ts";
import type { SessionStats } from "./stats.ts";
import { Autocomplete } from "./autocomplete.ts";
import { commandMenu } from "./commands.ts";
import type { RuntimeOptions, QuestionResult } from "./runtime.ts";
import type { AdmittedPromptContentPart } from "@deepseek-ai/dsh-attachment";
import { ToolLog, ToolRow } from "./tools.ts";
import {
  AttachmentView,
  attachmentToken,
  pastedImagePath,
  summarizeAttachment,
  type AttachmentSummary,
} from "./attachments.ts";
import {
  TuiAltScreen,
  ScrollView,
  VStack,
  ProcessTerminal,
  Text,
  Markdown,
  Container,
  matchesKey,
  type Component,
} from "@earendil-works/pi-tui";
import { eventText, isAuthFailure, reasoningText } from "./runtime-events.ts";
import { AuthorizationDeclinedError } from "@deepseek-ai/dsh-authorization";
import type { Runtime, Route, Callbacks, CredentialSource } from "./runtime.ts";
import {
  resumeDirectoryOptions,
  resumeDirectoryTarget,
  sameDirectory,
} from "./resume-directory.ts";
import { StreamingMarkdown } from "./streaming.ts";
import { captureConsole } from "./tui-console.ts";
import { formatDuration, formatTokens } from "./format.ts";
import { ctrlCAction } from "./interrupt.ts";
import { dshCachePath } from "@deepseek-ai/dsh-home-paths";

import {
  StartupBanner,
  StatusPanel,
  PromptEditor,
  SentMessage,
  QueuedMessage,
  QueueView,
  Notification,
  SecretInput,
  Transcript,
  ThinkingView,
  editorBorder,
} from "./presentation.ts";
import { safeText, accent, dim } from "./theme.ts";

type PendingFile = { part: AdmittedPromptContentPart; token: string };

const identity = (text: string) => text;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
export const markdownTheme = {
  highlightCode,
  heading: bold,
  link: accent,
  linkUrl: dim,
  code: accent,
  codeBlock: identity,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: accent,
  bold,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};

export function canRunDuringTurn(text: string) {
  return (
    /^\/plan(?:\s+off)?$/.test(text.trim()) ||
    /^\/(?:status|session|ps|stop|effort|permission|cd|quit)(?:\s|$)/.test(text.trim())
  );
}

export function shouldQueueDuringTurn(text: string) {
  return Boolean(text.trim()) && !/^\s*\//.test(text) && !canRunDuringTurn(text);
}

export async function runUI(
  options: RuntimeOptions & { cwd: string },
  initial: {
    provider: string;
    model?: string;
    resume?: string;
    resumeDirectory?: string;
    resumeArgs?: string[];
  },
  runtime: Runtime,
  hooks: { afterFirstPaint?: () => Promise<void> } = {},
) {
  const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, {
    mouse: true,
    scrollToEndIndicator: () => dim("↓ latest"),
  });
  const header = new StartupBanner();
  const transcript = new Transcript();
  // Prompts typed during a running turn wait below the transcript; drainQueue sends
  // them one at a time as each turn finishes.
  const queueView = new QueueView();
  const queue: {
    text: string;
    view: QueuedMessage;
    attachments: PendingFile[];
  }[] = [];
  const composer = new Container();
  const attachmentView = new AttachmentView();
  const status = new Text("", 2, 1);
  const editor = new PromptEditor(tui, {
    borderColor: editorBorder,
    selectList: { ...selectionTheme, noMatch: dim },
  });
  const toolLog = new ToolLog();
  let route = initial;
  let resume = initial.resume;
  let resumeDirectory = initial.resumeDirectory;
  let commands = commandMenu();
  let stats: SessionStats | undefined;
  let pendingFiles: PendingFile[] = [];
  let nextAttachmentNumber = 1;
  let thinking: ThinkingView | undefined;
  let thinkingAttempt: string | undefined;
  let busy = false;
  let starting = false;
  let startupFailed = false;
  let checkingAuth = false;
  let blockedPrompt: string | undefined;
  const announcedAuth = new Set<string>();
  let running = false;
  let closing = false;
  // Set while Esc cancels the active turn so queued prompts wait for the
  // runtime to go idle instead of draining into the turn being cancelled.
  let stopping = false;
  let submittingQueued = false;
  let continuationId: string | undefined;
  let pendingStartupConnection: { route: Route; sessionId?: string } | undefined;
  let decision: ((value: string | null) => void) | undefined;
  let selecting = false;
  const { promise: done, resolve: finish } = Promise.withResolvers<void>();

  const history = new Container();
  history.addChild(header);
  history.addChild(transcript);
  history.addChild(queueView);
  const scroll = new ScrollView(history, { primary: true, follow: "end", scrollbar: "auto" });
  composer.addChild(attachmentView);
  composer.addChild(editor);
  composer.addChild(status);
  tui.setLayoutRoot(
    new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 0 },
      { component: composer, shrink: 0 },
    ]),
  );
  tui.setFocus(editor);
  setAutocomplete();

  function setAutocomplete() {
    const provider = new Autocomplete(commands, options.cwd, (query, signal) =>
      runtime.session ? runtime.references(query, signal) : Promise.resolve([]),
    );
    // Selecting an image from the "@" picker attaches it instead of inserting
    // a text reference the model could not read.
    provider.onAttach = (path) => attachFile(path);
    editor.setAutocompleteProvider(provider);
  }

  async function runBusy(action: () => Promise<unknown>, label = "Error") {
    busy = true;
    update();
    try {
      await action();
    } catch (error) {
      add(label, error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      update();
    }
  }

  function update() {
    const directory = stats?.session?.directory ?? options.cwd;
    const home = homedir();
    const displayDirectory =
      directory === home
        ? "~"
        : directory.startsWith(home + sep)
          ? "~" + directory.slice(home.length)
          : directory;
    const queued = queue.length ? ` · ${queue.length} queued` : "";
    status.setText(
      dim(
        `${safeText(route.provider)} · ${safeText(route.model ?? "no model")} · ${safeText(displayDirectory)}${queued}`,
      ),
    );
    editor.disableSubmit = (busy || starting || startupFailed || stopping) && !decision;
    tui.requestRender();
  }

  async function refreshStats() {
    const sessionId = runtime.session?.id;
    try {
      const next = await runtime.stats();
      if (runtime.session?.id === sessionId && !closing) {
        stats = next;
        update();
      }
    } catch {
      if (runtime.session?.id === sessionId && !closing) {
        stats = undefined;
        update();
      }
    }
  }

  function settleThinking() {
    if (!thinking) return;
    thinking.finish();
    thinking = undefined;
    thinkingAttempt = undefined;
  }

  function beginThinking(attemptId: string) {
    if (thinking && thinkingAttempt === attemptId) return thinking;
    if (thinking) settleThinking();
    thinking = new ThinkingView(tui);
    thinkingAttempt = attemptId;
    transcript.addChild(thinking);
    return thinking;
  }

  /** The model has started speaking: reasoning is done even if the stream end is still pending. */
  function completeThinking() {
    if (thinking?.running) thinking.finish();
  }

  function add(
    label: string,
    text: unknown = "",
    markdown = false,
    attachments: readonly AttachmentSummary[] = [],
  ) {
    if (label === "You") {
      transcript.addChild(new SentMessage(String(text), { attachments }));
      tui.requestRender();
      return;
    }
    if (label === "assistant") {
      transcript.addChild(
        markdown
          ? new Markdown(safeText(text), 2, 1, markdownTheme)
          : new Text(safeText(text), 2, 1),
      );
    } else {
      transcript.addChild(new Notification(label, text));
    }
    tui.requestRender();
  }

  /** Reflect the pending attachments in the strip above the prompt. */
  function syncAttachments() {
    attachmentView.setFiles(
      pendingFiles.flatMap(({ part, token }) =>
        part.type === "text" ? [] : [{ ...summarizeAttachment(part), token }],
      ),
    );
    tui.requestRender();
  }

  /** Admit one path and insert its Codex-style placeholder at the cursor. */
  function attachFile(path: string) {
    if (closing || busy || starting || startupFailed) return;
    void runBusy(async () => {
      const part = await runtime.attach(path);
      if (part.type === "text") return;
      const token = attachmentToken(part.type, nextAttachmentNumber++);
      pendingFiles.push({ part, token });
      syncAttachments();
      editor.insertTextAtCursor(token);
    }, "Error");
  }

  function clearQueue() {
    const count = queue.length;
    for (const item of queue) queueView.removeChild(item.view);
    queue.length = 0;
    if (count && !closing) update();
    return count;
  }

  function enqueue(text: string, attachments: PendingFile[] = pendingFiles) {
    editor.addToHistory(text);
    editor.setText("");
    // The queued message owns the attachments it was submitted with; clear the
    // composer strip now so later attachments belong to the next message.
    pendingFiles = pendingFiles.filter((file) => !attachments.includes(file));
    syncAttachments();
    // The text already carries [Image #N] / [File #N] placeholders.
    const view = new QueuedMessage(text);
    queue.push({ text, view, attachments });
    queueView.addChild(view);
    scroll.scrollToEnd();
    update();
  }

  function drainQueue() {
    if (closing || running || stopping || decision || !queue.length) return;
    const next = queue.shift()!;
    queueView.removeChild(next.view);
    submittingQueued = true;
    try {
      void submit(next.text, next.attachments);
    } finally {
      submittingQueued = false;
    }
    update();
  }

  function ask(message: string, signal?: AbortSignal) {
    if (closing || signal?.aborted) return Promise.resolve(null);
    if (decision) return Promise.reject(new Error("Another question is already open."));
    add("Input", message);
    editor.setText("");
    return new Promise<string | null>((resolve) => {
      const settle = (value: string | null) => {
        signal?.removeEventListener("abort", abort);
        decision = undefined;
        editor.setText("");
        update();
        resolve(value);
      };
      const abort = () => settle(null);
      decision = settle;
      signal?.addEventListener("abort", abort, { once: true });
      update();
    });
  }

  const callbacks: Callbacks = {
    onAuth: async (method, params, signal) => {
      if (signal?.aborted) return null;
      if (method === "lazydsh/auth-notice") {
        add("Login", [params.message, params.url, params.code].filter(Boolean).join("\n"));
        void openAuthUrl(params.url);
        return null;
      }
      const message = typeof params.message === "string" ? params.message : "Login";
      if (params.kind === "secret") {
        add("Login", message);
        return new Promise<string | null>((resolve) => {
          const input = new SecretInput({ prompt: accent("┃ ") });
          let settled = false;
          const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            input.setValue("");
            decision = undefined;
            dismissPanel();
            resolve(value);
          };
          const abort = () => settle(null);
          signal?.addEventListener("abort", abort, { once: true });
          input.onSubmit = settle;
          input.onEscape = () => settle(null);
          decision = settle;
          showPanel(input);
        });
      }
      if (params.kind === "select" && Array.isArray(params.options)) {
        if (decision) throw new Error("Another question is already awaiting an answer.");
        const items = params.options as { id: string; label: string; description?: string }[];
        if (!items.length) return null;
        return new Promise<string | null>((resolve) => {
          let settled = false;
          const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", abort);
            decision = undefined;
            dismissPanel();
            update();
            resolve(value);
          };
          const abort = () => settle(null);
          const picker = select(
            items.map((item) => ({
              value: item.id,
              label: item.label,
              description: item.description,
            })),
            message,
            settle,
            undefined,
            false,
          );
          picker.onCancel = abort;
          decision = abort;
          signal?.addEventListener("abort", abort, { once: true });
          update();
        });
      }
      return ask(message, signal);
    },
    onApproval: async (params) => {
      if (closing || params.signal?.aborted) return { outcome: "cancelled" };
      if (decision) throw new Error("Another question is already awaiting an answer.");
      return new Promise<{ outcome: "allowed-once" | "rejected" | "cancelled" }>((resolve) => {
        // The pending tool-call row already holds the exact arguments; approval
        // requests only carry the call ID, so show them while deciding.
        const callArguments = toolLog.find(params.callId)?.callArguments;
        const panel = new ApprovalPanel(
          {
            toolName: params.toolName,
            reason: params.displayReason?.en ?? params.reason,
            ...(callArguments === undefined ? {} : { arguments: callArguments }),
          },
          panelHeight,
        );
        let settled = false;
        const settle = (outcome: "allowed-once" | "rejected" | "cancelled") => {
          if (settled) return;
          settled = true;
          params.signal?.removeEventListener("abort", abort);
          decision = undefined;
          dismissPanel();
          add(
            "Permission",
            outcome === "allowed-once"
              ? `${params.toolName}: allowed once`
              : `${params.toolName}: ${outcome}`,
          );
          resolve({ outcome });
        };
        const abort = () => settle("cancelled");
        panel.onSelect = settle;
        panel.onCancel = abort;
        decision = abort;
        params.signal?.addEventListener("abort", abort, { once: true });
        showPanel(panel);
        update();
      });
    },
    onUserQuestion: async (request, { signal }) => {
      if (closing || signal.aborted) return { cancelled: true };
      if (decision) throw new Error("Another question is already awaiting an answer.");
      return new Promise((resolve) => {
        // The status row stays below the panel, so the question gets the rest of
        // the composer and can show as many choices as fit instead of one row.
        // Measure on every frame so a resize cannot push the panel off screen.
        const panel = new QuestionPanel(request.questions, panelHeight);
        let settled = false;
        const settle = (answer: QuestionResult) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          decision = undefined;
          dismissPanel();
          if ("answers" in answer)
            add(
              "Answered",
              answer.answers
                .map((item) => [...item.selected, ...(item.custom ? [item.custom] : [])].join(", "))
                .join(" · "),
            );
          resolve(answer);
        };
        const abort = () => settle({ cancelled: true });
        panel.onAnswer = settle;
        panel.onCancel = abort;
        decision = abort;
        signal.addEventListener("abort", abort, { once: true });
        showPanel(panel);
        update();
      });
    },
  };

  async function persistSelection() {
    const selection = runtime.selection();
    if (selection) await saveModel(preferencesPath(options.dshHome), selection);
  }

  async function connect(
    nextRoute: Route,
    sessionId?: string,
    notifyModel = false,
    startup = false,
    directory?: string,
    connectionOptions: { keepTranscript?: boolean } = {},
  ) {
    pendingStartupConnection = undefined;
    busy = true;
    update();
    try {
      const id = await runtime.open(nextRoute, { ...callbacks, resume: sessionId });
      if (closing) return;
      const requestedDirectory =
        directory ??
        (sessionId !== undefined && sessionId === initial.resume ? resumeDirectory : undefined);
      if (sessionId !== undefined && requestedDirectory !== undefined) {
        await runtime.cd(requestedDirectory);
        if (resumeDirectory === requestedDirectory) resumeDirectory = undefined;
      }
      await persistSelection();
      commands = commandMenu(await runtime.commands());
      options.cwd = await runtime.cd();
      setAutocomplete();
      continuationId = id;
      pendingFiles = [];
      nextAttachmentNumber = 1;
      syncAttachments();
      toolLog.entries.clear();
      clearQueue();
      if (!connectionOptions.keepTranscript) transcript.clear();
      if (sessionId) {
        for (const row of historyRows(await runtime.history(), id)) {
          if (row instanceof ThinkingView || row instanceof ToolRow) transcript.addChild(row);
          else if (row.kind === "metrics") transcript.addChild(new Text(dim(row.text), 2, 1));
          else if (row.kind === "user") add("You", row.text, false, row.attachments);
          else
            add(
              row.kind === "assistant" ? "assistant" : (row.label ?? "dsh"),
              row.text,
              row.kind === "assistant",
            );
        }
        scroll.scrollToEnd();
      }
      route = nextRoute;
      if (notifyModel) add("Model", `${nextRoute.provider} / ${nextRoute.model}`);
      stats = undefined;
      await refreshStats();
      resume = undefined;
      if (sessionId) add("Resumed", id);
      if (requestedDirectory !== undefined) add("Directory", requestedDirectory);
      void probeCredentialSource(nextRoute.provider);
    } catch (error) {
      decision?.(null);
      await runtime.close();
      if (startup && isAuthFailure(error))
        pendingStartupConnection = { route: nextRoute, sessionId };
      else if (!closing)
        add(
          "Error",
          `${error instanceof Error ? error.message : String(error)}\n${
            isAuthFailure(error)
              ? `Run /login ${nextRoute.provider}, then resend.`
              : "Run /model to choose another model."
          }`,
        );
    } finally {
      busy = false;
      if (!closing) update();
    }
  }

  // Codex-compatible chat lifecycle: both commands start a new session, but
  // /new keeps the previous transcript visible while /clear wipes it first.
  async function startNewConversation(clearScreen: boolean) {
    if (clearScreen) {
      transcript.clear();
      scroll.scrollToEnd();
      tui.resetTextSelection();
      update();
    }
    if (!route.model) {
      void pickModel();
      return;
    }
    await connect(
      { provider: route.provider, model: route.model },
      undefined,
      false,
      false,
      undefined,
      { keepTranscript: true },
    );
    if (closing || !runtime.session) return;
    add("New conversation", runtime.session.id);
    scroll.scrollToEnd();
    update();
  }

  function dismissPanel() {
    selecting = false;
    composer.clear();
    composer.addChild(attachmentView);
    composer.addChild(editor);
    composer.addChild(status);
    tui.setFocus(editor);
    tui.requestRender();
  }

  function showPanel(panel: Component) {
    selecting = true;
    composer.clear();
    composer.addChild(panel);
    composer.addChild(status);
    tui.setFocus(panel);
    tui.requestRender();
  }

  /** Rows a question/approval panel may use above the always-visible status row. */
  function panelHeight() {
    return Math.max(1, tui.terminal.rows - status.render(Math.max(1, tui.terminal.columns)).length);
  }

  function select(
    items: import("@earendil-works/pi-tui").SelectItem[],
    title: string,
    onSelect: (value: string) => void,
    selected?: string,
    searchable = true,
  ) {
    const picker = new SearchPicker(
      items,
      title,
      Math.max(1, Math.min(6, tui.terminal.rows - 10)),
      selected,
      searchable,
    );
    picker.onCancel = dismissPanel;
    picker.onSelect = (value) => {
      dismissPanel();
      onSelect(value);
    };
    showPanel(picker);
    return picker;
  }

  async function chooseResumeDirectory(sessionId: string) {
    const sessionDirectory = await runtime.sessionDirectory(sessionId);
    if (!sessionDirectory || (await sameDirectory(sessionDirectory, options.cwd))) return undefined;
    const choice = await new Promise<string | null>((resolve) => {
      const picker = select(
        resumeDirectoryOptions(sessionDirectory, options.cwd),
        "Resume in directory",
        resolve,
        "session",
        false,
      );
      picker.onCancel = () => {
        dismissPanel();
        resolve(null);
      };
    });
    return choice === null ? null : resumeDirectoryTarget(choice, options.cwd);
  }

  async function pickModel(sessionId = runtime.session?.id ?? resume) {
    const { providers } = await import("./catalog.ts");
    const providerPicker = select(
      providers.map((id) => ({ value: id, label: id })),
      "Providers",
      (provider) => {
        void pickProviderModel(provider, sessionId, providerPicker);
      },
      undefined,
      true,
    );
  }

  async function pickProviderModel(provider: string, sessionId?: string, parent?: SearchPicker) {
    const { models } = await import("./catalog.ts");
    const picker = select(
      models(provider).map((model) => ({
        value: model.id,
        label: model.id,
        description: model.name,
      })),
      "Models",
      (model) => {
        void connect({ provider, model }, sessionId, true);
      },
      undefined,
      true,
    );
    picker.onCancel = () => {
      if (parent) showPanel(parent);
      else void pickModel(sessionId);
    };
  }

  function chooseAuthProvider(command: "login" | "logout") {
    return new Promise<string | null>((resolve) => {
      const picker = select(
        runtime.authProviders(),
        command === "login" ? "Choose a provider to log in to" : "Choose a provider to log out of",
        (value) => resolve(value),
        undefined,
        true,
      );
      picker.onCancel = () => {
        dismissPanel();
        resolve(null);
      };
    });
  }

  function announceCredentialSource(provider: string, source: CredentialSource) {
    if (source.kind !== "environment") {
      announcedAuth.delete(provider);
      return;
    }
    if (announcedAuth.has(provider)) return;
    announcedAuth.add(provider);
    add("Credentials", `Using ${source.label} for ${provider}. Unset it to switch.`);
  }

  async function probeCredentialSource(provider: string) {
    try {
      announceCredentialSource(provider, await runtime.credentialSource(provider));
    } catch {
      // An auth-source probe must never interrupt the UI.
    }
  }

  async function signIn(provider?: string) {
    await runBusy(async () => {
      provider ??= (await chooseAuthProvider("login")) ?? undefined;
      if (provider === undefined || closing) return;
      try {
        const notice = await runtime.authenticate(options.signal, {
          provider,
          onAuth: callbacks.onAuth,
        });
        if (notice !== undefined) {
          add("Login", notice);
          return;
        }
      } catch (error) {
        if (closing) return;
        if (error instanceof AuthorizationDeclinedError) {
          add("Login", "Cancelled.");
          return;
        }
        throw error;
      }
      if (closing) return;
      // A startup connection that failed before login can now be retried.
      const pending = pendingStartupConnection;
      if (pending && !runtime.session) {
        pendingStartupConnection = undefined;
        await connect(pending.route, pending.sessionId);
      }
      announcedAuth.delete(provider);
      add("Logged in", provider);
      if (blockedPrompt !== undefined) {
        if (editor.getText().length === 0) editor.setText(blockedPrompt);
        blockedPrompt = undefined;
        update();
      }
    }, "Error");
  }

  async function signOut(provider?: string) {
    await runBusy(async () => {
      provider ??= (await chooseAuthProvider("logout")) ?? undefined;
      if (provider === undefined || closing) return;
      const remaining = await runtime.logout(provider);
      if (closing) return;
      if (remaining === undefined) {
        add("Logout", `Not logged in to ${provider}.`);
        return;
      }
      announcedAuth.delete(provider);
      add("Logged out", provider);
      if (remaining.length)
        add("Credentials", `Still available from ${remaining.join(", ")}. Unset to disconnect.`);
    }, "Error");
  }

  async function stop() {
    if (closing) return;
    closing = true;
    decision?.(null);
    selecting = false;
    update();
    try {
      await runtime.close();
    } catch (error) {
      add("Error", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      finish();
    }
  }

  /** Stop the live turn but keep the chat open (Esc / Ctrl+C). */
  function cancelTurn() {
    if (stopping) return;
    const queued = queue.length;
    stopping = true;
    update();
    void runtime
      .cancel()
      .then(() => {
        // A queued prompt starts as soon as the turn stops, so a notice saying
        // the turn was cancelled would only be noise there.
        if (queued === 0) add("Interrupted");
      })
      .catch((error) => add("Error", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        stopping = false;
        drainQueue();
        update();
      });
  }

  async function submit(text: string, queuedAttachments?: PendingFile[]) {
    const fromQueue = submittingQueued;
    if (closing) return;
    const attachments = fromQueue ? (queuedAttachments ?? []) : pendingFiles.slice();
    // A command line is not a prompt draft, so its attachment tokens do not
    // apply; ordinary prompts send only attachments whose placeholders remain.
    const liveAttachments = /^\s*\//.test(text)
      ? attachments
      : attachments.filter(({ part, token }) => part.type === "text" || text.includes(token));
    if (!fromQueue && !/^\s*\//.test(text)) {
      pendingFiles = pendingFiles.filter((file) => liveAttachments.includes(file));
      syncAttachments();
    }
    if (decision) {
      decision(text);
      return;
    }
    const hasContent = text.trim().length > 0 || liveAttachments.length > 0;
    if (!fromQueue && (busy || starting || startupFailed || !hasContent)) return;
    if (running && !canRunDuringTurn(text)) {
      if (shouldQueueDuringTurn(text) || (liveAttachments.length > 0 && !text.trim())) {
        enqueue(text, liveAttachments);
        return;
      }
      add("Error", "A response is running. Press Esc or Ctrl+C to stop it.");
      return;
    }
    if (
      pendingStartupConnection &&
      !runtime.session &&
      !/^\/(?:model|new|clear|quit)(?:\s|$)/.test(text)
    ) {
      const pending = pendingStartupConnection;
      void connect(pending.route, pending.sessionId).then(() => {
        if (!closing && runtime.session) editor.onSubmit?.(text);
      });
      return;
    }
    const draft = fromQueue ? undefined : editor.getText();
    if (!/^\s*\//.test(text) && runtime.session) {
      if (checkingAuth) return;
      const provider = runtime.selection()?.provider ?? route.provider;
      checkingAuth = true;
      let source: CredentialSource = {
        kind: "unknown",
        label: "Provider-managed credentials",
      };
      try {
        source = await runtime.credentialSource(provider);
      } catch (error) {
        if (!closing) add("Error", error instanceof Error ? error.message : String(error));
      } finally {
        checkingAuth = false;
      }
      if (closing) return;
      if (source.kind === "none") {
        if (!fromQueue && editor.getText() === draft) {
          editor.addToHistory(text);
          editor.setText("");
          blockedPrompt = text;
        } else if (!fromQueue) blockedPrompt = undefined;
        add("Error", `Not logged in to ${provider}. Run /login ${provider}.`);
        update();
        return;
      }
      announceCredentialSource(provider, source);
      blockedPrompt = undefined;
    }
    if (!fromQueue) {
      editor.addToHistory(text);
      if (editor.getText() === draft) editor.setText("");
    }
    add("You", text);
    if (text === "/clear") {
      void startNewConversation(true);
      return;
    }
    if (text === "/quit") {
      void stop();
      return;
    }
    if (text === "/model") {
      void pickModel();
      return;
    }
    if (text === "/new") {
      void startNewConversation(false);
      return;
    }
    const authCommand = /^\/(login|logout)(?:\s+(.*))?$/.exec(text);
    if (authCommand) {
      const action = authCommand[1] as "login" | "logout";
      const argument = authCommand[2]?.trim();
      if (argument && /\s/.test(argument)) {
        add("Error", `Usage: /${action} [provider]`);
        return;
      }
      const provider = argument ? normalizeProvider(argument) : undefined;
      if (provider !== undefined) {
        const available = runtime.authProviders();
        if (!available.some((item) => item.value === provider)) {
          add(
            "Error",
            `Unknown provider: ${provider}. Choose from: ${available.map((item) => item.value).join(", ")}.`,
          );
          return;
        }
      }
      if (action === "login") void signIn(provider);
      else void signOut(provider);
      return;
    }
    if (!runtime.session) {
      add("Error", "No model selected. Run /model.");
      return;
    }
    const renameCommand = /^\/rename(?:\s+([\s\S]*))?$/.exec(text);
    if (renameCommand) {
      const id = runtime.session.id;
      void runBusy(async () => {
        const title = renameCommand[1]?.trim() || (await ask("New session title (Esc to cancel)"));
        if (title !== null) add("Renamed", await runtime.renameSession(id, title));
      });
      return;
    }
    if (text === "/fork") {
      const points = runtime.forkPoints().reverse();
      if (!points.length) {
        add("Error", "No completed turns to fork from.");
        return;
      }
      select(points, "Fork at turn", (boundary) => {
        void runBusy(async () => {
          const childId = await runtime.forkSession(Number(boundary));
          await connect(route as Route, childId);
          add("Forked", childId);
        });
      });
      return;
    }
    const sessionAction = /^\/(archive|restore|pin|unpin)$/.exec(text)?.[1] as
      | "archive"
      | "restore"
      | "pin"
      | "unpin"
      | undefined;
    if (sessionAction) {
      const title = {
        archive: "Archive conversation",
        restore: "Restore conversation",
        pin: "Pin conversation",
        unpin: "Unpin conversation",
      }[sessionAction];
      const picker = select([], title, (id) => {
        void runBusy(async () => {
          await runtime.manageSession(id, sessionAction);
          if (sessionAction === "archive" && runtime.session?.id === id)
            await connect(route as Route);
          const label = {
            archive: "Archived",
            restore: "Restored",
            pin: "Pinned",
            unpin: "Unpinned",
          }[sessionAction];
          add(label, records.find((record) => record.id === id)?.title ?? id);
        });
      });
      picker.setLoading();
      let records: Awaited<ReturnType<Runtime["sessions"]>> = [];
      void runtime
        .sessions()
        .then((next) => {
          records = next.filter((record) =>
            sessionAction === "restore"
              ? record.archived
              : !record.archived &&
                (sessionAction === "pin"
                  ? !record.pinned
                  : sessionAction === "unpin"
                    ? record.pinned
                    : true),
          );
          if (composer.children.includes(picker))
            picker.setItems(
              records.map((record) => ({
                value: record.id,
                label: record.title,
                description: [record.id === runtime.session?.id ? "Current" : "", record.directory]
                  .filter(Boolean)
                  .join(" · "),
              })),
            );
          tui.requestRender();
        })
        .catch((error) => {
          if (composer.children.includes(picker)) dismissPanel();
          add("Error", error instanceof Error ? error.message : String(error));
        });
      return;
    }
    const jobCommand = /^\/(ps|stop)(?:\s+(\S+))?$/.exec(text);
    if (jobCommand) {
      const stopping = jobCommand[1] === "stop";
      const perform = async (id: string) => {
        const result = await runtime.job(id, stopping);
        if (stopping) add("Job", `${id} · ${result}`);
        else {
          transcript.addChild(new Text(safeText(result), 2, 1));
          tui.requestRender();
        }
      };
      const handleError = (error: unknown) =>
        add("Error", error instanceof Error ? error.message : String(error));
      if (jobCommand[2]) void perform(jobCommand[2]).catch(handleError);
      else {
        const picker = select([], stopping ? "Stop job" : "Background jobs", (id) => {
          void perform(id).catch(handleError);
        });
        picker.setLoading();
        void runtime
          .jobs()
          .then((jobs) => {
            if (composer.children.includes(picker))
              picker.setItems(
                jobs
                  .filter(
                    (job) => !stopping || job.status === "running" || job.status === "stopping",
                  )
                  .map((job) => ({
                    value: job.id,
                    label: job.label,
                    description: `${job.status} · ${job.id}${job.progress ? " · " + job.progress : ""}`,
                  })),
              );
            tui.requestRender();
          })
          .catch((error) => {
            dismissPanel();
            handleError(error);
          });
      }
      return;
    }
    const choiceCommand = /^\/(resume|cd|permission)(?:\s+(.*))?$/.exec(text);
    if (choiceCommand) {
      const name = choiceCommand[1];
      const argument = choiceCommand[2]?.trim();
      const kind = name === "resume" ? "sessions" : name === "cd" ? "directories" : "permissions";
      const apply = async (value: string) => {
        if (name === "resume") {
          if (!route.model) throw new Error("Select a model first with /model.");
          const directory = await chooseResumeDirectory(value);
          if (directory === null) return;
          await connect(
            { provider: route.provider, model: route.model },
            value,
            false,
            false,
            directory,
          );
        } else if (name === "cd") {
          options.cwd = await runtime.cd(value);
          setAutocomplete();
          add("Directory", options.cwd);
        } else {
          await runtime.choices(kind, value);
          add("Permission", value);
        }
      };
      void runBusy(async () => {
        if (argument) await apply(argument);
        else {
          const picker = select(
            [],
            name === "resume" ? "Sessions" : name === "cd" ? "Directories" : "Permissions",
            (value) => {
              void runBusy(() => apply(value));
            },
            undefined,
            name !== "permission",
          );
          picker.setLoading();
          try {
            const choices = await runtime.choices(kind);
            if (composer.children.includes(picker))
              picker.setItems(choices.options, choices.current);
          } catch (error) {
            if (composer.children.includes(picker)) dismissPanel();
            throw error;
          }
        }
      });
      return;
    }
    if (runtime.authFailed && text.startsWith("/") && text !== "/status") {
      add("Error", "Login failed. Run /login.");
      return;
    }
    if (text === "/session") {
      add("Session", runtime.session?.id ?? "No active session.");
      return;
    }
    if (text === "/effort") {
      const picker = select(
        [],
        "Reasoning effort",
        (value) => {
          editor.onSubmit?.(`/effort ${value}`);
        },
        undefined,
        false,
      );
      picker.setLoading();
      busy = true;
      update();
      void runtime
        .efforts()
        .then((info) => {
          if (!composer.children.includes(picker)) return;
          picker.setItems(
            [
              {
                value: "default",
                label: "Default",
                description: info.defaultEffort
                  ? `Provider default (${info.defaultEffort})`
                  : "Use provider defaults",
              },
              ...info.options.map((option) => ({
                value: option.id,
                label: option.name,
                description: option.description,
              })),
            ],
            info.current,
          );
        })
        .catch((error) => {
          if (composer.children.includes(picker)) dismissPanel();
          add("Error", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          busy = false;
          update();
        });
      return;
    }
    if (text === "/status") {
      busy = true;
      update();
      let panel: StatusPanel | undefined;
      const showSnapshot = (next: SessionStats) => {
        if (closing) return;
        stats = next;
        if (panel) panel.updateStats(next);
        else {
          panel = new StatusPanel(next);
          transcript.addChild(panel);
        }
        tui.requestRender();
      };
      void runtime
        .stats(!running, showSnapshot)
        .then(showSnapshot)
        .catch((error) => {
          if (panel) transcript.removeChild(panel);
          stats = undefined;
          add("Error", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          busy = false;
          update();
        });
      return;
    }
    if (text === "/dsh") {
      add("dsh", "Usage: /dsh <command> [arguments]");
      return;
    }
    if (text.startsWith("/dsh ")) text = "/" + text.slice(5).trimStart().replace(/^\//, "");
    if (!fromQueue) {
      // The turn is committed: clear exactly the attachments it carries so a
      // file attached during the request still belongs to the next message.
      pendingFiles = pendingFiles.filter((file) => !liveAttachments.includes(file));
      syncAttachments();
    }
    const ownsTurn = !running;
    if (ownsTurn) running = true;
    else busy = true;
    update();
    void (async () => {
      let lastAssistant: string | undefined;
      let liveAnswer: StreamingMarkdown | undefined;
      const attemptUsage = new Map<string, { input: number; output: number }>();
      const startedAt = performance.now();
      let sawModelAttempt = false;
      try {
        const result = await runtime.run(
          text,
          (notification) => {
            if (
              ownsTurn &&
              notification.method === "lazydsh.thinking" &&
              notification.params.sessionId === runtime.session?.id
            ) {
              const frame = notification.params;
              if (frame.type === "start") {
                sawModelAttempt = true;
                beginThinking(frame.attemptId);
              } else if (frame.type === "end") {
                if (thinking && thinkingAttempt === frame.attemptId) settleThinking();
              } else if (frame.type === "usage") {
                const tokens = frame.usage;
                attemptUsage.set(frame.attemptId, {
                  input:
                    tokens.inputTokens +
                    (tokens.cacheReadTokens ?? 0) +
                    (tokens.cacheWriteTokens ?? 0),
                  output: tokens.outputTokens,
                });
              }
              tui.requestRender();
              return;
            }
            if (
              notification.method === "assistant.reasoning" &&
              notification.params.sessionId === runtime.session?.id
            ) {
              beginThinking(notification.params.attemptId).appendReasoning(
                notification.params.text,
              );
              tui.requestRender();
              return;
            }
            if (
              notification.method === "assistant.delta" &&
              notification.params.sessionId === runtime.session?.id
            ) {
              completeThinking();
              if (!liveAnswer || !transcript.children.includes(liveAnswer)) {
                liveAnswer = new StreamingMarkdown(markdownTheme);
                transcript.addChild(liveAnswer);
              }
              liveAnswer.append(notification.params.index, notification.params.text);
              tui.requestRender();
              return;
            }
            if (
              notification.params.sessionId === runtime.session?.id &&
              notification.method === "session.event"
            ) {
              const event = notification.params.event;
              if (event.type === "assistant/attempt" && liveAnswer) {
                transcript.removeChild(liveAnswer);
                liveAnswer = undefined;
              }
              if (event.type === "assistant/message") {
                completeThinking();
                const reasoning = reasoningText(event.data.message.content);
                if (reasoning.trim() && thinking && !thinking.hasReasoning)
                  thinking.setReasoning(reasoning);
              }
            }
            const output = eventText(notification);
            if (!output) return;
            if (output.kind !== "assistant") {
              const row = toolLog.record(output);
              if (row) transcript.addChild(row);
              tui.requestRender();
              return;
            }
            if (!output.text) return;
            lastAssistant = output.text;
            if (liveAnswer && notification.params.sessionId === runtime.session?.id) {
              liveAnswer.setFinal(output.text);
              if (!transcript.children.includes(liveAnswer)) transcript.addChild(liveAnswer);
              liveAnswer = undefined;
              tui.requestRender();
            } else add("assistant", output.text, true);
          },
          liveAttachments.flatMap(({ part }) => (part.type === "text" ? [] : [part])),
        );
        if (result.finishReason === "completed") {
          if (/^\/effort\s+\S/.test(text.trim())) await persistSelection();
        }
        if (result.finalResponse && result.finalResponse !== lastAssistant)
          add(result.finishReason === "error" ? "Error" : "dsh", result.finalResponse, true);
        else if (result.finishReason === "error") add("Error", "dsh reported an error.");
      } catch (error) {
        if (!closing) add("Error", error instanceof Error ? error.message : String(error));
      } finally {
        if (ownsTurn) {
          settleThinking();
          if (sawModelAttempt && !closing) {
            const totals = [...attemptUsage.values()].reduce(
              (sum, item) => ({
                input: sum.input + item.input,
                output: sum.output + item.output,
              }),
              { input: 0, output: 0 },
            );
            const tokens = attemptUsage.size
              ? ` (↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)})`
              : "";
            transcript.addChild(
              new Text(
                dim(`${formatDuration((performance.now() - startedAt) / 1000)}${tokens}`),
                2,
                1,
              ),
            );
          }
          running = false;
        } else busy = false;
        tui.requestRender();
        if (ownsTurn && !closing) drainQueue();
        if (!closing) await refreshStats();
      }
    })();
  }

  editor.onSubmit = (text) => void submit(text);

  tui.addInputListener((data) => {
    if (!selecting && !decision && !busy && !starting && !startupFailed && !closing) {
      // Dragging a file into the terminal arrives as bracketed paste text.
      // Attach image paths instead of dumping the path into the prompt.
      const dropped = pastedImagePath(data);
      if (dropped !== undefined) {
        const path = resolve(options.cwd, dropped);
        try {
          if (existsSync(path) && statSync(path).isFile()) {
            attachFile(path);
            return { consume: true };
          }
        } catch {}
      }
    }
    if (matchesKey(data, "ctrl+c")) {
      const action = ctrlCAction({
        draft: editor.getText().length > 0 || pendingFiles.length > 0,
        active: running,
        cancelling: stopping,
      });
      if (action === "clear") {
        editor.setText("");
        pendingFiles = [];
        nextAttachmentNumber = 1;
        syncAttachments();
        update();
      } else if (action === "interrupt") cancelTurn();
      else void stop();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && !selecting) {
      if (decision) decision(null);
      else if (busy || running) cancelTurn();
      return { consume: true };
    }
  });
  const signalHandler = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", signalHandler, { once: true });
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  let restoreConsole: (() => void) | undefined;
  try {
    // DSH provider plugins write diagnostics with console.warn/error. The TUI
    // owns the terminal, so capture those lines in a log instead of letting
    // them corrupt the chat area.
    restoreConsole = captureConsole(
      dshCachePath({ dshHome: options.dshHome }, "lazydsh", "tui.log"),
    );
    tui.start();
    update();
    if (hooks.afterFirstPaint) {
      // Paint the startup screen before optional plugins are imported, then
      // keep submit disabled until their tools are registered.
      starting = true;
      update();
      tui.renderNow();
      try {
        await hooks.afterFirstPaint();
      } catch (error) {
        startupFailed = true;
        add("Error", error instanceof Error ? error.message : String(error));
      } finally {
        starting = false;
        update();
      }
    }
    if (!startupFailed) {
      if (route.model)
        await connect({ provider: route.provider, model: route.model }, resume, false, true);
      else {
        const { providers } = await import("./catalog.ts");
        if (providers.includes(route.provider)) await pickProviderModel(route.provider, resume);
        else await pickModel();
      }
    }
    await done;
  } finally {
    options.signal?.removeEventListener("abort", signalHandler);
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    decision?.(null);
    thinking?.finish();
    tui.stop({ preserveScreen: true });
    try {
      await runtime.close();
    } finally {
      restoreConsole?.();
    }
    if (continuationId) console.log(continuationCommand(continuationId, initial.resumeArgs));
  }
}
