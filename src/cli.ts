#!/usr/bin/env node
import { formatNotification, terminalColor } from "./theme.ts";
import { loadModel, preferencesPath } from "./preferences.ts";
import { normalizeProvider } from "./provider.ts";
import type {} from "./plugin.ts";
import { parseArgs } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enableCompileCache } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";

// Keep V8's compile cache out of the OS temp directory so a reboot does not
// make the next launch recompile every plugin module.
function compileCacheDirectory(): string | undefined {
  if (process.env.NODE_COMPILE_CACHE) return undefined;
  const root =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : join(homedir(), ".cache"));
  return join(root, "lazydsh", "node-compile-cache");
}

try {
  const directory = compileCacheDirectory();
  if (directory === undefined) enableCompileCache();
  else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    enableCompileCache(directory);
  }
} catch {
  // A read-only home must not stop the CLI; fall back to the default cache.
  try {
    enableCompileCache();
  } catch {}
}

const color = terminalColor(process.stdout);
const heading = (text: string) => (color ? `\x1b[1;38;2;77;107;254m${text}\x1b[0m` : text);
const bold = (text: string) => (color ? `\x1b[1m${text}\x1b[22m` : text);
const row = (name: string, description: string) => `  ${bold(name.padEnd(24))}${description}`;
const flagHelp: Record<string, string> = {
  provider: row("--provider <id>", "Provider (default: last used, then deepseek-official)"),
  model: row("--model <id>", "Model (default: last used or provider default)"),
  effort: row("--effort <level>", "Initial reasoning effort"),
  permission: row("--permission <preset>", "Permission preset for ask (default: dsh policy)"),
  cwd: row("--cwd <path>", "Working directory (default: current directory)"),
  home: row("--home <path>", "DSH home directory"),
  resume: row("--resume <id>", "Continue a saved conversation"),
  patch: row("--patch <path>", "Additional dsh Cordis patch (repeatable)"),
  list: row("--list", "List providers and model IDs"),
  help: row("-h, --help", "Show help"),
  version: row("-v, --version", "Show version"),
};

function packageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    if (typeof manifest.version === "string") return manifest.version;
  } catch {}
  return "unknown";
}
const help = `${bold("lazydsh")} — A lazier terminal UI for DeepSeek Harness.

${heading("Usage:")}
  ${bold("lazydsh")} [flags]
  ${bold("lazydsh <command>")} [arguments] [flags]
  echo "prompt" | ${bold("lazydsh ask")} [flags]

${heading("Commands:")}
${row("ask [prompt]", "Run one noninteractive request")}
${row("resume [session-id]", "Continue a saved conversation")}
${row("login [provider]", "Log in with OAuth or an API key")}
${row("logout [provider]", "Remove saved provider credentials")}
${row("upgrade", "Update lazydsh to the latest version")}

${heading("Flags:")}
${Object.values(flagHelp).join("\n")}
`;

