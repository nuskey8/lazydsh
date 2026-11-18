import {
  Container,
  Input,
  ProcessTerminal,
  Text,
  TuiAltScreen,
  matchesKey,
} from "@earendil-works/pi-tui";
import { AuthorizationDeclinedError } from "@deepseek-ai/dsh-authorization";
import { SecretInput } from "./presentation.ts";
import { accent, safeText } from "./theme.ts";
import { openAuthUrl } from "./open-url.ts";
import { SearchPicker } from "./picker.ts";
import type { Runtime } from "./runtime.ts";

export async function terminalAuth(
  runtime: Runtime,
  command: "login" | "logout",
  provider: string | undefined,
  lifetimeSignal: AbortSignal,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Provider selection and login require an interactive terminal.");
  const controller = new AbortController();
  const signal = AbortSignal.any([lifetimeSignal, controller.signal]);
  const tui = new TuiAltScreen(new ProcessTerminal());
  const notices = new Container();
  const prompt = new Container();
  tui.addChild(notices);
  tui.addChild(prompt);
  const chooseProvider = provider === undefined;
  let providerPicker: SearchPicker | undefined;
  let pending: ((value: string | null) => void) | undefined;
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      controller.abort();
      pending?.(null);
      return { consume: true };
    }
  });
  try {
    signal.throwIfAborted();
    tui.start();
    while (true) {
      if (!provider)
        provider = await new Promise<string>((resolve, reject) => {
          let settled = false;
          const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            pending = undefined;
            prompt.clear();
            if (value === null) reject(new Error("Provider selection cancelled."));
            else resolve(value);
          };
          const abort = () => settle(null);
          pending = settle;
          signal.addEventListener("abort", abort, { once: true });
          const picker = (providerPicker ??= new SearchPicker(
            runtime.authProviders(),
            command === "login"
              ? "Choose a provider to log in to"
              : "Choose a provider to log out of",
            6,
            undefined,
            true,
          ));
          picker.onSelect = settle;
          picker.onCancel = abort;
          prompt.addChild(picker);
          tui.setFocus(picker);
          tui.requestRender();
        });
      if (command === "logout") return { provider };
      try {
        const notice = await runtime.authenticate(signal, {
          provider,
          onAuth: async (method, params, promptSignal) => {
            if (signal.aborted || promptSignal?.aborted) return null;
            if (method === "lazydsh/auth-notice") {
              notices.addChild(
                new Text(
                  safeText([params.message, params.url, params.code].filter(Boolean).join("\n")),
                  2,
                  1,
                ),
              );
              tui.requestRender();
              void openAuthUrl(params.url);
              return null;
            }
            if (pending) throw new Error("Another login prompt is already open.");
            return new Promise<string | null>((resolve) => {
              const message = typeof params.message === "string" ? params.message : "Login";
              const input =
                params.kind === "secret"
                  ? new SecretInput({ prompt: accent("┃ ") })
                  : new Input({ prompt: accent("┃ ") });
              let settled = false;
              const settle = (value: string | null) => {
                if (settled) return;
                settled = true;
                promptSignal?.removeEventListener("abort", abort);
                signal.removeEventListener("abort", abort);
                input.setValue("");
                pending = undefined;
                prompt.clear();
                tui.requestRender();
                resolve(value);
              };
              const abort = () => settle(null);
              pending = settle;
              promptSignal?.addEventListener("abort", abort, { once: true });
              signal.addEventListener("abort", abort, { once: true });
              prompt.clear();
              if (params.kind === "select" && Array.isArray(params.options)) {
                const picker = new SearchPicker(
                  (params.options as { id: string; label: string; description?: string }[]).map(
                    (item) => ({
                      value: item.id,
                      label: item.label,
                      description: item.description,
                    }),
                  ),
                  message,
                  6,
                  undefined,
                  false,
                );
                picker.onSelect = settle;
                picker.onCancel = abort;
                prompt.addChild(picker);
                tui.setFocus(picker);
              } else {
                prompt.addChild(new Text(safeText(message), 2, 1));
                input.onSubmit = settle;
                input.onEscape = abort;
                prompt.addChild(input);
                tui.setFocus(input);
              }
              tui.requestRender();
            });
          },
        });
        return notice === undefined ? { provider } : { provider, notice };
      } catch (error) {
        if (!chooseProvider || signal.aborted || !(error instanceof AuthorizationDeclinedError))
          throw error;
        provider = undefined;
        notices.clear();
      }
    }
  } finally {
    pending?.(null);
    tui.stop({ preserveScreen: true });
  }
}
