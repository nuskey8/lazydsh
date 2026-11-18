/**
 * What Ctrl+C should do in the chat view. Agent CLIs treat the first press
 * during a running turn as "stop this turn", not "quit the app"; an idle press
 * still exits immediately, and a second press while cancellation is in flight
 * forces the exit.
 */
export type CtrlCAction = "clear" | "interrupt" | "force-exit" | "exit";

export function ctrlCAction(state: {
  /** The prompt or attachments contain unsaved input. */
  draft: boolean;
  /** A turn is generating (or otherwise live). */
  active: boolean;
  /** Cancellation from a previous interrupt is still in flight. */
  cancelling: boolean;
}): CtrlCAction {
  if (state.draft) return "clear";
  if (state.active) return state.cancelling ? "force-exit" : "interrupt";
  return "exit";
}