function commandHelp(command: string): string {
  const connectionFlags = ["provider", "model", "effort", "cwd", "home", "patch"];
  const authFlags = ["cwd", "home", "patch"];
  const pages: Record<
    string,
    {
      description: string;
      usage: string;
      argument?: [string, string];
      flags: string[];
    }
  > = {
    ask: {
      description: "Run one noninteractive request.",
      usage: "ask [prompt] [flags]",
      argument: ["[prompt]", "Prompt text; piped stdin is appended"],
      flags: [...connectionFlags, "permission", "resume"],
    },
    resume: {
      description: "Continue a saved conversation in the TUI.",
      usage: "resume [session-id] [flags]",
      argument: ["[session-id]", "ID of the conversation to continue; omit to choose a session"],
      flags: connectionFlags,
    },
    login: {
      description: "Log in to a provider without creating a conversation.",
      usage: "login [provider] [flags]",
      argument: ["[provider]", "Provider ID (optional; codex = openai-codex)"],
      flags: authFlags,
    },
    logout: {
      description: "Remove locally saved provider credentials.",
      usage: "logout [provider] [flags]",
      argument: ["[provider]", "Provider ID (optional; codex = openai-codex)"],
      flags: authFlags,
    },
    upgrade: {
      description: "Update lazydsh to the latest version.",
      usage: "upgrade",
      flags: [],
    },
  };
  const page = pages[command];
  return [
    `${bold("lazydsh " + command)} — ${page.description}`,
    "",
    heading("Usage:"),
    `  ${bold("lazydsh")} ${page.usage}`,
    ...(page.argument ? ["", heading("Arguments:"), row(...page.argument)] : []),
    "",
    heading("Flags:"),
    ...[...page.flags, "help", "version"].map((flag) => flagHelp[flag]),
    "",
  ].join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      permission: { type: "string" },
      cwd: { type: "string" },
      home: { type: "string" },
      resume: { type: "string" },
      patch: { type: "string", multiple: true, default: [] },
      list: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  const args = positionals.slice(1);
  if (command !== undefined && !["ask", "resume", "login", "logout", "upgrade"].includes(command))
    throw new Error(`Unknown command: ${command}. Run lazydsh --help for available commands.`);
  if (values.help) return console.log(command ? commandHelp(command) : help);
  if (values.version) return console.log(`lazydsh ${packageVersion()}`);
  if (command === "resume" && args.length > 1)
    throw new Error("resume accepts at most one session ID. Run lazydsh resume --help.");
  if (command === "resume" && args.length === 1 && !args[0].trim())
    throw new Error("Session ID must not be empty. Run lazydsh resume --help.");
  if (command === "login" || command === "logout") {
    if (args.length > 1)
      throw new Error(`${command} accepts at most one provider. Run lazydsh ${command} --help.`);
    if (args.length && !args[0].trim()) throw new Error("Provider must not be empty.");
  }
  if (command === "upgrade") {
    if (
      args.length ||
      Object.entries(values).some(([key, value]) =>
        key === "patch" ? (value as string[]).length : value !== undefined,
      )
    )
      throw new Error("upgrade does not accept flags other than --help.");
    const { upgrade } = await import("./upgrade.ts");
    await upgrade(fileURLToPath(new URL("..", import.meta.url)));
    return;
  }
  if (command && values.list) throw new Error("Use --list without a subcommand.");
  if (command === "resume" && args.length && values.resume)
    throw new Error("Specify the session ID only once.");
  if (values.permission && command !== "ask")
    throw new Error("--permission is only available with ask.");
  if (
    (command === "login" || command === "logout") &&
    (values.provider || values.model || values.resume || values.effort)
  )
    throw new Error("Use login/logout [provider] with --home, --cwd, or --patch only.");
  if (values.list) {
    const { providers, models } = await import("./catalog.ts");
    for (const id of providers)
      console.log(
        `${id}\n${models(id)
          .map((m) => `  ${m.id}`)
          .join("\n")}`,
      );
    return;
  }
  if (
    (!command ||
      command === "resume" ||
      command === "login" ||
      (command === "logout" && !args.length)) &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error("An interactive terminal is required. Use ask for noninteractive execution.");
  let prompt: string | undefined;
  if (command === "ask") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (!process.stdin.isTTY)
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 20 * 1024 * 1024) throw new Error("stdin exceeds the 20 MiB input limit.");
        chunks.push(buffer);
      }
    prompt = [args.join(" "), Buffer.concat(chunks).toString("utf8")].filter(Boolean).join("\n\n");
    if (!prompt.trim()) throw new Error("Provide a prompt as an argument or through stdin.");
  }
  // Normal startup paints before the provider catalog (and the pi-ai model
  // tables it imports) is needed; the app applies the provider patch after
  // the first frame instead.
  const catalogDeferred = command === undefined && values.resume === undefined;
  const catalog = catalogDeferred ? undefined : await import("./catalog.ts");
  const saved =
    command === "login" || command === "logout"
      ? undefined
      : await loadModel(preferencesPath(values.home));
  const requestedProvider = values.provider && normalizeProvider(values.provider);
  const provider =
    command === "login" || command === "logout"
      ? args[0]
        ? normalizeProvider(args[0])
        : undefined
      : normalizeProvider(requestedProvider ?? saved?.provider ?? "deepseek-official");
  const model =
    values.model ??
    (!requestedProvider || requestedProvider === saved?.provider ? saved?.model : undefined) ??
    (provider === "deepseek-official" ? "deepseek-flash" : undefined);
  const savedEffort =
    saved && provider === saved.provider && model === saved.model ? saved.effort : undefined;
  const effort = values.effort ?? savedEffort;
  if (catalog !== undefined && command !== "login" && command !== "logout" && provider && model)
    catalog.validateRoute(provider, model, values.patch);
  if (command === "ask" && !model) throw new Error("Choose a model with --model before using ask.");
  const [{ ensureProfile, runProfile }, { loadLayeredEnv }, { pluginPatch }] = await Promise.all([
    import("./dsh-boot.ts"),
    import("@deepseek-ai/dsh-app-boot"),
    import("./plugin-patch.ts"),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "lazydsh-"));
  try {
    const patch = join(directory, "providers.json");
    const resumeArgs = [
      ...(values.home ? ["--home", resolve(values.home)] : []),
      ...values.patch.flatMap((path) => ["--patch", resolve(path)]),
    ];
    await writeFile(
      patch,
      JSON.stringify([
        ...(catalog?.providerPatch() ?? []),
        ...pluginPatch({
          cwd: resolve(values.cwd ?? "."),
          home: values.home && resolve(values.home),
          provider,
          model,
          resume: command === "resume" ? (args[0] ?? values.resume) : values.resume,
          pickSession: command === "resume" && !args.length && values.resume === undefined,
          effort,
          command:
            command === "ask" || command === "login" || command === "logout" ? command : undefined,
          prompt,
          permission: values.permission,
          resumeArgs,
          catalogDeferred,
          customPatches: values.patch.length > 0,
        }),
      ]),
    );
    const patches = [patch, ...values.patch.map((path) => resolve(path))];
    if (values.home) process.env.DSH_HOME = resolve(values.home);
    ensureProfile("lazydsh", ["@deepseek-ai/dsh-base"]);
    const { ctx, shutdown } = await runProfile({
      environment: loadLayeredEnv("lazydsh"),
      profile: "lazydsh",
      patchFiles: patches,
      args: [],
    });
    try {
      const app = ctx.get("lazydshApp");
      if (!app) throw new Error("lazydsh plugin did not start.");
      await app.done;
    } finally {
      await shutdown.shutdown(process.exitCode ? Number(process.exitCode) : 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    formatNotification(
      "Error",
      error instanceof Error ? error.message : String(error),
      terminalColor(process.stderr) || terminalColor(process.stdout),
    ),
  );
  process.exitCode = 1;
});
