"use client";

import { useSyncExternalStore } from "react";

export type CurrentUser = { id: string; nickname: string | null; profileImage: string | null };
export type CurrentUserState =
  | { status: "loading"; user: null }
  | { status: "guest"; user: null }
  | { status: "authenticated"; user: CurrentUser };

const loadingState: CurrentUserState = { status: "loading", user: null };
const guestState: CurrentUserState = { status: "guest", user: null };
let currentState: CurrentUserState = loadingState;
let pendingRequest: Promise<void> | null = null;
let authGeneration = 0;
const listeners = new Set<() => void>();

function notify(): void { listeners.forEach((listener) => listener()); }
function setCurrentState(nextState: CurrentUserState): void { currentState = nextState; notify(); }

function parseCurrentUser(payload: unknown): CurrentUser | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.user !== "object" || record.user === null) return null;
  const user = record.user as Record<string, unknown>;
  if (typeof user.id !== "string") return null;
  return { id: user.id, nickname: typeof user.nickname === "string" ? user.nickname : null, profileImage: typeof user.profileImage === "string" ? user.profileImage : null };
}

export function refreshCurrentUser(): Promise<void> {
  if (pendingRequest) return pendingRequest;
  const generation = authGeneration;
  pendingRequest = fetch("/api/auth/me", { cache: "no-store" })
    .then(async (response) => response.ok ? response.json() : null)
    .then((payload: unknown) => {
      const user = parseCurrentUser(payload);
      if (generation === authGeneration) setCurrentState(user ? { status: "authenticated", user } : guestState);
    })
    .catch(() => { if (generation === authGeneration) setCurrentState(guestState); })
    .finally(() => { if (generation === authGeneration) pendingRequest = null; });
  return pendingRequest;
}

export function setCurrentUserGuest(): void {
  authGeneration += 1;
  pendingRequest = null;
  setCurrentState(guestState);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (currentState.status === "loading") void refreshCurrentUser();
  return () => listeners.delete(listener);
}

export function useCurrentUser(): CurrentUserState {
  return useSyncExternalStore(subscribe, () => currentState, () => loadingState);
}
