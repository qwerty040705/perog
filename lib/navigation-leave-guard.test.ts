import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelNavigationLeave,
  confirmNavigationLeave,
  initialNavigationLeaveGuardState,
  requestNavigationLeave,
  shouldGuardNavigationLeave,
} from "./navigation-leave-guard.ts";

test("only an unfinished active workout enables the leave guard", () => {
  assert.equal(shouldGuardNavigationLeave(true, false), true);
  assert.equal(shouldGuardNavigationLeave(false, false), false);
  assert.equal(shouldGuardNavigationLeave(true, true), false);
});

test("a guarded leave opens once and preserves the requested target", () => {
  const target = { kind: "route", href: "/" } as const;
  const first = requestNavigationLeave(initialNavigationLeaveGuardState, true, target);
  assert.equal(first.action, "show-confirmation");
  assert.deepEqual(first.state.pendingTarget, target);
  assert.equal(requestNavigationLeave(first.state, true, { kind: "history", delta: -2 }).action, "none");
});

test("confirming leave persists-and-leaves rather than finalizing the workout", () => {
  const opened = requestNavigationLeave(initialNavigationLeaveGuardState, true, { kind: "history", delta: -2 });
  const confirmed = confirmNavigationLeave(opened.state);
  assert.equal(confirmed.action, "persist-and-leave");
  assert.deepEqual(confirmed.target, { kind: "history", delta: -2 });
  assert.equal(confirmed.state.isLeaving, true);
});

test("cancelling leave clears the pending target", () => {
  assert.deepEqual(cancelNavigationLeave(), initialNavigationLeaveGuardState);
});
