import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { normalizeProvider } from "./provider.ts";

const preferred = ["deepseek-official", "opencode-go", "opencode", "openai-codex"];
export const providers = [
  "deepseek-official",
  ...getBuiltinProviders().filter((id) => getBuiltinModels(id).length),
].sort((a, b) => {
  const rank = (id: string) => (preferred.includes(id) ? preferred.indexOf(id) : preferred.length);
  return rank(a) - rank(b) || a.localeCompare(b);
});

export function models(provider: string) {
  return getBuiltinModels(
    (provider === "deepseek-official" ? "deepseek" : provider) as Parameters<
      typeof getBuiltinModels
    >[0],
  );
}

export function providerPatch() {
  return [
    {
      id: "llm-pi-ai",
      config: {
        providers: Object.fromEntries(
          providers.filter((id) => id !== "deepseek-official").map((id) => [id, {}]),
        ),
      },
    },
  ];
}

export function validateRoute(provider: string, model: string, customPatches: string[] = []) {
  provider = normalizeProvider(provider);
  if (!providers.includes(provider) && !customPatches.length) {
    throw new Error(`Unknown provider: ${provider}. Use --list or configure a route with --patch.`);
  }
  if (!model?.trim()) throw new Error("A model ID is required. Use --list to see the catalog.");
  // Exact route validation belongs to dsh; a user patch can add models newer than this catalog.
  return { provider, model };
}
