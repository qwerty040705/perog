import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_WORKOUT_STORAGE_KEY, ACTIVE_WORKOUT_VERSION, activeWorkoutToSession, clearActiveWorkout, createActiveWorkout, downsampleTrackForPersistence, isActiveWorkoutStale, loadActiveWorkout, parseActiveWorkout, saveActiveWorkout, type ActiveWorkoutState } from "./active-workout.ts";
import { elapsedWorkoutSeconds } from "./workout.ts";

function makeActiveWorkout(overrides: Partial<ActiveWorkoutState> = {}): ActiveWorkoutState {
  return {
    version: ACTIVE_WORKOUT_VERSION,
    startedAt: 1_000,
    lastSavedAt: 2_000,
    routeType: "편도형",
    route: [{ latitude: 37, longitude: 127 }, { latitude: 37.001, longitude: 127 }],
    navigationSteps: [{ progressMeters: 20, distanceMeters: 10, guidance: "직진" }],
    plannedDistanceMeters: 100,
    progressMeters: 30,
    workoutDistanceMeters: 25,
    movingSeconds: 12,
    pausedDurationMs: 0,
    pauseStartedAt: null,
    isPaused: false,
    pauseCount: 0,
    offRouteCount: 1,
    track: [{ latitude: 37, longitude: 127, timestamp: 1_000, accuracy: 5 }],
    start: { latitude: 37, longitude: 127, name: "A", address: "A 주소" },
    destination: { latitude: 37.001, longitude: 127, name: "B", address: "B 주소" },
    ...overrides,
  };
}

function installStorage() {
  const values = new Map<string, string>();
  const originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
  });
  return () => Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
}

test("saves and loads a valid active workout", () => {
  const restore = installStorage();
  try {
    const active = makeActiveWorkout();
    assert.equal(saveActiveWorkout(active), true);
    assert.deepEqual(loadActiveWorkout(), active);
    clearActiveWorkout();
    assert.equal(loadActiveWorkout(), null);
  } finally { restore(); }
});

test("safely ignores broken JSON and invalid schemas", () => {
  assert.equal(parseActiveWorkout("{"), null);
  assert.equal(parseActiveWorkout(JSON.stringify({ version: ACTIVE_WORKOUT_VERSION })), null);
});

test("rejects incompatible schema versions", () => {
  assert.equal(parseActiveWorkout(JSON.stringify(makeActiveWorkout({ version: 99 as 1 }))), null);
});

test("keeps startedAt and progress through serialization", () => {
  const active = createActiveWorkout(makeActiveWorkout({ startedAt: 123, progressMeters: 77 }), 500);
  const hydrated = parseActiveWorkout(JSON.stringify(active));
  assert.equal(hydrated?.startedAt, 123);
  assert.equal(hydrated?.progressMeters, 77);
});

test("continues paused elapsed-time calculation after reload", () => {
  const active = makeActiveWorkout({ startedAt: 0, pausedDurationMs: 5_000, pauseStartedAt: 10_000, isPaused: true });
  assert.equal(elapsedWorkoutSeconds(activeWorkoutToSession(active), 30_000), 5);
});

test("hydrates the recorded track and workout distance", () => {
  const active = makeActiveWorkout({ workoutDistanceMeters: 321, track: [
    { latitude: 37, longitude: 127, timestamp: 1_000, accuracy: 5 },
    { latitude: 37.0001, longitude: 127, timestamp: 2_000, accuracy: 5 },
  ] });
  const session = activeWorkoutToSession(active);
  assert.equal(session.distanceMeters, 321);
  assert.equal(session.track.length, 2);
  assert.equal(session.lastDistancePoint?.timestamp, 2_000);
});

test("detects stale active workouts", () => {
  assert.equal(isActiveWorkoutStale(makeActiveWorkout({ lastSavedAt: 0 }), 24 * 60 * 60 * 1_000 + 1), true);
  assert.equal(isActiveWorkoutStale(makeActiveWorkout({ lastSavedAt: 0 }), 100), false);
});

test("downsamples persisted tracks while preserving first and last points", () => {
  const track = Array.from({ length: 3_600 }, (_, index) => ({ latitude: 37 + index / 10_000_000, longitude: 127, timestamp: index, accuracy: 5 }));
  const sampled = downsampleTrackForPersistence(track);
  assert.equal(sampled.length, 3_500);
  assert.equal(sampled[0].timestamp, 0);
  assert.equal(sampled.at(-1)?.timestamp, 3_599);
});

test("refresh-like load restores a complete active state", () => {
  const active = makeActiveWorkout({ pauseCount: 2, offRouteCount: 3, progressMeters: 55 });
  const hydrated = parseActiveWorkout(JSON.stringify(active));
  assert.equal(hydrated?.pauseCount, 2);
  assert.equal(hydrated?.offRouteCount, 3);
  assert.equal(hydrated?.progressMeters, 55);
});

test("uses the documented storage key", () => {
  assert.equal(ACTIVE_WORKOUT_STORAGE_KEY, "perog-active-workout");
});
