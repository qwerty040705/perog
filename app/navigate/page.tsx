"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import NavigationMiniMap from "@/components/map/NavigationMiniMap";
import { NavigationConfirmModal } from "@/components/navigation/NavigationConfirmModal";
import { bearingDegrees, circularEma, createRouteIndex, findUpcomingNavigationStep, findUpcomingTurn, findUpcomingTurns, haversineMeters, isFreshTimestamp, matchRoute, normalizeAngle, pointAtDistance, selectMovementHeading, updateArrivalSampleCount, type NavigationStep, type RouteMatch, type RoutePoint } from "@/lib/navigation";
import { cancelNavigationLeave, confirmNavigationLeave, initialNavigationLeaveGuardState, requestNavigationLeave, shouldGuardNavigationLeave, type NavigationLeaveGuardState, type NavigationLeaveTarget } from "@/lib/navigation-leave-guard";
import { appendWorkoutTrackPoint, createWorkoutSession, createWorkoutSummary, elapsedWorkoutSeconds, pauseWorkout, recordOffRouteTransition, resumeWorkout, selectRecoveryTarget, type WorkoutSession, type WorkoutTrackPoint } from "@/lib/workout";
import { activeWorkoutToSession, clearActiveWorkout, createActiveWorkout, isActiveWorkoutStale, loadActiveWorkout, saveActiveWorkout, type ActiveWorkoutState } from "@/lib/active-workout";
import { useCurrentUser } from "@/components/auth/useCurrentUser";

type SelectedLocation = RoutePoint & { name: string; address: string };
type RouteType = "순환형" | "왕복형" | "편도형";
type NavigationData = { route: RoutePoint[]; routeType: RouteType | null; distanceKm: number | null; start: SelectedLocation | null; destination: SelectedLocation | null; navigationSteps: NavigationStep[]; routeId?: string | null };
type CurrentPosition = RoutePoint & { accuracy: number; speed: number | null; gpsHeading: number | null; timestamp: number };
type TurnType = "straight" | "left" | "right" | "finish";
type TurnInstruction = { type: TurnType; text: string; distanceMeters: number | null; key: string };
type NavigationState = { routeMatch: RouteMatch; targetBearing: number; remainingDistanceMeters: number; progressRatio: number; turnInstruction: TurnInstruction; guidanceText: string | null };
type DisplayMode = "camera" | "map" | "simple";
type RecoveryResponse = { route?: RoutePoint[]; error?: string };
type DebugSample = {
  timestamp: number; latitude: number; longitude: number; accuracy: number; speed: number | null; gpsHeading: number | null;
  deviceHeading: number | null; activeHeading: number | null; matched: boolean; matchedSegmentIndex: number | null;
  progressMeters: number | null; routeDistanceError: number | null; targetBearing: number | null; headingDifference: number | null;
  turnType: TurnType | null; turnDistance: number | null; isOffRoute: boolean; routeLost: boolean;
};
type HistoryGuard = { marker: string; installed: boolean };

const STRAIGHT_LOOK_AHEAD_METERS = 35;
const FINISH_THRESHOLD_METERS = 15;
const FINISH_PROGRESS_RATIO = 0.92;
const MIN_OFF_ROUTE_METERS = 25;
const MAX_RELIABLE_GPS_ACCURACY_METERS = 45;
const GPS_PUBLISH_INTERVAL_MS = 700;
const ORIENTATION_UPDATE_INTERVAL_MS = 120;
const POSITION_STALE_AFTER_MS = 12_000;
const HEADING_STALE_AFTER_MS = 3_500;
const PACE_MIN_SPEED_METERS_PER_SECOND = 1.2;
const PACE_MAX_SPEED_METERS_PER_SECOND = 6.5;
const PACE_EMA_ALPHA = 0.25;
const RECOVERY_PROMPT_AFTER_MS = 10_000;
const DEBUG_LOG_LIMIT = 3_000;
const WORKOUT_SUMMARY_STORAGE_KEY = "perog-last-workout";
const CAN_SHOW_DEBUG_CONTROLS = process.env.NODE_ENV === "development";

function validRoutePoint(value: unknown): value is RoutePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<RoutePoint>;
  return typeof point.latitude === "number" && typeof point.longitude === "number" && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function parseNavigationData(value: string): NavigationData {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("올바른 경로가 아닙니다.");
  const candidate = parsed as Partial<NavigationData>;
  if (!Array.isArray(candidate.route) || candidate.route.length < 2 || !candidate.route.every(validRoutePoint)) throw new Error("올바른 경로가 아닙니다.");
  const navigationSteps = Array.isArray(candidate.navigationSteps) ? candidate.navigationSteps.filter((step): step is NavigationStep => Boolean(step && typeof step === "object" && typeof (step as NavigationStep).progressMeters === "number" && Number.isFinite((step as NavigationStep).progressMeters) && typeof (step as NavigationStep).distanceMeters === "number" && Number.isFinite((step as NavigationStep).distanceMeters) && typeof (step as NavigationStep).guidance === "string")) : [];
  return { route: candidate.route, routeType: candidate.routeType === "순환형" || candidate.routeType === "왕복형" || candidate.routeType === "편도형" ? candidate.routeType : null, distanceKm: typeof candidate.distanceKm === "number" && Number.isFinite(candidate.distanceKm) ? candidate.distanceKm : null, start: candidate.start && validRoutePoint(candidate.start) ? candidate.start : null, destination: candidate.destination && validRoutePoint(candidate.destination) ? candidate.destination : null, navigationSteps, routeId: typeof candidate.routeId === "string" ? candidate.routeId : null };
}

function navigationDataFromActiveWorkout(activeWorkout: ActiveWorkoutState): NavigationData {
  const routeId = typeof (activeWorkout as ActiveWorkoutState & { routeId?: unknown }).routeId === "string"
    ? (activeWorkout as ActiveWorkoutState & { routeId: string }).routeId
    : null;
  return {
    route: activeWorkout.route,
    routeType: activeWorkout.routeType,
    distanceKm: activeWorkout.plannedDistanceMeters / 1_000,
    start: activeWorkout.start,
    destination: activeWorkout.destination,
    navigationSteps: activeWorkout.navigationSteps,
    routeId,
  };
}

function NavigationArrowIcon({ type }: { type: TurnType | "invalid" }) {
  if (type === "invalid") return <svg viewBox="0 0 120 120" aria-hidden="true"><path d="M30 30L90 90M90 30L30 90" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" /></svg>;
  if (type === "left") return <svg viewBox="0 0 120 120" aria-hidden="true"><path d="M78 102V68C78 48 65 36 46 36H27M44 19L27 36L44 53" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (type === "right") return <svg viewBox="0 0 120 120" aria-hidden="true"><path d="M42 102V68C42 48 55 36 74 36H93M76 19L93 36L76 53" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (type === "finish") return <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="28" fill="none" stroke="currentColor" strokeWidth="12" /><circle cx="60" cy="60" r="8" fill="currentColor" /></svg>;
  return <svg viewBox="0 0 120 120" aria-hidden="true"><path d="M60 103V27M35 52L60 27L85 52" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function formatPace(secondsPerKm: number | null) {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm)) return "--'--\" /KM";
  const rounded = Math.round(secondsPerKm);
  return `${Math.floor(rounded / 60)}'${String(rounded % 60).padStart(2, "0")}\" /KM`;
}

function formatElapsedTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function NavigatePage() {
  const router = useRouter();
  const auth = useCurrentUser();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const progressRef = useRef(0);
  const smoothedPositionRef = useRef<CurrentPosition | null>(null);
  const publishedPositionRef = useRef<CurrentPosition | null>(null);
  const headingRef = useRef<number | null>(null);
  const headingUpdatedAtRef = useRef(0);
  const arrivalSamplesRef = useRef(0);
  const turnSamplesRef = useRef({ key: "", count: 0 });
  const offRouteHysteresisRef = useRef({ entered: 0, recovered: 0, isOffRoute: false });
  const paceEmaRef = useRef<number | null>(null);
  const vibrationRef = useRef({ turnKey: "", nearTurnKey: "", wasOffRoute: false });
  const spokenRef = useRef({ turnKey: "", nearTurnKey: "", offRoute: false, arrived: false });
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const workoutRef = useRef<WorkoutSession | null>(null);
  const isPausedRef = useRef(false);
  const debugEnabledRef = useRef(false);
  const debugLogRef = useRef<DebugSample[]>([]);
  const arrivalDismissedRef = useRef(false);
  const restorePendingRef = useRef<ActiveWorkoutState | null>(null);
  const navigationDataRef = useRef<NavigationData | null>(null);
  const isFinalizingRef = useRef(false);
  const leaveGuardRef = useRef<NavigationLeaveGuardState>(initialNavigationLeaveGuardState);
  const requestNavigationRef = useRef<(target: NavigationLeaveTarget) => void>(() => undefined);
  const historyGuardRef = useRef<HistoryGuard | null>(null);
  const browserBackBypassRef = useRef(false);
  const browserHistoryRestoreRef = useRef(false);
  const [navigationData, setNavigationData] = useState<NavigationData | null>(null);
  const [legacyNavigationData, setLegacyNavigationData] = useState<NavigationData | null>(null);
  const [activeWorkoutRecovery, setActiveWorkoutRecovery] = useState<ActiveWorkoutState | null>(null);
  const [showActiveDiscardConfirm, setShowActiveDiscardConfirm] = useState(false);
  const [routeLoadError, setRouteLoadError] = useState<string | null>(null);
  const [currentPosition, setCurrentPosition] = useState<CurrentPosition | null>(null);
  const [deviceHeading, setDeviceHeading] = useState<number | null>(null);
  const [headingUpdatedAt, setHeadingUpdatedAt] = useState(0);
  const [orientationEnabled, setOrientationEnabled] = useState(false);
  const [orientationError, setOrientationError] = useState<string | null>(null);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isCameraStarting, setIsCameraStarting] = useState(false);
  const [isOffRoute, setIsOffRoute] = useState(false);
  const [routeLost, setRouteLost] = useState(false);
  const [clock, setClock] = useState(0);
  const [paceSecondsPerKm, setPaceSecondsPerKm] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("camera");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [workoutTrack, setWorkoutTrack] = useState<WorkoutTrackPoint[]>([]);
  const [recoveryPath, setRecoveryPath] = useState<RoutePoint[] | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [leaveGuard, setLeaveGuard] = useState<NavigationLeaveGuardState>(initialNavigationLeaveGuardState);
  const [showSettings, setShowSettings] = useState(false);
  const [showArrivalPrompt, setShowArrivalPrompt] = useState(false);
  const [workoutDistanceMeters, setWorkoutDistanceMeters] = useState(0);
  const [recoveryPromptVisible, setRecoveryPromptVisible] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const lastServerSyncAtRef = useRef(0);
  const syncActiveWorkoutRef = useRef<(force?: boolean) => void>(() => undefined);
  const [serverSyncError, setServerSyncError] = useState(false);
  const routeIndex = useMemo(() => navigationData ? createRouteIndex(navigationData.route) : null, [navigationData]);

  const persistActiveWorkout = () => {
    const navigation = navigationDataRef.current;
    const workout = workoutRef.current;
    if (!navigation || !workout) return false;
    return saveActiveWorkout(createActiveWorkout({
      startedAt: workout.startedAt,
      routeType: navigation.routeType,
      route: navigation.route,
      navigationSteps: navigation.navigationSteps,
      plannedDistanceMeters: navigation.distanceKm !== null ? navigation.distanceKm * 1_000 : Math.max(progressRef.current, workout.distanceMeters),
      progressMeters: progressRef.current,
      workoutDistanceMeters: workout.distanceMeters,
      movingSeconds: workout.movingSeconds,
      pausedDurationMs: workout.totalPausedMilliseconds,
      pauseStartedAt: workout.pausedAt,
      isPaused: workout.pausedAt !== null,
      pauseCount: workout.pauseCount,
      offRouteCount: workout.offRouteCount,
      track: workout.track,
      start: navigation.start,
      destination: navigation.destination,
    }));
  };

  const syncActiveWorkoutToServer = (force = false) => {
    if (auth.status !== "authenticated") return;
    const now = Date.now();
    if (!force && now - lastServerSyncAtRef.current < 15_000) return;
    const navigation = navigationDataRef.current;
    const workout = workoutRef.current;
    if (!navigation || !workout) return;
    lastServerSyncAtRef.current = now;
    const activeWorkout = createActiveWorkout({
      startedAt: workout.startedAt, routeType: navigation.routeType, route: navigation.route, navigationSteps: navigation.navigationSteps,
      plannedDistanceMeters: navigation.distanceKm !== null ? navigation.distanceKm * 1_000 : Math.max(progressRef.current, workout.distanceMeters),
      progressMeters: progressRef.current, workoutDistanceMeters: workout.distanceMeters, movingSeconds: workout.movingSeconds,
      pausedDurationMs: workout.totalPausedMilliseconds, pauseStartedAt: workout.pausedAt, isPaused: workout.pausedAt !== null,
      pauseCount: workout.pauseCount, offRouteCount: workout.offRouteCount, track: workout.track, start: navigation.start, destination: navigation.destination,
    });
    void fetch("/api/workouts/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...activeWorkout, routeId: navigation.routeId ?? null }), keepalive: force })
      .then((response) => { if (!response.ok) throw new Error(); setServerSyncError(false); })
      .catch(() => setServerSyncError(true));
  };

  const updateLeaveGuard = (next: NavigationLeaveGuardState) => {
    leaveGuardRef.current = next;
    setLeaveGuard(next);
  };

  const executeLeaveTarget = (target: NavigationLeaveTarget) => {
    if (target.kind === "route") {
      router.push(target.href);
      return;
    }
    browserBackBypassRef.current = true;
    window.history.go(target.delta);
    window.setTimeout(() => { browserBackBypassRef.current = false; }, 700);
  };

  const requestNavigation = (target: NavigationLeaveTarget) => {
    const transition = requestNavigationLeave(
      leaveGuardRef.current,
      shouldGuardNavigationLeave(navigationData !== null, isFinalizingRef.current),
      target,
    );
    if (transition.action === "none") return;
    updateLeaveGuard(transition.state);
    if (transition.action === "leave-now") executeLeaveTarget(target);
  };

  const cancelLeaveNavigation = () => updateLeaveGuard(cancelNavigationLeave());

  const confirmLeaveNavigation = () => {
    const transition = confirmNavigationLeave(leaveGuardRef.current);
    if (transition.action !== "persist-and-leave" || transition.target === null) return;
    updateLeaveGuard(transition.state);
    // Local persistence is authoritative for recovery. Server sync is
    // best-effort and intentionally does not delay the user's navigation.
    persistActiveWorkout();
    syncActiveWorkoutToServer(true);
    executeLeaveTarget(transition.target);
  };

  useEffect(() => {
    syncActiveWorkoutRef.current = syncActiveWorkoutToServer;
  });
  useEffect(() => {
    requestNavigationRef.current = requestNavigation;
  });

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      try {
        const saved = sessionStorage.getItem("perog-navigation-route");
        const legacy = saved ? parseNavigationData(saved) : null;
        const activeWorkout = loadActiveWorkout();
        if (cancelled) return;
        if (legacy) setLegacyNavigationData(legacy);
        if (activeWorkout) {
          setActiveWorkoutRecovery(activeWorkout);
          return;
        }
        if (legacy) {
          setNavigationData(legacy);
          return;
        }
        throw new Error("저장된 경로가 없습니다.");
      } catch (error) {
        if (!cancelled) setRouteLoadError(error instanceof Error ? error.message : "경로를 불러오지 못했습니다.");
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { navigationDataRef.current = navigationData; }, [navigationData]);

  useEffect(() => {
    if (!navigationData) return;
    const state = recordFromUnknown(window.history.state);
    const knownMarker = typeof state.__perogNavigationGuard === "string" ? state.__perogNavigationGuard : null;
    const marker = knownMarker ?? `perog-navigation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!knownMarker) {
      window.history.replaceState({ ...state, __perogNavigationBase: marker }, "", window.location.href);
      window.history.pushState({ ...state, __perogNavigationGuard: marker }, "", window.location.href);
    }
    historyGuardRef.current = { marker, installed: true };

    const onPopState = () => {
      if (!shouldGuardNavigationLeave(navigationDataRef.current !== null, isFinalizingRef.current)) return;
      if (browserBackBypassRef.current) {
        browserBackBypassRef.current = false;
        return;
      }
      if (browserHistoryRestoreRef.current) {
        browserHistoryRestoreRef.current = false;
        return;
      }
      // One sentinel entry is restored rather than pushed again, preventing
      // a back-button loop while the custom confirmation is visible.
      browserHistoryRestoreRef.current = true;
      window.history.go(1);
      requestNavigationRef.current({ kind: "history", delta: -2 });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigationData]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    let active = true;
    void fetch("/api/workouts/active", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ activeWorkout?: ActiveWorkoutState | null }> : null)
      .then((data) => {
        if (!active || !data?.activeWorkout) return;
        const local = loadActiveWorkout();
        if (!local || data.activeWorkout.lastSavedAt > local.lastSavedAt) setActiveWorkoutRecovery(data.activeWorkout);
      })
      .catch(() => setServerSyncError(true));
    return () => { active = false; };
  }, [auth.status]);

  useEffect(() => {
    if (!navigationData) return;
    const timer = window.setInterval(() => {
      if (!isFinalizingRef.current) { persistActiveWorkout(); syncActiveWorkoutRef.current(); }
    }, 3_000);
    const persistOnPageExit = () => {
      if (!isFinalizingRef.current) { persistActiveWorkout(); syncActiveWorkoutRef.current(true); }
    };
    const persistWhenHidden = () => {
      if (document.visibilityState === "hidden") { persistActiveWorkout(); syncActiveWorkoutRef.current(true); }
    };
    const confirmBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isFinalizingRef.current) return;
      persistOnPageExit();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", persistOnPageExit);
    window.addEventListener("beforeunload", confirmBeforeUnload);
    document.addEventListener("visibilitychange", persistWhenHidden);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", persistOnPageExit);
      window.removeEventListener("beforeunload", confirmBeforeUnload);
      document.removeEventListener("visibilitychange", persistWhenHidden);
      persistOnPageExit();
    };
  }, [auth.status, navigationData]);

  useEffect(() => {
    queueMicrotask(() => {
      setVoiceEnabled(sessionStorage.getItem("perog-navigation-voice") === "true");
      setVibrationEnabled(sessionStorage.getItem("perog-navigation-vibration") !== "false");
      setSettingsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    void fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ navigationSettings?: { voiceGuidance: boolean; vibration: boolean; displayMode: DisplayMode } }> : null)
      .then((data) => {
        const settings = data?.navigationSettings;
        if (!settings) return;
        if (sessionStorage.getItem("perog-navigation-voice") === null) setVoiceEnabled(settings.voiceGuidance);
        if (sessionStorage.getItem("perog-navigation-vibration") === null) setVibrationEnabled(settings.vibration);
        setDisplayMode((current) => current === "camera" ? settings.displayMode : current);
      })
      .catch(() => setServerSyncError(true));
  }, [auth.status]);

  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  useEffect(() => { debugEnabledRef.current = debugEnabled; }, [debugEnabled]);
  useEffect(() => { if (settingsLoaded) sessionStorage.setItem("perog-navigation-voice", String(voiceEnabled)); }, [settingsLoaded, voiceEnabled]);
  useEffect(() => { if (settingsLoaded) sessionStorage.setItem("perog-navigation-vibration", String(vibrationEnabled)); }, [settingsLoaded, vibrationEnabled]);

  useEffect(() => {
    if (!navigationData) return;
    isFinalizingRef.current = false;
    const restoring = restorePendingRef.current;
    if (restoring) {
      workoutRef.current = activeWorkoutToSession(restoring);
      progressRef.current = Math.min(restoring.plannedDistanceMeters, Math.max(0, restoring.progressMeters));
      isPausedRef.current = restoring.isPaused;
      restorePendingRef.current = null;
    } else {
      workoutRef.current = createWorkoutSession();
      progressRef.current = 0;
      isPausedRef.current = false;
    }
    arrivalDismissedRef.current = false;
    persistActiveWorkout();
    queueMicrotask(() => {
      setShowArrivalPrompt(false);
      setWorkoutTrack(restoring?.track ?? []);
      setWorkoutDistanceMeters(restoring?.workoutDistanceMeters ?? 0);
      setIsPaused(restoring?.isPaused ?? false);
      setElapsedSeconds(elapsedWorkoutSeconds(workoutRef.current!, Date.now()));
    });
  }, [navigationData]);

  useEffect(() => {
    if (!isOffRoute) {
      queueMicrotask(() => setRecoveryPromptVisible(false));
      return;
    }
    const timer = window.setTimeout(() => setRecoveryPromptVisible(true), RECOVERY_PROMPT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [isOffRoute]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!navigationData) return;
    const updateElapsed = () => {
      const workout = workoutRef.current;
      if (workout) setElapsedSeconds(elapsedWorkoutSeconds(workout, Date.now()));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [navigationData]);

  useEffect(() => {
    if (!navigationData || !("wakeLock" in navigator)) return;
    let disposed = false;

    const requestWakeLock = async () => {
      if (disposed || document.visibilityState !== "visible" || wakeLockRef.current) return;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (disposed) {
          await sentinel.release();
          return;
        }
        wakeLockRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        }, { once: true });
      } catch {
        // Wake Lock is optional: unsupported browsers and low-battery rejections keep navigation usable.
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void requestWakeLock();
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release();
    };
  }, [navigationData]);

  useEffect(() => {
    if (!navigationData) return;
    if (displayMode !== "camera") {
      queueMicrotask(() => setIsCameraStarting(false));
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    const startCamera = async () => {
      setIsCameraStarting(true);
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" } }, audio: false }); }
        catch { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); }
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => undefined); }
        setCameraError(null);
      } catch { if (!cancelled) setCameraError("카메라를 사용할 수 없습니다."); }
      finally { if (!cancelled) setIsCameraStarting(false); }
    };
    void startCamera();
    return () => { cancelled = true; stream?.getTracks().forEach((track) => track.stop()); };
  }, [displayMode, navigationData]);

  useEffect(() => {
    if (!navigationData) return;
    if (!navigator.geolocation) { queueMicrotask(() => setGpsError("이 브라우저는 위치 정보를 지원하지 않습니다.")); return; }
    const watchId = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        const { latitude, longitude, accuracy, speed, heading } = coords;
        if (![latitude, longitude, accuracy].every(Number.isFinite)) return;
        const raw: CurrentPosition = { latitude, longitude, accuracy, speed: typeof speed === "number" && Number.isFinite(speed) ? speed : null, gpsHeading: typeof heading === "number" && Number.isFinite(heading) ? heading : null, timestamp };
        if (!isPausedRef.current) {
          if (raw.speed === null || raw.speed < PACE_MIN_SPEED_METERS_PER_SECOND || raw.speed > PACE_MAX_SPEED_METERS_PER_SECOND) {
            if (paceEmaRef.current !== null) {
              paceEmaRef.current = null;
              setPaceSecondsPerKm(null);
            }
          } else {
            const instantPace = 1_000 / raw.speed;
            const nextPace = paceEmaRef.current === null
              ? instantPace
              : paceEmaRef.current + PACE_EMA_ALPHA * (instantPace - paceEmaRef.current);
            paceEmaRef.current = nextPace;
            setPaceSecondsPerKm(nextPace);
          }
        }
        const previous = smoothedPositionRef.current;
        const alpha = previous ? Math.max(0.2, Math.min(0.65, 0.7 - Math.min(0.45, accuracy / 100))) : 1;
        const smoothed = previous ? { ...raw, latitude: previous.latitude + alpha * (latitude - previous.latitude), longitude: previous.longitude + alpha * (longitude - previous.longitude) } : raw;
        smoothedPositionRef.current = smoothed;
        const workout = workoutRef.current;
        if (workout && !isPausedRef.current) {
          const result = appendWorkoutTrackPoint(workout, {
            latitude: smoothed.latitude,
            longitude: smoothed.longitude,
            timestamp: smoothed.timestamp,
            accuracy: smoothed.accuracy,
          }, smoothed.speed);
          if (result.accepted) {
            setWorkoutTrack([...workout.track]);
            setWorkoutDistanceMeters(workout.distanceMeters);
          }
        }
        const published = publishedPositionRef.current;
        if (!published || timestamp - published.timestamp >= GPS_PUBLISH_INTERVAL_MS || haversineMeters(published, smoothed) >= 3 || Math.abs(published.accuracy - accuracy) >= 8) { publishedPositionRef.current = smoothed; setCurrentPosition(smoothed); }
        setGpsError(null);
      },
      (error) => setGpsError(error.code === error.PERMISSION_DENIED ? "위치 권한이 거부되었습니다." : error.code === error.TIMEOUT ? "GPS 위치 확인 시간이 초과되었습니다." : "현재 위치를 사용할 수 없습니다."),
      { enableHighAccuracy: true, maximumAge: 1_000, timeout: 20_000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [navigationData]);

  const enableOrientation = async () => {
    try {
      const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<"granted" | "denied"> };
      if (typeof orientation.requestPermission === "function" && await orientation.requestPermission(true) !== "granted") { setOrientationError("방향 센서 권한이 거부되었습니다."); return; }
      setOrientationError(null); setOrientationEnabled(true);
    } catch { setOrientationError("방향 센서를 시작하지 못했습니다."); }
  };

  useEffect(() => {
    if (!orientationEnabled) return;
    let lastUpdate = 0;
    const updateInterval = displayMode === "simple" ? 260 : ORIENTATION_UPDATE_INTERVAL_MS;
    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (performance.now() - lastUpdate < updateInterval) return;
      const compass = event as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
      const screenAngle = typeof screen.orientation?.angle === "number" ? screen.orientation.angle : 0;
      const raw = typeof compass.webkitCompassHeading === "number" && Number.isFinite(compass.webkitCompassHeading) && (compass.webkitCompassAccuracy === undefined || compass.webkitCompassAccuracy <= 45) ? compass.webkitCompassHeading : typeof event.alpha === "number" && Number.isFinite(event.alpha) && event.absolute ? (360 - event.alpha + screenAngle) % 360 : null;
      if (raw === null) return;
      lastUpdate = performance.now(); headingRef.current = circularEma(headingRef.current, raw, 0.22); headingUpdatedAtRef.current = Date.now(); setHeadingUpdatedAt(headingUpdatedAtRef.current); setDeviceHeading(headingRef.current);
    };
    window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    window.addEventListener("deviceorientation", handleOrientation, true);
    return () => { window.removeEventListener("deviceorientationabsolute", handleOrientation, true); window.removeEventListener("deviceorientation", handleOrientation, true); };
  }, [displayMode, orientationEnabled]);

  useEffect(() => {
    if (!routeIndex || !currentPosition || !navigationData) return;
    const movementHeading = selectMovementHeading({ gpsHeading: currentPosition.gpsHeading, speedMetersPerSecond: currentPosition.speed, orientationHeading: headingRef.current, orientationUpdatedAt: headingUpdatedAtRef.current, now: Date.now(), maxOrientationAgeMs: HEADING_STALE_AFTER_MS });
    const match = matchRoute(routeIndex, currentPosition, { previousProgressMeters: progressRef.current, accuracyMeters: currentPosition.accuracy, movementHeading, speedMetersPerSecond: currentPosition.speed });
    const reliable = currentPosition.accuracy <= MAX_RELIABLE_GPS_ACCURACY_METERS;
    const threshold = Math.max(MIN_OFF_ROUTE_METERS, Math.min(55, currentPosition.accuracy * 1.35));
    const hysteresis = offRouteHysteresisRef.current;
    const wasOffRoute = hysteresis.isOffRoute;
    if (!match.matched) {
      arrivalSamplesRef.current = 0;
      queueMicrotask(() => setRouteLost(true));
      if (reliable) {
        hysteresis.isOffRoute = true;
        hysteresis.entered = 3;
        hysteresis.recovered = 0;
        queueMicrotask(() => setIsOffRoute(true));
      }
      if (!wasOffRoute && hysteresis.isOffRoute) {
        const workout = workoutRef.current;
        if (workout) recordOffRouteTransition(workout, wasOffRoute, hysteresis.isOffRoute);
        persistActiveWorkout();
      }
      if (debugEnabledRef.current) {
        const log = debugLogRef.current;
        log.push({ timestamp: currentPosition.timestamp, latitude: currentPosition.latitude, longitude: currentPosition.longitude, accuracy: currentPosition.accuracy, speed: currentPosition.speed, gpsHeading: currentPosition.gpsHeading, deviceHeading: headingRef.current, activeHeading: movementHeading, matched: false, matchedSegmentIndex: null, progressMeters: null, routeDistanceError: null, targetBearing: null, headingDifference: null, turnType: null, turnDistance: null, isOffRoute: hysteresis.isOffRoute, routeLost: true });
        if (log.length > DEBUG_LOG_LIMIT) log.splice(0, log.length - DEBUG_LOG_LIMIT);
      }
      queueMicrotask(() => setNavigationState(null));
      return;
    }
    const withinRecovery = match.distanceMeters <= threshold * 0.7;
    if (reliable) {
      if (!hysteresis.isOffRoute && match.distanceMeters > threshold) {
        hysteresis.entered += 1;
        hysteresis.recovered = 0;
        if (hysteresis.entered >= 3) hysteresis.isOffRoute = true;
      } else if (hysteresis.isOffRoute && withinRecovery) {
        hysteresis.recovered += 1;
        hysteresis.entered = 0;
        if (hysteresis.recovered >= 2) hysteresis.isOffRoute = false;
      } else if (match.distanceMeters <= threshold) {
        hysteresis.entered = 0;
        hysteresis.recovered = 0;
      }
      setIsOffRoute(hysteresis.isOffRoute);
      if (!hysteresis.isOffRoute && withinRecovery) setRouteLost(false);
    }
    if (!wasOffRoute && hysteresis.isOffRoute) {
      const workout = workoutRef.current;
      if (workout) recordOffRouteTransition(workout, wasOffRoute, hysteresis.isOffRoute);
      persistActiveWorkout();
    } else if (wasOffRoute && !hysteresis.isOffRoute) {
      setRecoveryPath(null);
      setRecoveryError(null);
    }
    const progressMeters = Math.max(progressRef.current, match.progressMeters);
    progressRef.current = progressMeters;
    const remainingDistanceMeters = Math.max(0, routeIndex.totalMeters - progressMeters);
    const progressRatio = routeIndex.totalMeters > 0 ? progressMeters / routeIndex.totalMeters : 0;
    const targetBearing = bearingDegrees(currentPosition, pointAtDistance(routeIndex, progressMeters, STRAIGHT_LOOK_AHEAD_METERS));
    const proposedTurn = findUpcomingTurn(routeIndex, progressMeters);
    const tracker = turnSamplesRef.current;
    tracker.count = proposedTurn.key === tracker.key ? tracker.count + 1 : 1; tracker.key = proposedTurn.key;
    const geometryTurn = proposedTurn.type === "straight" || tracker.count >= 2 ? proposedTurn : { type: "straight" as const, text: "직진하세요", distanceMeters: null, key: "straight" };
    const metadataStep = findUpcomingNavigationStep(navigationData.navigationSteps, progressMeters);
    const reliableArrival = reliable && progressRatio >= FINISH_PROGRESS_RATIO && remainingDistanceMeters <= FINISH_THRESHOLD_METERS && match.distanceMeters <= Math.max(FINISH_THRESHOLD_METERS, currentPosition.accuracy);
    arrivalSamplesRef.current = updateArrivalSampleCount(arrivalSamplesRef.current, reliableArrival);
    const resolvedTurn = arrivalSamplesRef.current >= 3 ? { type: "finish" as const, text: "목적지에 도착했습니다", distanceMeters: remainingDistanceMeters, key: "finish" } : geometryTurn;
    if (resolvedTurn.type === "finish" && !arrivalDismissedRef.current) queueMicrotask(() => setShowArrivalPrompt(true));
    if (debugEnabledRef.current) {
      const log = debugLogRef.current;
      log.push({ timestamp: currentPosition.timestamp, latitude: currentPosition.latitude, longitude: currentPosition.longitude, accuracy: currentPosition.accuracy, speed: currentPosition.speed, gpsHeading: currentPosition.gpsHeading, deviceHeading: headingRef.current, activeHeading: movementHeading, matched: true, matchedSegmentIndex: match.segmentIndex, progressMeters, routeDistanceError: match.distanceMeters, targetBearing, headingDifference: movementHeading === null ? null : normalizeAngle(targetBearing - movementHeading), turnType: resolvedTurn.type, turnDistance: resolvedTurn.distanceMeters, isOffRoute: hysteresis.isOffRoute, routeLost: false });
      if (log.length > DEBUG_LOG_LIMIT) log.splice(0, log.length - DEBUG_LOG_LIMIT);
    }
    setNavigationState({ routeMatch: { ...match, progressMeters }, targetBearing, remainingDistanceMeters, progressRatio, turnInstruction: resolvedTurn, guidanceText: metadataStep?.guidance ?? null });
  }, [currentPosition, navigationData, routeIndex]);

  useEffect(() => {
    if (!vibrationEnabled || !("vibrate" in navigator)) return;
    const vibrate = navigator.vibrate.bind(navigator);
    const tracker = vibrationRef.current;

    if (isOffRoute && !tracker.wasOffRoute) vibrate(220);
    tracker.wasOffRoute = isOffRoute;
    if (isOffRoute) return;

    const turn = navigationState?.turnInstruction;
    if (!turn || (turn.type !== "left" && turn.type !== "right")) return;

    if (tracker.turnKey !== turn.key) {
      tracker.turnKey = turn.key;
      vibrate(70);
    }
    if (turn.distanceMeters !== null && turn.distanceMeters <= 7 && tracker.nearTurnKey !== turn.key) {
      tracker.nearTurnKey = turn.key;
      vibrate([50, 70, 50]);
    }
  }, [isOffRoute, navigationState?.turnInstruction, vibrationEnabled]);

  useEffect(() => {
    if (!voiceEnabled || !("speechSynthesis" in window)) return;
    const tracker = spokenRef.current;
    const speak = (text: string) => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ko-KR";
      utterance.rate = 1.08;
      window.speechSynthesis.speak(utterance);
    };

    if (isOffRoute && !tracker.offRoute) speak("경로에서 벗어났습니다.");
    tracker.offRoute = isOffRoute;
    if (isOffRoute) return;

    const turn = navigationState?.turnInstruction;
    if (turn?.type === "finish" && !tracker.arrived) {
      tracker.arrived = true;
      speak("목적지에 도착했습니다.");
      return;
    }
    if (turn?.type !== "left" && turn?.type !== "right") return;
    const direction = turn.type === "left" ? "좌회전" : "우회전";
    if (tracker.turnKey !== turn.key) {
      tracker.turnKey = turn.key;
      speak(`${Math.max(0, Math.round(turn.distanceMeters ?? 0))}미터 후 ${direction}입니다.`);
    }
    if (turn.distanceMeters !== null && turn.distanceMeters <= 7 && tracker.nearTurnKey !== turn.key) {
      tracker.nearTurnKey = turn.key;
      speak(`${direction}입니다.`);
    }
  }, [isOffRoute, navigationState?.turnInstruction, voiceEnabled]);

  const gpsFallbackHeading = currentPosition && currentPosition.gpsHeading !== null && currentPosition.speed !== null && currentPosition.speed > 1.2 ? currentPosition.gpsHeading : null;
  const orientationFresh = isFreshTimestamp(headingUpdatedAt, clock, HEADING_STALE_AFTER_MS);
  const activeHeading = orientationFresh ? deviceHeading : gpsFallbackHeading;
  const headingDifference = navigationState && activeHeading !== null ? normalizeAngle(navigationState.targetBearing - activeHeading) : null;
  const gpsFresh = currentPosition !== null && (clock === 0 || clock - currentPosition.timestamp <= POSITION_STALE_AFTER_MS);
  const gpsReliable = currentPosition !== null && currentPosition.accuracy <= MAX_RELIABLE_GPS_ACCURACY_METERS && gpsFresh;
  const instruction = navigationState?.turnInstruction;
  const hasRouteIssue = routeLost || isOffRoute;
  const visibleArrowType: TurnType | "invalid" = hasRouteIssue ? "invalid" : instruction?.type ?? "straight";
  const mainInstruction = routeLost ? "경로를 찾을 수 없습니다" : isOffRoute ? "경로에서 벗어났습니다" : instruction?.text ?? (gpsError ?? "GPS 연결 중");
  const subInstruction = routeLost ? "경로와 현재 위치를 다시 찾고 있습니다." : isOffRoute && navigationState ? `경로에서 약 ${Math.round(navigationState.routeMatch.distanceMeters)}m 떨어져 있습니다.` : !gpsFresh && currentPosition ? "GPS 신호를 다시 확인하고 있습니다." : !gpsReliable && currentPosition ? "GPS 정확도를 확인하고 있습니다." : navigationState?.guidanceText ?? (navigationState ? `남은 경로 오차 ${Math.round(navigationState.routeMatch.distanceMeters)}m` : "현재 위치를 확인하고 있습니다.");
  const remainingKm = routeLost ? null : navigationState ? navigationState.remainingDistanceMeters / 1000 : navigationData?.distanceKm ?? null;
  const gpsSignal = currentPosition === null ? null : currentPosition.accuracy <= 12 ? "good" : currentPosition.accuracy <= 25 ? "medium" : "weak";
  const compassStatus = orientationFresh ? "READY" : deviceHeading !== null ? "STALE" : "WAITING";
  const showCompassNotice = !orientationFresh && gpsFallbackHeading === null && currentPosition !== null;
  const nextLabel = hasRouteIssue
    ? "OFF ROUTE"
    : instruction?.type === "finish"
      ? "ARRIVAL"
      : instruction?.type === "left" || instruction?.type === "right"
        ? `${Math.max(0, Math.round(instruction.distanceMeters ?? 0))}m ${instruction.type.toUpperCase()}`
        : "STRAIGHT";
  const progressLabel = navigationState
    ? `${(navigationState.routeMatch.progressMeters / 1_000).toFixed(2)} / ${(navigationState.routeMatch.totalMeters / 1_000).toFixed(2)} KM`
    : "-";
  const upcomingTurns = navigationState && routeIndex ? findUpcomingTurns(routeIndex, navigationState.routeMatch.progressMeters, 260, 2) : [];
  const thenInstruction = instruction?.type === "left" || instruction?.type === "right"
    ? upcomingTurns.find((turn) => turn.key !== instruction.key) ?? null
    : null;
  const showRecoveryActions = isOffRoute && currentPosition !== null && recoveryPromptVisible;
  const workoutDistanceKm = workoutDistanceMeters / 1_000;

  const togglePause = () => {
    const workout = workoutRef.current;
    if (!workout) return;
    const now = Date.now();
    if (isPaused) {
      workoutRef.current = resumeWorkout(workout, now);
      smoothedPositionRef.current = null;
      publishedPositionRef.current = null;
      paceEmaRef.current = null;
      setPaceSecondsPerKm(null);
    } else {
      workoutRef.current = pauseWorkout(workout, now);
    }
    isPausedRef.current = !isPaused;
    setIsPaused(!isPaused);
    setElapsedSeconds(elapsedWorkoutSeconds(workoutRef.current, now));
    persistActiveWorkout();
    syncActiveWorkoutToServer(true);
  };

  const saveCompletedWorkout = (summary: ReturnType<typeof createWorkoutSummary>) => {
    try {
      localStorage.setItem(WORKOUT_SUMMARY_STORAGE_KEY, JSON.stringify(summary));
      return true;
    } catch {
      console.warn("PEROG workout summary could not be saved.");
      return false;
    }
  };

  const endWorkout = () => {
    const workout = workoutRef.current;
    if (!workout || !navigationData || !routeIndex) {
      router.replace("/create");
      return;
    }
    isFinalizingRef.current = true;
    const endedAt = Date.now();
    const summary = createWorkoutSummary(
      workout,
      endedAt,
      routeIndex.totalMeters,
      navigationData.routeType,
      navigationData.route,
      navigationState?.progressRatio ?? 0
    );
    if (!saveCompletedWorkout(summary)) {
      isFinalizingRef.current = false;
      return;
    }
    if (auth.status === "authenticated") {
      void fetch("/api/workouts/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...summary, sourceWorkoutId: summary.id, routeId: navigationData.routeId ?? null, plannedRoute: summary.plannedRoute, actualDistanceMeters: summary.distanceMeters }),
        keepalive: true,
      }).catch(() => setServerSyncError(true));
    }
    clearActiveWorkout();
    router.replace("/navigate/summary");
  };

  const resumeActiveWorkout = () => {
    const activeWorkout = activeWorkoutRecovery;
    if (!activeWorkout) return;
    restorePendingRef.current = activeWorkout;
    setActiveWorkoutRecovery(null);
    setNavigationData(navigationDataFromActiveWorkout(activeWorkout));
  };

  const finishRecoveredWorkout = () => {
    const activeWorkout = activeWorkoutRecovery;
    if (!activeWorkout) return;
    isFinalizingRef.current = true;
    const summary = createWorkoutSummary(
      activeWorkoutToSession(activeWorkout),
      Date.now(),
      activeWorkout.plannedDistanceMeters,
      activeWorkout.routeType,
      activeWorkout.route,
      activeWorkout.plannedDistanceMeters > 0 ? activeWorkout.progressMeters / activeWorkout.plannedDistanceMeters : 0
    );
    if (!saveCompletedWorkout(summary)) {
      isFinalizingRef.current = false;
      return;
    }
    if (auth.status === "authenticated") {
      void fetch("/api/workouts/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...summary, sourceWorkoutId: summary.id, plannedRoute: summary.plannedRoute, actualDistanceMeters: summary.distanceMeters }), keepalive: true }).catch(() => setServerSyncError(true));
    }
    clearActiveWorkout();
    setActiveWorkoutRecovery(null);
    router.replace("/navigate/summary");
  };

  const discardActiveWorkout = () => {
    clearActiveWorkout();
    if (auth.status === "authenticated") void fetch("/api/workouts/active", { method: "DELETE", keepalive: true }).catch(() => setServerSyncError(true));
    setShowActiveDiscardConfirm(false);
    setActiveWorkoutRecovery(null);
    if (legacyNavigationData) setNavigationData(legacyNavigationData);
    else router.replace("/create");
  };

  const requestRecovery = async () => {
    if (!routeIndex || !currentPosition || recoveryLoading) return;
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      const target = selectRecoveryTarget(routeIndex, navigationState?.routeMatch.progressMeters ?? progressRef.current);
      const response = await fetch("/api/navigation-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: currentPosition, target: target.point }),
      });
      const data = await response.json() as RecoveryResponse;
      if (!response.ok || !Array.isArray(data.route) || data.route.length < 2) throw new Error(data.error ?? "복귀 경로를 찾지 못했습니다.");
      setRecoveryPath(data.route);
      persistActiveWorkout();
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "복귀 경로를 찾지 못했습니다.");
    } finally {
      setRecoveryLoading(false);
    }
  };

  const exportDebugLog = () => {
    const blob = new Blob([JSON.stringify(debugLogRef.current, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `perog-navigation-debug-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  if (activeWorkoutRecovery) {
    const recoverySession = activeWorkoutToSession(activeWorkoutRecovery);
    const recoveryNow = clock || activeWorkoutRecovery.lastSavedAt;
    const staleWorkout = isActiveWorkoutStale(activeWorkoutRecovery, recoveryNow);
    const elapsed = elapsedWorkoutSeconds(recoverySession, recoveryNow);
    const completionPercent = activeWorkoutRecovery.plannedDistanceMeters > 0
      ? Math.round((activeWorkoutRecovery.progressMeters / activeWorkoutRecovery.plannedDistanceMeters) * 100)
      : 0;
    return (
      <main className="active-workout-recovery-page">
        <section className="active-workout-recovery-card">
          <small>PEROG · {staleWorkout ? "SAVED RUN" : "RUN IN PROGRESS"}</small>
          <h1>{staleWorkout ? "이전 러닝 기록이 남아 있습니다" : "진행 중인 러닝이 있습니다"}</h1>
          <div className="active-workout-recovery-metrics">
            <div><small>기록 거리</small><strong>{(activeWorkoutRecovery.workoutDistanceMeters / 1_000).toFixed(2)} KM</strong></div>
            <div><small>경과 시간</small><strong>{formatElapsedTime(elapsed)}</strong></div>
            <div><small>완료율</small><strong>{Math.max(0, Math.min(100, completionPercent))}%</strong></div>
          </div>
          <p>마지막 저장: {new Date(activeWorkoutRecovery.lastSavedAt).toLocaleString("ko-KR")}</p>
          {showActiveDiscardConfirm ? <div className="active-workout-recovery-confirm"><strong>기록을 완전히 삭제할까요?</strong><span>삭제한 GPS 기록은 복구할 수 없습니다.</span><div><button type="button" onClick={finishRecoveredWorkout}>기록 저장 후 종료</button><button type="button" className="is-danger" onClick={discardActiveWorkout}>기록 삭제</button><button type="button" onClick={() => setShowActiveDiscardConfirm(false)}>취소</button></div></div>
            : <div className="active-workout-recovery-actions">
              {staleWorkout ? <button type="button" onClick={finishRecoveredWorkout}>기록 확인</button> : <button type="button" onClick={resumeActiveWorkout}>이어서 하기</button>}
              {!staleWorkout && <button type="button" onClick={finishRecoveredWorkout}>기록 저장 후 종료</button>}
              <button type="button" className="is-danger" onClick={() => setShowActiveDiscardConfirm(true)}>{legacyNavigationData ? "삭제 후 새 러닝 시작" : "삭제"}</button>
            </div>}
        </section>
      </main>
    );
  }

  return (
    <main className={`navigation-page navigation-page--${displayMode}${isPaused ? " navigation-page--paused" : ""}`}>
      <video ref={videoRef} className="navigation-camera" autoPlay playsInline muted />
      <div className="navigation-overlay">
        <div className="navigation-top">
          <button className="navigation-back-button" type="button" onClick={() => requestNavigation({ kind: "history", delta: historyGuardRef.current?.installed ? -2 : -1 })} aria-label="내비게이션 닫기">←</button>
          <div className="navigation-brand"><strong>PEROG</strong><span>LIVE NAVIGATION</span></div>
          {currentPosition && <div className={`navigation-gps navigation-gps--${gpsSignal}`}>GPS ±{Math.round(currentPosition.accuracy)}m</div>}
        </div>

        {serverSyncError && <div className="navigation-sync-status">계정 동기화가 중단되었습니다. 러닝은 기기에 계속 저장됩니다.</div>}

        <div className="navigation-toolbar" aria-label="내비게이션 제어">
          <div className="navigation-mode-controls">
            {(["camera", "map", "simple"] as const).map((mode) => <button key={mode} type="button" className={displayMode === mode ? "is-active" : ""} onClick={() => setDisplayMode(mode)}>{mode.toUpperCase()}</button>)}
          </div>
          <button type="button" onClick={togglePause}>{isPaused ? "RESUME" : "PAUSE"}</button>
          <button className="navigation-toolbar__end" type="button" onClick={() => setShowEndConfirm(true)}>END</button>
          <button type="button" className="navigation-toolbar__settings" onClick={() => setShowSettings((visible) => !visible)} aria-expanded={showSettings} aria-controls="navigation-settings">⚙<span className="sr-only">내비게이션 설정</span></button>
        </div>

        <div className="navigation-center">
          {routeLoadError ? <div className="navigation-status navigation-status--error">{routeLoadError}</div>
            : displayMode === "camera" && isCameraStarting ? <div className="navigation-status">카메라를 시작하고 있습니다...</div>
              : displayMode === "camera" && cameraError ? <div className="navigation-status navigation-status--error">{cameraError}</div>
                : <>
                  {isPaused && <span className="navigation-paused-badge">PAUSED · 기록 중지</span>}
                  <div className={hasRouteIssue ? "navigation-main-icon navigation-main-icon--invalid" : "navigation-main-icon navigation-main-icon--valid"} style={{ transform: !hasRouteIssue && visibleArrowType === "straight" ? `rotate(${headingDifference ?? 0}deg)` : "none" }}>
                    <NavigationArrowIcon type={visibleArrowType} />
                  </div>
                  <strong className={hasRouteIssue ? "navigation-instruction navigation-instruction--invalid" : "navigation-instruction"}>{mainInstruction}</strong>
                  <span className="navigation-sub-instruction">{subInstruction}</span>
                  {!orientationEnabled && <button type="button" className="navigation-orientation-button" onClick={enableOrientation}>방향 센서 시작</button>}
                  {(orientationError || showCompassNotice) && <span className="navigation-compass-notice">{orientationError ?? "방향 센서를 확인하고 있습니다"}</span>}
                </>}
        </div>

        {showRecoveryActions && <div className="navigation-recovery-card">
          <strong>경로에서 벗어났습니다</strong>
          <span>{recoveryPath ? "복귀 경로를 지도에 표시했습니다." : "기존 경로의 앞쪽 지점으로 안내할 수 있습니다."}</span>
          {recoveryError && <small>{recoveryError}</small>}
          <div><button type="button" onClick={() => void requestRecovery()} disabled={recoveryLoading}>{recoveryLoading ? "복귀 경로 확인 중" : "기존 경로로 복귀"}</button><button type="button" onClick={() => { setRecoveryPromptVisible(false); setRecoveryError(null); }}>계속 진행</button></div>
        </div>}

        {navigationData && <NavigationMiniMap
          route={navigationData.route}
          actualTrack={workoutTrack}
          recoveryPath={recoveryPath}
          currentPosition={currentPosition}
          progressMeters={navigationState?.routeMatch.progressMeters ?? null}
          headingDegrees={activeHeading ?? navigationState?.targetBearing ?? null}
          nextTurn={instruction ?? null}
          isOffRoute={hasRouteIssue}
          variant={displayMode === "map" ? "large" : "mini"}
        />}

        <div className="navigation-footer">
          <div className="navigation-bottom">
            <div><small>REMAINING</small><strong>{remainingKm !== null ? `${remainingKm.toFixed(2)} KM` : "-"}</strong></div>
            <div><small>NEXT</small><strong>{nextLabel}</strong>{thenInstruction && <span className="navigation-next-then">THEN {Math.round(thenInstruction.distanceMeters ?? 0)}m {thenInstruction.type.toUpperCase()}</span>}</div>
          </div>
          <div className="navigation-secondary-stats" aria-label="러닝 상태">
            <div><small>PACE</small><strong>{formatPace(paceSecondsPerKm)}</strong></div>
            <div><small>TIME</small><strong>{formatElapsedTime(elapsedSeconds)}</strong></div>
            <div><small>PROGRESS</small><strong>{progressLabel}</strong></div>
          </div>
        </div>

        {showSettings && <section className="navigation-settings-sheet" id="navigation-settings" aria-label="내비게이션 설정">
          <div className="navigation-settings-sheet__heading"><div><small>NAVIGATION SETTINGS</small><strong>러닝 안내 설정</strong></div><button type="button" onClick={() => setShowSettings(false)} aria-label="설정 닫기">×</button></div>
          <div className="navigation-settings-sheet__rows">
            <button type="button" onClick={() => setVoiceEnabled(!voiceEnabled)}><span>Voice Guidance</span><strong>{voiceEnabled ? "ON" : "OFF"}</strong></button>
            <button type="button" onClick={() => setVibrationEnabled(!vibrationEnabled)}><span>Vibration</span><strong>{vibrationEnabled ? "ON" : "OFF"}</strong></button>
            <div className="navigation-settings-sheet__status"><span>Compass</span><strong className={`is-${compassStatus.toLowerCase()}`}>{compassStatus}</strong></div>
            <div className="navigation-settings-sheet__display"><span>Display Mode</span><div>{(["camera", "map", "simple"] as const).map((mode) => <button key={mode} type="button" className={displayMode === mode ? "is-active" : ""} onClick={() => setDisplayMode(mode)}>{mode.toUpperCase()}</button>)}</div></div>
            {CAN_SHOW_DEBUG_CONTROLS && <div className="navigation-settings-sheet__debug"><button type="button" className={debugEnabled ? "is-active" : ""} onClick={() => setDebugEnabled(!debugEnabled)}>DEBUG {debugEnabled ? "ON" : "OFF"}</button>{debugEnabled && <button type="button" onClick={exportDebugLog}>EXPORT DEBUG LOG</button>}</div>}
          </div>
        </section>}

        {leaveGuard.isOpen && <NavigationConfirmModal kind="leave" workoutDistanceKm={workoutDistanceKm} onCancel={cancelLeaveNavigation} onConfirm={confirmLeaveNavigation} />}
        {(showEndConfirm || showArrivalPrompt) && <NavigationConfirmModal kind={showArrivalPrompt ? "arrival" : "end"} workoutDistanceKm={workoutDistanceKm} onConfirm={endWorkout} onCancel={() => { arrivalDismissedRef.current = true; setShowArrivalPrompt(false); setShowEndConfirm(false); }} />}
      </div>
    </main>
  );
}
