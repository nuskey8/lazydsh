import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { ctrlCAction } from "../src/interrupt.ts";

test("Ctrl+C clears drafts, interrupts live turns, then exits", () => {
  // A draft always wins: the first press only discards unsent input.
  assert.equal(ctrlCAction({ draft: true, active: false, cancelling: false }), "clear");
  assert.equal(ctrlCAction({ draft: true, active: true, cancelling: false }), "clear");
  // A live turn is cancelled instead of ending the process.
  assert.equal(ctrlCAction({ draft: false, active: true, cancelling: false }), "interrupt");
  // A second press while cancellation is in flight forces the exit.
  assert.equal(ctrlCAction({ draft: false, active: true, cancelling: true }), "force-exit");
  // Idle Ctrl+C keeps the usual exit behavior.
  assert.equal(ctrlCAction({ draft: false, active: false, cancelling: false }), "exit");
});
