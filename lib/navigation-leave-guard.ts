export type NavigationLeaveTarget =
  | { kind: "history"; delta: number }
  | { kind: "route"; href: string };

export type NavigationLeaveGuardState = {
  isOpen: boolean;
  isLeaving: boolean;
  pendingTarget: NavigationLeaveTarget | null;
};

export type LeaveGuardAction = "none" | "show-confirmation" | "leave-now" | "persist-and-leave";

export const initialNavigationLeaveGuardState: NavigationLeaveGuardState = {
  isOpen: false,
  isLeaving: false,
  pendingTarget: null,
};

export function shouldGuardNavigationLeave(hasActiveWorkout: boolean, isFinishing: boolean): boolean {
  return hasActiveWorkout && !isFinishing;
}

export function requestNavigationLeave(
  state: NavigationLeaveGuardState,
  guardEnabled: boolean,
  target: NavigationLeaveTarget,
): { state: NavigationLeaveGuardState; action: LeaveGuardAction } {
  if (!guardEnabled) return { state, action: "leave-now" };
  if (state.isOpen || state.isLeaving) return { state, action: "none" };
  return {
    state: { isOpen: true, isLeaving: false, pendingTarget: target },
    action: "show-confirmation",
  };
}

export function cancelNavigationLeave(): NavigationLeaveGuardState {
  return initialNavigationLeaveGuardState;
}

export function confirmNavigationLeave(
  state: NavigationLeaveGuardState,
): { state: NavigationLeaveGuardState; target: NavigationLeaveTarget | null; action: LeaveGuardAction } {
  if (!state.isOpen || state.isLeaving || state.pendingTarget === null) {
    return { state, target: null, action: "none" };
  }
  return {
    state: { isOpen: false, isLeaving: true, pendingTarget: state.pendingTarget },
    target: state.pendingTarget,
    action: "persist-and-leave",
  };
}
