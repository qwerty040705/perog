import type { NavigationStep, RoutePoint } from "./navigation.ts";
import type { WorkoutSession, WorkoutTrackPoint } from "./workout.ts";

export const ACTIVE_WORKOUT_STORAGE_KEY = "perog-active-workout";
export const ACTIVE_WORKOUT_VERSION = 1;
export const ACTIVE_WORKOUT_STALE_MS = 24 * 60 * 60 * 1_000;
export const MAX_PERSISTED_TRACK_POINTS = 3_500;

export type ActiveRouteType = "순환형" | "왕복형" | "편도형" | null;
export type ActiveLocation = RoutePoint & { name: string; address: string };

export type ActiveWorkoutState = {
  version: typeof ACTIVE_WORKOUT_VERSION;
  startedAt: number;
  lastSavedAt: number;
  routeType: ActiveRouteType;
  route: RoutePoint[];
  navigationSteps: NavigationStep[];
  plannedDistanceMeters: number;
  progressMeters: number;
  workoutDistanceMeters: number;
  movingSeconds: number;
  pausedDurationMs: number;
  pauseStartedAt: number | null;
  isPaused: boolean;
  pauseCount: number;
  offRouteCount: number;
  track: WorkoutTrackPoint[];
  start: ActiveLocation | null;
  destination: ActiveLocation | null;
};

type ActiveWorkoutInput = Omit<ActiveWorkoutState, "version" | "lastSavedAt" | "track"> & { track: WorkoutTrackPoint[] };

function validPoint(value: unknown): value is RoutePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<RoutePoint>;
  return typeof point.latitude === "number" && Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 && typeof point.longitude === "number" && Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

function validTrackPoint(value: unknown): value is WorkoutTrackPoint {
  if (!validPoint(value)) return false;
  const point = value as Partial<WorkoutTrackPoint>;
  return typeof point.timestamp === "number" && Number.isFinite(point.timestamp) && typeof point.accuracy === "number" && Number.isFinite(point.accuracy) && point.accuracy >= 0;
}

function validLocation(value: unknown): value is ActiveLocation {
  if (value === null) return true;
  if (!validPoint(value)) return false;
  const location = value as Partial<ActiveLocation>;
  return typeof location.name === "string" && typeof location.address === "string";
}

function validNavigationStep(value: unknown): value is NavigationStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<NavigationStep>;
  return typeof step.progressMeters === "number" && Number.isFinite(step.progressMeters) && step.progressMeters >= 0 && typeof step.distanceMeters === "number" && Number.isFinite(step.distanceMeters) && step.distanceMeters >= 0 && typeof step.guidance === "string";
}

function nonNegativeFinite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

export function downsampleTrackForPersistence(track: WorkoutTrackPoint[]) {
  if (track.length <= MAX_PERSISTED_TRACK_POINTS) return track;
  const sampled: WorkoutTrackPoint[] = [];
  const step = (track.length - 1) / (MAX_PERSISTED_TRACK_POINTS - 1);
  for (let index = 0; index < MAX_PERSISTED_TRACK_POINTS; index += 1) {
    sampled.push(track[Math.min(track.length - 1, Math.round(index * step))]);
  }
  return sampled;
}

export function createActiveWorkout(input: ActiveWorkoutInput, now = Date.now()): ActiveWorkoutState {
  return {
    ...input,
    version: ACTIVE_WORKOUT_VERSION,
    lastSavedAt: now,
    track: downsampleTrackForPersistence(input.track),
  };
}

export function parseActiveWorkout(value: string | null): ActiveWorkoutState | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<ActiveWorkoutState>;
    if (candidate.version !== ACTIVE_WORKOUT_VERSION || !nonNegativeFinite(candidate.startedAt) || !nonNegativeFinite(candidate.lastSavedAt)) return null;
    if (candidate.routeType !== null && candidate.routeType !== "순환형" && candidate.routeType !== "왕복형" && candidate.routeType !== "편도형") return null;
    if (!Array.isArray(candidate.route) || candidate.route.length < 2 || !candidate.route.every(validPoint)) return null;
    if (!Array.isArray(candidate.navigationSteps) || !candidate.navigationSteps.every(validNavigationStep)) return null;
    if (!nonNegativeFinite(candidate.plannedDistanceMeters) || !nonNegativeFinite(candidate.progressMeters) || !nonNegativeFinite(candidate.workoutDistanceMeters) || !nonNegativeFinite(candidate.movingSeconds) || !nonNegativeFinite(candidate.pausedDurationMs)) return null;
    if (candidate.pauseStartedAt !== null && !nonNegativeFinite(candidate.pauseStartedAt)) return null;
    if (typeof candidate.isPaused !== "boolean" || (candidate.isPaused && candidate.pauseStartedAt === null) || (!candidate.isPaused && candidate.pauseStartedAt !== null) || !nonNegativeInteger(candidate.pauseCount) || !nonNegativeInteger(candidate.offRouteCount)) return null;
    if (!Array.isArray(candidate.track) || candidate.track.length > MAX_PERSISTED_TRACK_POINTS || !candidate.track.every(validTrackPoint)) return null;
    if (!validLocation(candidate.start) || !validLocation(candidate.destination)) return null;
    return candidate as ActiveWorkoutState;
  } catch {
    return null;
  }
}

export function loadActiveWorkout() {
  if (typeof window === "undefined") return null;
  try {
    return parseActiveWorkout(window.localStorage.getItem(ACTIVE_WORKOUT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveActiveWorkout(activeWorkout: ActiveWorkoutState) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(ACTIVE_WORKOUT_STORAGE_KEY, JSON.stringify(activeWorkout));
    return true;
  } catch {
    // Storage can be disabled or full. Navigation keeps running without persistence.
    console.warn("PEROG active workout could not be saved.");
    return false;
  }
}

export function clearActiveWorkout() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_WORKOUT_STORAGE_KEY);
  } catch {
    // A blocked storage implementation must not prevent workout completion.
  }
}

export function isActiveWorkoutStale(activeWorkout: ActiveWorkoutState, now = Date.now()) {
  return now - activeWorkout.lastSavedAt > ACTIVE_WORKOUT_STALE_MS;
}

export function activeWorkoutToSession(activeWorkout: ActiveWorkoutState): WorkoutSession {
  const lastTrackPoint = activeWorkout.track.at(-1) ?? null;
  return {
    id: `workout-${activeWorkout.startedAt}-restored`,
    startedAt: activeWorkout.startedAt,
    pausedAt: activeWorkout.isPaused ? activeWorkout.pauseStartedAt : null,
    totalPausedMilliseconds: activeWorkout.pausedDurationMs,
    pauseCount: activeWorkout.pauseCount,
    movingSeconds: activeWorkout.movingSeconds,
    distanceMeters: activeWorkout.workoutDistanceMeters,
    offRouteCount: activeWorkout.offRouteCount,
    track: activeWorkout.track,
    lastDistancePoint: lastTrackPoint,
  };
}
