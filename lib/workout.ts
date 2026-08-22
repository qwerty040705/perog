import { haversineMeters, pointAtDistance, type RouteIndex, type RoutePoint } from "./navigation.ts";

export type WorkoutTrackPoint = RoutePoint & {
  timestamp: number;
  accuracy: number;
};

export type WorkoutSession = {
  id: string;
  startedAt: number;
  pausedAt: number | null;
  totalPausedMilliseconds: number;
  pauseCount: number;
  movingSeconds: number;
  distanceMeters: number;
  offRouteCount: number;
  track: WorkoutTrackPoint[];
  lastDistancePoint: WorkoutTrackPoint | null;
};

export type WorkoutSummary = {
  id: string;
  startedAt: number;
  endedAt: number;
  elapsedSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  averagePaceSecondsPerKm: number | null;
  plannedDistanceMeters: number;
  completionRatio: number;
  offRouteCount: number;
  pauseCount: number;
  routeType: "순환형" | "왕복형" | "편도형" | null;
  plannedRoute: RoutePoint[];
  track: WorkoutTrackPoint[];
};

export type TrackAppendResult = {
  accepted: boolean;
  distanceMeters: number;
  movingSeconds: number;
};

const MAX_TRACK_ACCURACY_METERS = 45;
const MIN_TRACK_DISTANCE_METERS = 2.5;
const MAX_TRACK_INTERVAL_SECONDS = 12;
const MAX_RUNNING_SPEED_METERS_PER_SECOND = 8;
const MAX_TRACK_GAP_SECONDS = 45;

export function createWorkoutSession(startedAt = Date.now()): WorkoutSession {
  return {
    id: `workout-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    pausedAt: null,
    totalPausedMilliseconds: 0,
    pauseCount: 0,
    movingSeconds: 0,
    distanceMeters: 0,
    offRouteCount: 0,
    track: [],
    lastDistancePoint: null,
  };
}

export function pauseWorkout(session: WorkoutSession, now: number): WorkoutSession {
  if (session.pausedAt !== null) return session;
  return { ...session, pausedAt: now, pauseCount: session.pauseCount + 1 };
}

export function resumeWorkout(session: WorkoutSession, now: number): WorkoutSession {
  if (session.pausedAt === null) return session;
  return {
    ...session,
    pausedAt: null,
    totalPausedMilliseconds: session.totalPausedMilliseconds + Math.max(0, now - session.pausedAt),
    lastDistancePoint: null,
  };
}

export function elapsedWorkoutSeconds(session: WorkoutSession, now: number) {
  const activePauseMilliseconds = session.pausedAt === null ? 0 : Math.max(0, now - session.pausedAt);
  return Math.max(0, Math.floor((now - session.startedAt - session.totalPausedMilliseconds - activePauseMilliseconds) / 1_000));
}

export function appendWorkoutTrackPoint(
  session: WorkoutSession,
  point: WorkoutTrackPoint,
  speedMetersPerSecond: number | null
): TrackAppendResult {
  if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.accuracy) || point.accuracy > MAX_TRACK_ACCURACY_METERS) {
    return { accepted: false, distanceMeters: 0, movingSeconds: 0 };
  }
  if (speedMetersPerSecond !== null && (!Number.isFinite(speedMetersPerSecond) || speedMetersPerSecond > MAX_RUNNING_SPEED_METERS_PER_SECOND)) {
    return { accepted: false, distanceMeters: 0, movingSeconds: 0 };
  }

  const previous = session.lastDistancePoint;
  if (!previous) {
    session.track.push(point);
    session.lastDistancePoint = point;
    return { accepted: true, distanceMeters: 0, movingSeconds: 0 };
  }

  const elapsedSeconds = (point.timestamp - previous.timestamp) / 1_000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return { accepted: false, distanceMeters: 0, movingSeconds: 0 };

  if (elapsedSeconds > MAX_TRACK_GAP_SECONDS) {
    session.track.push(point);
    session.lastDistancePoint = point;
    return { accepted: true, distanceMeters: 0, movingSeconds: 0 };
  }

  const distanceMeters = haversineMeters(previous, point);
  const maximumPlausibleDistance = MAX_RUNNING_SPEED_METERS_PER_SECOND * elapsedSeconds + Math.max(12, point.accuracy, previous.accuracy);
  if (distanceMeters > maximumPlausibleDistance) return { accepted: false, distanceMeters: 0, movingSeconds: 0 };
  if (distanceMeters < MIN_TRACK_DISTANCE_METERS && elapsedSeconds < MAX_TRACK_INTERVAL_SECONDS) return { accepted: false, distanceMeters: 0, movingSeconds: 0 };

  session.track.push(point);
  session.lastDistancePoint = point;
  session.distanceMeters += distanceMeters;
  const movingSeconds = distanceMeters >= MIN_TRACK_DISTANCE_METERS ? elapsedSeconds : 0;
  session.movingSeconds += movingSeconds;
  return { accepted: true, distanceMeters, movingSeconds };
}

export function averagePaceSecondsPerKm(distanceMeters: number, movingSeconds: number) {
  if (!Number.isFinite(distanceMeters) || !Number.isFinite(movingSeconds) || distanceMeters < 20 || movingSeconds <= 0) return null;
  return (movingSeconds * 1_000) / distanceMeters;
}

export function recordOffRouteTransition(session: WorkoutSession, wasOffRoute: boolean, isOffRoute: boolean) {
  if (!wasOffRoute && isOffRoute) session.offRouteCount += 1;
  return session.offRouteCount;
}

export function createWorkoutSummary(
  session: WorkoutSession,
  endedAt: number,
  plannedDistanceMeters: number,
  routeType: WorkoutSummary["routeType"],
  plannedRoute: RoutePoint[],
  completionRatio: number
): WorkoutSummary {
  const finished = session.pausedAt === null ? session : resumeWorkout(session, endedAt);
  return {
    id: finished.id,
    startedAt: finished.startedAt,
    endedAt,
    elapsedSeconds: elapsedWorkoutSeconds(finished, endedAt),
    movingSeconds: Math.round(finished.movingSeconds),
    distanceMeters: finished.distanceMeters,
    averagePaceSecondsPerKm: averagePaceSecondsPerKm(finished.distanceMeters, finished.movingSeconds),
    plannedDistanceMeters,
    completionRatio: Math.max(0, Math.min(1, completionRatio)),
    offRouteCount: finished.offRouteCount,
    pauseCount: finished.pauseCount,
    routeType,
    plannedRoute,
    track: finished.track,
  };
}

/** Always selects a point ahead of the already-confirmed route progress. */
export function selectRecoveryTarget(index: RouteIndex, progressMeters: number, minimumAheadMeters = 60) {
  const forwardProgressMeters = Math.min(index.totalMeters, Math.max(0, progressMeters + minimumAheadMeters));
  return {
    point: pointAtDistance(index, forwardProgressMeters),
    progressMeters: forwardProgressMeters,
  };
}
