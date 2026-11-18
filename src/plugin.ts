import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-cmdline";
import type { Runtime as RuntimeInstance, RuntimeOptions } from "./runtime.ts";
import {
  activateDeferredPlugins,
  applyDeferredPatches,
  RUNTIME_SERVICE_NAMES,
  waitForRuntimeServices,
  type DeferredPlan,
} from "./deferred.ts";
import { createPendingRuntime } from "./pending-runtime.ts";
import { loadModel, preferencesPath } from "./preferences.ts";
import { resolve } from "node:path";

export const name = "lazydsh";
// The shell must be paintable before the core plugins exist; service
// readiness is awaited explicitly once the deferred plugins have loaded.
export const inject = ["appReady", "appExit"];

export interface PluginOptions {
  cwd?: string;
  home?: string;
  provider?: string;
  model?: string;
  resume?: string;
  pickSession?: boolean;
  effort?: string;
  resumeArgs?: string[];
  command?: "ask" | "login" | "logout";
  prompt?: string;
  permission?: string;
  /** Emit the ask result as the DSH-compatible newline-delimited event stream. */
  json?: boolean;
  /** The provider catalog and pi-ai provider patch are applied after first paint. */
  catalogDeferred?: boolean;
  customPatches?: boolean;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    lazydshApp: { done: Promise<void> };
  }
}
/**
 * Create the Runtime under a context that declares the services it uses.
 * Cordis only permits property access for injected services, and the launcher
 * itself no longer injects them so that the shell can paint first.
 */
async function createRuntime(
  ctx: Context,
  options: RuntimeOptions,
  effort?: string,
): Promise<RuntimeInstance> {
  const [{ Runtime }, { ReasoningEffortId }] = await Promise.all([
    import("./runtime.ts"),
    import("@deepseek-ai/dsh-llm"),
  ]);
  let runtime: RuntimeInstance | undefined;
  const fiber = ctx.inject([...RUNTIME_SERVICE_NAMES], (runtimeCtx) => {
    runtime = new Runtime(runtimeCtx, {
      ...options,
      reasoningEffort: effort === undefined ? undefined : ReasoningEffortId(effort),
    });
  });
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    throw error;
  }
  if (runtime === undefined) throw new Error("lazydsh: Runtime did not start");
  return runtime;
}

export function apply(ctx: Context, config: PluginOptions = {}) {
  const lifetime = new AbortController();
  const completion = Promise.withResolvers<void>();
  ctx.provide("lazydshApp", { done: completion.promise });
  let task: Promise<void> | undefined;
  const start = async () => {
    const saved =
      config.command === "login" || config.command === "logout" || (config.provider && config.model)
        ? undefined
        : await loadModel(preferencesPath(config.home));
    const provider = config.provider ?? saved?.provider ?? "deepseek-official";
    const effort = config.effort ?? (config.provider && config.model ? undefined : saved?.effort);
    const model =
      config.model ??
      (config.provider === undefined || config.provider === saved?.provider
        ? saved?.model
        : undefined) ??
      (provider === "deepseek-official" ? "deepseek-flash" : undefined);
    const options: RuntimeOptions & { cwd: string } = {
      cwd: resolve(config.cwd ?? "."),
      dshHome: config.home,
      signal: lifetime.signal,
    };
    const plan = ctx.get("lazydshDeferred") as DeferredPlan | undefined;
    const fullDefer = plan?.full === true;
    const pending = fullDefer ? createPendingRuntime() : undefined;
    if (pending === undefined) await waitForRuntimeServices(ctx);
    const runtime = pending?.runtime ?? (await createRuntime(ctx, options, effort));
    if (config.command) {
      const { runCommand } = await import("./command-runner.ts");
      await runCommand(
        runtime,
        {
          ...config,
          command: config.command,
          provider:
            config.command === "login" || config.command === "logout" ? config.provider : provider,
          model,
        },
        lifetime.signal,
      );
      return;
    }
    let resume = config.resume;
    let resumeDirectory: string | undefined;
    if (config.pickSession) {
      const { selectSession } = await import("./session-select.ts");
      const selection = await selectSession(runtime, lifetime.signal, options.cwd);
      resume = selection?.id;
      resumeDirectory = selection?.directory;
      if (!resume) return;
    } else if (resume) {
      const { selectResumeDirectory } = await import("./session-select.ts");
      const selection = await selectResumeDirectory(runtime, resume, options.cwd, lifetime.signal);
      if (!selection) return;
      resumeDirectory = selection.directory;
    }
    const { runUI } = await import("./ui.ts");
    const deferred = plan?.rows ?? [];
    const afterFirstPaint =
      pending !== undefined
        ? async () => {
            let rows = deferred;
            if (config.catalogDeferred) {
              const catalog = await import("./catalog.ts");
              if (model !== undefined)
                catalog.validateRoute(
                  provider,
                  model,
                  config.customPatches === true ? ["custom"] : [],
                );
              rows = applyDeferredPatches(rows, catalog.providerPatch());
            }
            const packages = ctx.get("pluginPackages") as { refresh(): Promise<void> } | undefined;
            if (packages === undefined)
              throw new Error("lazydsh: package resolution is unavailable");
            await packages.refresh();
            await activateDeferredPlugins(ctx, rows);
            await waitForRuntimeServices(ctx);
            pending.attach(await createRuntime(ctx, options, effort));
          }
        : deferred.length > 0
          ? () => activateDeferredPlugins(ctx, deferred)
          : undefined;
    await runUI(
      options,
      {
        provider,
        model,
        resume,
        resumeDirectory,
        resumeArgs: config.resumeArgs ?? (config.home ? ["--home", resolve(config.home)] : []),
      },
      runtime,
      { afterFirstPaint },
    );
  };
  const removeReady = ctx.appReady!.onReady(() => {
    task = start();
    task.then(
      () => {
        completion.resolve();
        ctx.appExit!(0);
      },
      (error) => {
        completion.reject(error);
        ctx.appExit!(1);
      },
    );
  });
  ctx.effect(() => async () => {
    removeReady();
    lifetime.abort();
    await task?.catch(() => {});
    completion.resolve();
  });
}
