import { execFile, spawn } from "node:child_process";
import { shellQuote } from "./format.ts";
import { promisify } from "node:util";
import { readFile, realpath, access } from "node:fs/promises";
import { dirname, join, resolve, basename, sep } from "node:path";
import { homedir } from "node:os";

type Manager = "npm" | "bun" | "pnpm" | "yarn" | "vp";
export interface UpgradePlan {
  manager: Manager;
  args: string[];
  cwd: string;
}
const exec = promisify(execFile);
const output = async (command: string, args: string[]) => {
  const result = await exec(command, args, {
    timeout: 5000,
    env: { ...process.env, NO_COLOR: "1" },
    shell: process.platform === "win32",
  });
  return result.stdout.trim();
};
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export async function upgradePlan(packageRoot: string, query = output): Promise<UpgradePlan> {
  const installed = await realpath(packageRoot);
  if (!installed.includes(`${sep}node_modules${sep}`))
    throw new Error(
      "Source/link installations must be updated in their checkout and rebuilt with npm run build.",
    );
  if (installed.includes(`${sep}_npx${sep}`) || installed.includes(`${sep}bunx-`))
    throw new Error(
      "Temporary installs cannot upgrade themselves. Run npx lazydsh@latest or bunx lazydsh@latest instead.",
    );
  const nodeModules = dirname(installed);
  const prefix = dirname(nodeModules);
  const installation = basename(prefix) === "lib" ? dirname(prefix) : prefix;
  const vpPackage = dirname(installation);
  if (
    basename(installed) === "lazydsh" &&
    basename(nodeModules) === "node_modules" &&
    basename(vpPackage) === "lazydsh" &&
    basename(dirname(vpPackage)) === "packages"
  ) {
    try {
      const packages: unknown = JSON.parse(
        await query("vp", ["list", "--global", "lazydsh", "--json"]),
      );
      if (
        Array.isArray(packages) &&
        packages.some(
          (item) => item?.name === "lazydsh" && item?.installId === basename(installation),
        )
      )
        return {
          manager: "vp",
          args: ["update", "--global", "--latest", "lazydsh"],
          cwd: dirname(vpPackage),
        };
    } catch {
      throw new Error(
        "Could not verify the Vite+ global installation. Check that vp is available and uses the original Vite+ data directory.",
      );
    }
    throw new Error(
      "Could not verify the Vite+ global installation. Check that vp uses the original Vite+ data directory.",
    );
  }
  const matches = async (root: string) => {
    try {
      return (await realpath(join(root, "node_modules", "lazydsh"))) === installed;
    } catch {
      return false;
    }
  };
  const global = (manager: Manager, cwd: string): UpgradePlan => ({
    manager,
    cwd,
    args:
      manager === "npm"
        ? ["install", "--global", "lazydsh@latest"]
        : manager === "bun"
          ? ["update", "--global", "--latest", "lazydsh"]
          : ["add", "--global", "lazydsh@latest"],
  });
  const bunRoot =
    process.env.BUN_INSTALL_GLOBAL_DIR ??
    join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "global");
  if (await matches(bunRoot)) return global("bun", bunRoot);
  // Ask the original manager for its configured global root, including nonstandard prefixes.
  for (const manager of ["bun", "pnpm", "npm", "yarn"] as const) {
    try {
      const rootOutput = await query(
        manager,
        manager === "bun"
          ? ["pm", "ls", "--global"]
          : manager === "yarn"
            ? ["global", "dir"]
            : ["root", "--global"],
      );
      const root =
        manager === "bun"
          ? rootOutput.split("\n")[0].replace(/ node_modules.*$/, "")
          : manager === "yarn"
            ? rootOutput
            : dirname(rootOutput);
      if (await matches(root)) return global(manager, root);
    } catch {
      /* A manager not on PATH cannot own an update command. */
    }
  }
  let project = dirname(installed);
  for (let current = dirname(installed); dirname(current) !== current; current = dirname(current))
    if (basename(current) === "node_modules") project = dirname(current);
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  if (
    ![manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
      (group) => group && Object.hasOwn(group, "lazydsh"),
    )
  )
    throw new Error(
      "Could not identify the original installation. Reinstall lazydsh using the original package manager.",
    );
  let manager: Manager | undefined;
  const declared =
    typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
  if (["npm", "bun", "pnpm", "yarn"].includes(declared)) manager = declared;
  else {
    const locks = await Promise.all(
      (["npm", "bun", "pnpm", "yarn"] as const).map(async (name) => ({
        name,
        found:
          (await exists(
            join(
              project,
              {
                npm: "package-lock.json",
                bun: "bun.lock",
                pnpm: "pnpm-lock.yaml",
                yarn: "yarn.lock",
              }[name],
            ),
          )) ||
          (name === "bun" && (await exists(join(project, "bun.lockb")))),
      })),
    );
    const found = locks.filter((item) => item.found);
    if (found.length === 1) manager = found[0].name;
  }
  if (!manager)
    throw new Error(
      "Could not determine the original package manager from packageManager or a single lockfile.",
    );
  if (manager === "bun")
    return { manager, args: ["update", "--latest", "lazydsh"], cwd: resolve(project) };
  const args = manager === "npm" ? ["install"] : ["add"];
  if (manifest.devDependencies?.lazydsh)
    args.push(manager === "npm" || manager === "pnpm" ? "--save-dev" : "--dev");
  else if (manifest.optionalDependencies?.lazydsh)
    args.push(manager === "npm" ? "--save-optional" : "--optional");
  args.push("lazydsh@latest");
  return { manager, args, cwd: resolve(project) };
}

export function upgradeCommand(plan: UpgradePlan) {
  return [plan.manager, ...plan.args].map((arg) => shellQuote(arg)).join(" ");
}

export async function upgrade(packageRoot: string) {
  const plan = await upgradePlan(packageRoot);
  console.log(upgradeCommand(plan));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.manager, plan.args, {
      cwd: plan.cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Upgrade failed (${signal ?? `exit ${code}`}).`)),
    );
  });
}
