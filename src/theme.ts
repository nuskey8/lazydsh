import { stripVTControlCharacters } from "node:util";

export const accent = (text: string) => `\x1b[38;2;77;107;254m${text}\x1b[0m`;
export const gray = (text: string) => `\x1b[38;2;160;166;172m${text}\x1b[0m`;
export const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
export const success = (text: string) => `\x1b[38;2;63;185;80m${text}\x1b[0m`;
export const danger = (text: string) => `\x1b[38;2;248;81;73m${text}\x1b[0m`;

export function safeText(value: unknown) {
  // oxlint-disable-next-line no-control-regex -- Preserve tabs/newlines while removing terminal controls.
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function terminalColor(stream: { isTTY?: boolean }) {
  return Boolean(stream.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
}

export function formatNotification(label: string, text: unknown = "", color = true) {
  const icon = /error/i.test(label) ? "✗" : "✓";
  const prefix = safeText(label).toLowerCase();
  const body = safeText(text);
  const head = body ? prefix + ":" : prefix;
  return `${color ? accent(icon) : icon} ${color ? dim(head) : head}${body ? " " + body : ""}`;
}
