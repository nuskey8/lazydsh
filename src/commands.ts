import type { SlashCommand } from "@earendil-works/pi-tui";
import type { CommandDescriptor } from "@deepseek-ai/dsh-commands/types";

const localCommands: SlashCommand[] = [
  { name: "clear", description: "Clear the terminal and start a new chat" },
  { name: "resume", description: "Resume a saved conversation" },
  { name: "cd", description: "Change the working directory" },
  { name: "permission", description: "Show or choose a permission preset" },
  { name: "model", description: "Switch provider and model" },
  {
    name: "login",
    argumentHint: "[provider]",
    description: "Log in to a provider",
  },
  {
    name: "logout",
    argumentHint: "[provider]",
    description: "Remove saved credentials",
  },
  {
    name: "file",
    argumentHint: "<path> | clear",
    description: "Attach a file, or clear attachments",
  },
  {
    name: "dsh",
    argumentHint: "<command> [args]",
    description: "Run a native dsh command",
  },
  {
    name: "effort",
    argumentHint: "[level | default]",
    description: "Choose reasoning effort",
  },
  { name: "new", description: "Start a new chat during a conversation" },
  { name: "rename", argumentHint: "[title]", description: "Rename this conversation" },
  { name: "fork", description: "Fork from a completed turn" },
  { name: "archive", description: "Archive a conversation" },
  { name: "restore", description: "Restore an archived conversation" },
  { name: "pin", description: "Pin a conversation" },
  { name: "unpin", description: "Unpin a conversation" },
  { name: "ps", description: "List background jobs" },
  { name: "stop", description: "Stop a background job" },
  { name: "session", description: "Show the session ID" },
  {
    name: "status",
    description: "Show model, usage, account, and settings",
  },
  { name: "quit", description: "Exit lazydsh" },
];

const nativeCommands = [
  { name: "compact", description: "Summarize history to free context" },
  {
    name: "plan",
    argumentHint: "[off | message]",
    description: "Enter or leave plan mode",
  },
  {
    name: "goal",
    argumentHint: "[objective | clear | edit objective | pause | resume]",
    description: "Create, inspect, or update a goal",
  },
  {
    name: "permission",
    argumentHint: "[preset]",
    description: "Show or choose a permission preset",
  },
  {
    name: "feedback",
    argumentHint: "<text>",
    description: "Send feedback about this conversation",
  },
  {
    name: "export",
    argumentHint: "[path.zip]",
    description: "Export this conversation as ZIP",
  },
];

export function commandMenu(native?: readonly CommandDescriptor[]): SlashCommand[] {
  const commands =
    native?.map((command) => {
      const known = nativeCommands.find((item) => item.name === command.name);
      return {
        name: command.name,
        description:
          known?.description ?? (command.description.trim() || "Run a dsh plugin command"),
        argumentHint: known?.argumentHint ?? command.input?.hint,
      };
    }) ?? nativeCommands;
  return [
    ...new Map([...commands, ...localCommands].map((command) => [command.name, command])).values(),
  ];
}
