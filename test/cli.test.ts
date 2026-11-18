import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const executable = process.execPath;

function cli(executable: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(executable, [resolve("src/cli.ts"), ...args], {
        env: { PATH: process.env.PATH, NO_COLOR: "1", DSH_TELEMETRY_DISABLED: "1", ...env },
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data) => {
        stderr += data;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI timed out"));
      }, 60000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveResult({ code, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    },
  );
}

test("CLI help and validation", async () => {
  const help = await cli(executable, ["--help"]);
  assert.equal(help.code, 0);
  for (const name of [
    "Usage:",
    "Commands:",
    "Flags:",
    "ask [prompt]",
    "resume [session-id]",
    "login [provider]",
    "logout [provider]",
    "upgrade",
  ])
    assert.ok(help.stdout.includes(name));
  const missing = await cli(executable, ["ask"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Provide a prompt/);
  const login = await cli(executable, ["login", "openai-codex"]);
  assert.equal(login.code, 1);
  assert.match(login.stderr, /interactive terminal/);
  const unknown = await cli(executable, ["unknown"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command: unknown/);
  assert.doesNotMatch(unknown.stderr, /A lazier terminal UI|Usage:|Commands:|Flags:/);
  const missingSession = await cli(executable, ["resume"]);
  assert.equal(missingSession.code, 1);
  assert.match(missingSession.stderr, /interactive terminal/);
  assert.doesNotMatch(missingSession.stderr, /A lazier terminal UI/);
  const tooManySessions = await cli(executable, ["resume", "first", "second"]);
  assert.equal(tooManySessions.code, 1);
  assert.match(tooManySessions.stderr, /at most one session ID/);
  assert.doesNotMatch(tooManySessions.stderr, /A lazier terminal UI/);
  const tooMany = await cli(executable, ["login", "codex", "extra"]);
  assert.equal(tooMany.code, 1);
  assert.match(tooMany.stderr, /at most one provider/);
  assert.doesNotMatch(tooMany.stderr, /A lazier terminal UI/);
  for (const action of ["login", "logout"]) {
    const picker = await cli(executable, [action]);
    assert.equal(picker.code, 1);
    assert.match(picker.stderr, /interactive terminal/);
    assert.doesNotMatch(picker.stderr, /A lazier terminal UI|Provider must not/);
  }
  const upgrade = await cli(executable, ["upgrade"]);
  assert.equal(upgrade.code, 1);
  assert.match(upgrade.stderr, /Source\/link installations/);
});

test("version flag", async () => {
  const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    version: string;
  };
  for (const args of [["--version"], ["-v"], ["ask", "--version"], ["upgrade", "-v"]]) {
    const result = await cli(executable, args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `lazydsh ${version}\n`);
    assert.equal(result.stderr, "");
  }
  const help = await cli(executable, ["--help"]);
  assert.match(help.stdout, /-v, --version\s+Show version/);
  const subcommandHelp = await cli(executable, ["upgrade", "--help"]);
  assert.match(subcommandHelp.stdout, /-v, --version\s+Show version/);
});

test("subcommand help", async () => {
  for (const command of ["ask", "resume", "login", "logout", "upgrade"]) {
    const result = await cli(executable, [command, "--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Usage:\\n  lazydsh ${command}`));
    assert.match(result.stdout, /Flags:/);
    assert.doesNotMatch(result.stdout, /Examples:|Notes:/);
    assert.doesNotMatch(result.stdout, /Commands:/);
    assert.equal(result.stderr, "");
    if (["login", "logout", "upgrade"].includes(command))
      assert.doesNotMatch(result.stdout, /--model|--effort|--permission/);
    if (command === "ask") assert.match(result.stdout, /--permission/);
    if (command === "resume") assert.match(result.stdout, /resume \[session-id\]/);
    if (command === "upgrade") assert.doesNotMatch(result.stdout, /--home|--cwd|--patch/);
  }
  const unknown = await cli(executable, ["unknown", "--help"]);
  assert.equal(unknown.code, 1);
});

test("ask, stdin, authentication and logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazydsh-cli-"));
  try {
    const patch = join(directory, "patch.json");
    const preload = join(directory, "mock.mjs");
    const bodyFile = join(directory, "request.json");
    await writeFile(
      patch,
      JSON.stringify([
        {
          id: "llm-pi-ai",
          config: {
            providers: {
              "opencode-go": {
                api: "openai-completions",
                baseURL: "https://lazydsh-test.invalid/v1",
                models: [{ id: "test-model", contextWindow: 131072, maxTokens: 4096 }],
              },
            },
          },
        },
      ]),
    );
    await writeFile(
      preload,
      `
      import {writeFile} from 'node:fs/promises';
      globalThis.fetch=async(input,init)=>{
        const request=new Request(input,init);
        if(!request.url.startsWith('https://lazydsh-test.invalid/')) throw new Error('Unexpected network request');
        await writeFile(${JSON.stringify(bodyFile)},await request.text());
        if(process.env.TEST_UNAUTHORIZED) return new Response('Unauthorized',{status:401});
        const chunks=[{choices:[{index:0,delta:{role:'assistant',content:'Plain answer.'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}];
        return new Response(chunks.map(chunk=>'data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',model:'test-model',...chunk})+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };
    `,
    );
    const env = {
      HOME: directory,
      OPENCODE_API_KEY: "test-only",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    };
    const flags = [
      "--home",
      join(directory, "home"),
      "--cwd",
      directory,
      "--provider",
      "opencode-go",
      "--model",
      "test-model",
      "--patch",
      patch,
    ];
    const result = await cli(
      executable,
      ["ask", "/explain", "this", ...flags],
      "piped context",
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Plain answer.\n");
    const body = JSON.parse(await readFile(bodyFile, "utf8"));
    assert.ok(JSON.stringify(body.messages).includes("/explain this\\n\\npiped context"));
    const failed = await cli(executable, ["ask", "hello", ...flags], "", {
      ...env,
      TEST_UNAUTHORIZED: "1",
    });
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /lazydsh login opencode-go/);
    const logout = await cli(
      executable,
      ["logout", "opencode-go", "--home", join(directory, "home")],
      "",
      {
        HOME: directory,
      },
    );
    assert.equal(logout.code, 0, logout.stderr);
    assert.match(logout.stdout, /not logged in to opencode-go/i);
    const alias = await cli(
      executable,
      ["logout", "codex", "--home", join(directory, "home")],
      "",
      {
        HOME: directory,
      },
    );
    assert.equal(alias.code, 0, alias.stderr);
    assert.match(alias.stdout, /not logged in to openai-codex/i);
    const envLogout = await cli(
      executable,
      ["logout", "opencode-go", "--home", join(directory, "home")],
      "",
      {
        HOME: directory,
        OPENCODE_API_KEY: "test-only",
      },
    );
    assert.equal(envLogout.code, 0, envLogout.stderr);
    assert.match(envLogout.stdout, /logged out: opencode-go/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
