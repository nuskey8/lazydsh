export function formatDuration(seconds: number): string {
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  for (const [unit, size] of [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const amount = Math.floor(remaining / size);
    remaining %= size;
    if (amount || unit === "s") parts.push(amount + unit);
  }
  return parts.join(" ");
}

const tokenFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokens(tokens: number): string {
  return tokenFormat.format(tokens);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}
