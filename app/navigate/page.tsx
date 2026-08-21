"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type RoutePoint = {
  latitude: number;
  longitude: number;
};

type SelectedLocation = RoutePoint & {
  name: string;
  address: string;
};

type NavigationData = {
  route: RoutePoint[];
  routeType: string | null;
  distanceKm: number | null;
  start: SelectedLocation | null;
  destination: SelectedLocation | null;
};

type CurrentPosition = {
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  gpsHeading: number | null;
};

type TurnType = "straight" | "left" | "right" | "finish";

type TurnInstruction = {
  type: TurnType;
  text: string;
  distanceMeters: number | null;
};

type RouteMatch = {
  segmentIndex: number;
  segmentFraction: number;
  distanceMeters: number;
  matchedPoint: RoutePoint;
};

type NavigationState = {
  routeMatch: RouteMatch;
  targetIndex: number;
  targetBearing: number;
  remainingDistanceMeters: number;
  progressRatio: number;
  turnInstruction: TurnInstruction;
};

/* ==================================================
 * Constants
 * ================================================== */

/*
 * 평상시 진행 방향을 계산할 때
 * 현재 위치보다 약 35m 앞의 route를 목표로 한다.
 */
const STRAIGHT_LOOK_AHEAD_METERS = 35;

/*
 * 좌/우회전 아이콘은 실제 회전 지점이
 * 20m 이내에 있을 때만 보여준다.
 */
const TURN_DISPLAY_DISTANCE_METERS = 20;

/*
 * 55도 이상 꺾이는 경우만 실제 turn으로 본다.
 *
 * 기존 38도보다 보수적으로 설정해서
 * 굽은 보행로를 우회전/좌회전으로
 * 오인하는 것을 줄인다.
 */
const TURN_THRESHOLD_DEGREES = 55;

/*
 * 회전 지점 앞뒤 각각 약 18m의
 * 전체적인 방향을 비교한다.
 */
const TURN_SAMPLE_DISTANCE_METERS = 18;

/*
 * 현재 위치 바로 앞 5m 이내의
 * polyline 굴곡은 turn으로 표시하지 않는다.
 *
 * "1m 후 우회전" 같은 오탐 방지.
 */
const MIN_TURN_DISTANCE_METERS = 5;

/*
 * 목적지 15m 이내.
 */
const FINISH_THRESHOLD_METERS = 15;

/*
 * 순환형 / 왕복형에서 시작점을
 * 도착점으로 잘못 판단하지 않도록
 * route를 90% 이상 진행해야 finish 가능.
 */
const FINISH_PROGRESS_RATIO = 0.9;

/*
 * 기본 경로 이탈 허용 거리.
 */
const MIN_OFF_ROUTE_METERS = 20;

/*
 * GPS accuracy가 60m보다 나쁘면
 * off-route 판정을 확정하지 않는다.
 */
const MAX_RELIABLE_GPS_ACCURACY_METERS = 60;

/*
 * GPS 위치 smoothing.
 */
const GPS_SMOOTHING_ALPHA = 0.38;

/*
 * 방향센서 React 업데이트 최대 주기.
 * 100ms = 최대 10Hz.
 */
const ORIENTATION_UPDATE_INTERVAL_MS = 100;

/* ==================================================
 * Math
 * ================================================== */

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function haversineMeters(a: RoutePoint, b: RoutePoint) {
  const earthRadius = 6_371_000;

  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const dLat = toRadians(b.latitude - a.latitude);

  const dLon = toRadians(b.longitude - a.longitude);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);

  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDegrees(from: RoutePoint, to: RoutePoint) {
  const lat1 = toRadians(from.latitude);

  const lat2 = toRadians(to.latitude);

  const dLon = toRadians(to.longitude - from.longitude);

  const y = Math.sin(dLon) * Math.cos(lat2);

  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function normalizeAngle(angle: number) {
  let result = angle % 360;

  if (result > 180) {
    result -= 360;
  }

  if (result < -180) {
    result += 360;
  }

  return result;
}

/* ==================================================
 * Local coordinates
 * ================================================== */

type LocalPoint = {
  x: number;
  y: number;
};

function toLocalPoint(point: RoutePoint, origin: RoutePoint): LocalPoint {
  const latitudeRadians = toRadians(origin.latitude);

  return {
    x: (point.longitude - origin.longitude) * 111_320 * Math.cos(latitudeRadians),

    y: (point.latitude - origin.latitude) * 111_320,
  };
}

function projectPointToSegment(current: RoutePoint, from: RoutePoint, to: RoutePoint) {
  const a = toLocalPoint(from, current);

  const b = toLocalPoint(to, current);

  const dx = b.x - a.x;

  const dy = b.y - a.y;

  const lengthSquared = dx * dx + dy * dy;

  let fraction = 0;

  if (lengthSquared > 0) {
    fraction = -(a.x * dx + a.y * dy) / lengthSquared;

    fraction = Math.max(0, Math.min(1, fraction));
  }

  const projectedX = a.x + fraction * dx;

  const projectedY = a.y + fraction * dy;

  const distanceMeters = Math.hypot(projectedX, projectedY);

  return {
    fraction,
    distanceMeters,
  };
}

function interpolateRoutePoint(from: RoutePoint, to: RoutePoint, fraction: number): RoutePoint {
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * fraction,

    longitude: from.longitude + (to.longitude - from.longitude) * fraction,
  };
}

/* ==================================================
 * Route matching
 * ================================================== */

function findNearestRouteSegment(
  route: RoutePoint[],
  current: RoutePoint,
  previousSegmentIndex: number
): RouteMatch {
  if (route.length < 2) {
    return {
      segmentIndex: 0,
      segmentFraction: 0,
      distanceMeters: Infinity,
      matchedPoint: route[0] ?? current,
    };
  }

  /*
   * 순환형 / 왕복형에서는
   *
   * route 시작점 A
   * route 마지막점 A
   *
   * 가 같은 위치일 수 있다.
   *
   * 따라서 route 전체를
   * 매번 검색하지 않고
   * 현재 진행 index 주변만 검색한다.
   */

  const startIndex = Math.max(0, previousSegmentIndex - 10);

  const endIndex = Math.min(route.length - 2, previousSegmentIndex + 60);

  let bestSegmentIndex = startIndex;

  let bestFraction = 0;

  let bestDistance = Infinity;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const projected = projectPointToSegment(current, route[index], route[index + 1]);

    if (projected.distanceMeters < bestDistance) {
      bestDistance = projected.distanceMeters;

      bestSegmentIndex = index;

      bestFraction = projected.fraction;
    }
  }

  const matchedPoint = interpolateRoutePoint(
    route[bestSegmentIndex],
    route[bestSegmentIndex + 1],
    bestFraction
  );

  return {
    segmentIndex: bestSegmentIndex,

    segmentFraction: bestFraction,

    distanceMeters: bestDistance,

    matchedPoint,
  };
}

/* ==================================================
 * Route distances
 * ================================================== */

function remainingRouteDistance(route: RoutePoint[], match: RouteMatch) {
  if (route.length < 2) {
    return 0;
  }

  const nextIndex = Math.min(match.segmentIndex + 1, route.length - 1);

  let total = haversineMeters(match.matchedPoint, route[nextIndex]);

  for (let index = nextIndex + 1; index < route.length; index += 1) {
    total += haversineMeters(route[index - 1], route[index]);
  }

  return total;
}

function findIndexAtDistance(route: RoutePoint[], startIndex: number, distanceMeters: number) {
  let accumulated = 0;

  for (let index = startIndex + 1; index < route.length; index += 1) {
    accumulated += haversineMeters(route[index - 1], route[index]);

    if (accumulated >= distanceMeters) {
      return index;
    }
  }

  return route.length - 1;
}

function findBackwardIndexAtDistance(
  route: RoutePoint[],
  startIndex: number,
  distanceMeters: number
) {
  let accumulated = 0;

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    accumulated += haversineMeters(route[index], route[index + 1]);

    if (accumulated >= distanceMeters) {
      return index;
    }
  }

  return 0;
}

/* ==================================================
 * Turn detection
 * ================================================== */

function findUpcomingTurn(route: RoutePoint[], match: RouteMatch): TurnInstruction {
  const startIndex = Math.min(match.segmentIndex + 1, route.length - 1);

  /*
   * matched point부터
   * 다음 route point까지의 거리.
   */
  let distanceFromCurrent = haversineMeters(match.matchedPoint, route[startIndex]);

  for (let candidateIndex = startIndex; candidateIndex < route.length - 1; candidateIndex += 1) {
    if (candidateIndex > startIndex) {
      distanceFromCurrent += haversineMeters(route[candidateIndex - 1], route[candidateIndex]);
    }

    /*
     * 20m보다 먼 turn은
     * 아직 보여주지 않는다.
     */
    if (distanceFromCurrent > TURN_DISPLAY_DISTANCE_METERS) {
      break;
    }

    /*
     * 너무 가까운 polyline 굴곡은
     * 실제 교차로 turn이 아니라
     * GPS/polyline geometry일
     * 가능성이 높기 때문에 무시.
     *
     * 1m 후 우회전 방지.
     */
    if (distanceFromCurrent < MIN_TURN_DISTANCE_METERS) {
      continue;
    }

    const beforeIndex = findBackwardIndexAtDistance(
      route,
      candidateIndex,
      TURN_SAMPLE_DISTANCE_METERS
    );

    const afterIndex = findIndexAtDistance(route, candidateIndex, TURN_SAMPLE_DISTANCE_METERS);

    if (beforeIndex === candidateIndex || afterIndex === candidateIndex) {
      continue;
    }

    const incomingBearing = bearingDegrees(route[beforeIndex], route[candidateIndex]);

    const outgoingBearing = bearingDegrees(route[candidateIndex], route[afterIndex]);

    const turnAngle = normalizeAngle(outgoingBearing - incomingBearing);

    /*
     * 55도 미만의 방향 변화는
     * 단순한 곡선으로 보고
     * turn으로 표시하지 않는다.
     */
    if (Math.abs(turnAngle) < TURN_THRESHOLD_DEGREES) {
      continue;
    }

    const roundedDistance = Math.max(MIN_TURN_DISTANCE_METERS, Math.round(distanceFromCurrent));

    if (turnAngle > 0) {
      return {
        type: "right",

        text: `${roundedDistance}m 후 우회전`,

        distanceMeters: distanceFromCurrent,
      };
    }

    return {
      type: "left",

      text: `${roundedDistance}m 후 좌회전`,

      distanceMeters: distanceFromCurrent,
    };
  }

  /*
   * 20m 안에 확실한 turn이 없으면
   * 무조건 평상시 진행 방향 안내.
   */
  return {
    type: "straight",
    text: "직진하세요",
    distanceMeters: null,
  };
}

/* ==================================================
 * Arrow icons
 * ================================================== */

function NavigationArrowIcon({ type }: { type: TurnType | "invalid" }) {
  /*
   * 경로 이탈
   */
  if (type === "invalid") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path
          d="
            M30 30
            L90 90

            M90 30
            L30 90
          "
          fill="none"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  /*
   * 좌회전
   */
  if (type === "left") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path
          d="
            M78 102
            V68

            C78 48
             65 36
             46 36

            H27

            M44 19
            L27 36
            L44 53
          "
          fill="none"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  /*
   * 우회전
   */
  if (type === "right") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path
          d="
            M42 102
            V68

            C42 48
             55 36
             74 36

            H93

            M76 19
            L93 36
            L76 53
          "
          fill="none"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  /*
   * 도착
   */
  if (type === "finish") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="28" fill="none" stroke="currentColor" strokeWidth="12" />

        <circle cx="60" cy="60" r="8" fill="currentColor" />
      </svg>
    );
  }

  /*
   * 일반 진행 방향
   */
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <path
        d="
          M60 103
          V27

          M35 52
          L60 27
          L85 52
        "
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ==================================================
 * Page
 * ================================================== */

export default function NavigatePage() {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);

  /*
   * route 시작 index.
   *
   * 순환형 / 왕복형이
   * 마지막 segment에서
   * 시작되는 것을 방지.
   */
  const lastRouteSegmentRef = useRef<number>(0);

  const smoothedPositionRef = useRef<RoutePoint | null>(null);

  const [navigationData, setNavigationData] = useState<NavigationData | null>(null);

  const [currentPosition, setCurrentPosition] = useState<CurrentPosition | null>(null);

  const [deviceHeading, setDeviceHeading] = useState<number | null>(null);

  const [orientationEnabled, setOrientationEnabled] = useState(false);

  const [orientationError, setOrientationError] = useState<string | null>(null);

  const [navigationState, setNavigationState] = useState<NavigationState | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);

  const [gpsError, setGpsError] = useState<string | null>(null);

  const [isCameraStarting, setIsCameraStarting] = useState(true);

  /* ==================================================
   * Saved route
   * ================================================== */

  useEffect(() => {
    const saved = sessionStorage.getItem("perog-navigation-route");

    if (!saved) {
      setCameraError("저장된 경로가 없습니다.");

      return;
    }

    try {
      const parsed = JSON.parse(saved) as NavigationData;

      if (!Array.isArray(parsed.route) || parsed.route.length < 2) {
        throw new Error("올바른 경로가 아닙니다.");
      }

      lastRouteSegmentRef.current = 0;

      smoothedPositionRef.current = null;

      setNavigationData(parsed);
    } catch (error) {
      console.error("Navigation route load failed:", error);

      setCameraError("경로 데이터를 불러오지 못했습니다.");
    }
  }, []);

  /* ==================================================
   * Camera
   * ================================================== */

  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("이 브라우저는 카메라를 지원하지 않습니다.");
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: {
              ideal: "environment",
            },
          },

          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        setIsCameraStarting(false);
      } catch (error) {
        console.error("Camera start failed:", error);

        setCameraError("카메라를 사용할 수 없습니다.");

        setIsCameraStarting(false);
      }
    };

    void startCamera();

    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  /* ==================================================
   * GPS
   * ================================================== */

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("이 브라우저는 위치 정보를 지원하지 않습니다.");

      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy, speed, heading } = position.coords;

        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          !Number.isFinite(accuracy)
        ) {
          return;
        }

        const previous = smoothedPositionRef.current;

        const alpha = previous ? GPS_SMOOTHING_ALPHA : 1;

        const smoothed: RoutePoint = previous
          ? {
              latitude: previous.latitude + alpha * (latitude - previous.latitude),

              longitude: previous.longitude + alpha * (longitude - previous.longitude),
            }
          : {
              latitude,
              longitude,
            };

        smoothedPositionRef.current = smoothed;

        setCurrentPosition({
          latitude: smoothed.latitude,

          longitude: smoothed.longitude,

          accuracy,

          speed: typeof speed === "number" && Number.isFinite(speed) ? speed : null,

          gpsHeading: typeof heading === "number" && Number.isFinite(heading) ? heading : null,
        });

        setGpsError(null);
      },

      (error) => {
        console.error("GPS error:", {
          code: error.code,

          message: error.message,
        });

        if (error.code === error.PERMISSION_DENIED) {
          setGpsError("위치 권한이 거부되었습니다.");
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setGpsError("현재 위치 정보를 사용할 수 없습니다.");
        } else if (error.code === error.TIMEOUT) {
          setGpsError("GPS 위치 확인 시간이 초과되었습니다.");
        } else {
          setGpsError("현재 위치를 확인할 수 없습니다.");
        }
      },

      {
        enableHighAccuracy: true,

        maximumAge: 0,

        timeout: 30_000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  /* ==================================================
   * iPhone orientation permission
   * ================================================== */

  const enableOrientation = async () => {
    try {
      const OrientationEvent = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<"granted" | "denied">;
      };

      if (typeof OrientationEvent.requestPermission === "function") {
        const permission = await OrientationEvent.requestPermission();

        if (permission !== "granted") {
          setOrientationError("방향 센서 권한이 거부되었습니다.");

          return;
        }
      }

      setOrientationEnabled(true);

      setOrientationError(null);
    } catch (error) {
      console.error("Orientation permission failed:", error);

      setOrientationError("방향 센서를 시작하지 못했습니다.");
    }
  };

  /* ==================================================
   * Device heading
   * ================================================== */

  useEffect(() => {
    if (!orientationEnabled) {
      return;
    }

    let lastUpdateTime = 0;

    const handleOrientation = (event: DeviceOrientationEvent) => {
      const now = performance.now();

      /*
       * 방향센서는 이벤트가
       * 매우 빠르게 들어오므로
       * 최대 10Hz로 제한.
       */
      if (now - lastUpdateTime < ORIENTATION_UPDATE_INTERVAL_MS) {
        return;
      }

      lastUpdateTime = now;

      const iosHeading = (
        event as DeviceOrientationEvent & {
          webkitCompassHeading?: number;
        }
      ).webkitCompassHeading;

      /*
       * iPhone Safari에서는
       * webkitCompassHeading 우선.
       */
      if (typeof iosHeading === "number" && Number.isFinite(iosHeading)) {
        setDeviceHeading(iosHeading);

        return;
      }

      /*
       * fallback.
       */
      if (typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
        setDeviceHeading((360 - event.alpha) % 360);
      }
    };

    /*
     * deviceorientation 하나만 사용.
     */
    window.addEventListener("deviceorientation", handleOrientation, true);

    return () => {
      window.removeEventListener("deviceorientation", handleOrientation, true);
    };
  }, [orientationEnabled]);

  /* ==================================================
   * Navigation state
   * ================================================== */

  useEffect(() => {
    if (!navigationData || !currentPosition) {
      return;
    }

    const route = navigationData.route;

    const match = findNearestRouteSegment(route, currentPosition, lastRouteSegmentRef.current);

    /*
     * GPS가 잠깐 튀어도
     * route index가 크게
     * 뒤로 돌아가지 않게 한다.
     */
    if (match.segmentIndex >= lastRouteSegmentRef.current - 3) {
      lastRouteSegmentRef.current = match.segmentIndex;
    }

    /*
     * 현재 위치에서
     * 약 35m 앞의 route 방향.
     */
    const targetIndex = findIndexAtDistance(route, match.segmentIndex, STRAIGHT_LOOK_AHEAD_METERS);

    const target = route[targetIndex] ?? route[route.length - 1];

    const targetBearing = bearingDegrees(currentPosition, target);

    const remainingDistanceMeters = remainingRouteDistance(route, match);

    /*
     * route 진행률.
     *
     * 순환형 / 왕복형의
     * 출발점 = 목적지 문제를
     * 방지하기 위해 사용.
     */
    const progressRatio =
      route.length > 1 ? (match.segmentIndex + match.segmentFraction) / (route.length - 1) : 0;

    let turnInstruction: TurnInstruction;

    /*
     * 목적지는
     *
     * 1. route 90% 이상 진행
     * 2. 남은 거리 15m 이내
     *
     * 두 조건 모두 만족해야 한다.
     */
    if (
      progressRatio >= FINISH_PROGRESS_RATIO &&
      remainingDistanceMeters <= FINISH_THRESHOLD_METERS
    ) {
      turnInstruction = {
        type: "finish",

        text: "목적지에 도착했습니다",

        distanceMeters: remainingDistanceMeters,
      };
    } else {
      turnInstruction = findUpcomingTurn(route, match);
    }

    setNavigationState({
      routeMatch: match,

      targetIndex,

      targetBearing,

      remainingDistanceMeters,

      progressRatio,

      turnInstruction,
    });
  }, [navigationData, currentPosition]);

  /* ==================================================
   * Active heading
   * ================================================== */

  const activeHeading = useMemo(() => {
    /*
     * 방향센서 우선.
     */
    if (deviceHeading !== null) {
      return deviceHeading;
    }

    /*
     * 방향 센서를 못 쓰는 경우
     * 실제 이동 중이면
     * GPS heading fallback.
     */
    if (
      currentPosition?.gpsHeading !== null &&
      currentPosition?.gpsHeading !== undefined &&
      (currentPosition.speed ?? 0) > 0.8
    ) {
      return currentPosition.gpsHeading;
    }

    return null;
  }, [deviceHeading, currentPosition]);

  /* ==================================================
   * Heading difference
   * ================================================== */

  /*
   * TARGET - HEADING
   *
   * 0°:
   * 정면
   *
   * +90°:
   * 오른쪽
   *
   * -90°:
   * 왼쪽
   *
   * ±180°:
   * 뒤쪽
   */
  const headingDifference = useMemo(() => {
    if (!navigationState || activeHeading === null) {
      return null;
    }

    return normalizeAngle(navigationState.targetBearing - activeHeading);
  }, [navigationState, activeHeading]);

  const arrowRotation = headingDifference ?? 0;

  /* ==================================================
   * Route validity
   * ================================================== */

  const gpsReliable =
    currentPosition !== null && currentPosition.accuracy <= MAX_RELIABLE_GPS_ACCURACY_METERS;

  /*
   * GPS accuracy가 좋지 않으면
   * off-route 허용 거리도
   * 자동으로 조금 늘어난다.
   */
  const offRouteThreshold = currentPosition
    ? Math.max(
        MIN_OFF_ROUTE_METERS,

        currentPosition.accuracy * 1.25
      )
    : MIN_OFF_ROUTE_METERS;

  const isOffRoute = Boolean(
    navigationState && gpsReliable && navigationState.routeMatch.distanceMeters > offRouteThreshold
  );

  /* ==================================================
   * Display values
   * ================================================== */

  const remainingKm = navigationState
    ? navigationState.remainingDistanceMeters / 1000
    : (navigationData?.distanceKm ?? null);

  const instruction = navigationState?.turnInstruction ?? null;

  const visibleArrowType: TurnType | "invalid" = isOffRoute
    ? "invalid"
    : (instruction?.type ?? "straight");

  const mainInstruction = isOffRoute
    ? "경로가 올바르지 않습니다"
    : (instruction?.text ?? "GPS 연결 중");

  const subInstruction =
    isOffRoute && navigationState
      ? `경로에서 약 ${Math.round(navigationState.routeMatch.distanceMeters)}m 떨어져 있습니다.`
      : !gpsReliable && currentPosition
        ? "GPS 정확도를 확인하고 있습니다."
        : navigationState
          ? `경로 오차 ${Math.round(navigationState.routeMatch.distanceMeters)}m`
          : (gpsError ?? "현재 위치를 확인하고 있습니다.");

  /* ==================================================
   * Debug values
   * ================================================== */

  const debugHeading = activeHeading !== null ? `${Math.round(activeHeading)}°` : "-";

  const debugTarget = navigationState ? `${Math.round(navigationState.targetBearing)}°` : "-";

  const debugDiff =
    headingDifference !== null
      ? `${headingDifference > 0 ? "+" : ""}${Math.round(headingDifference)}°`
      : "-";

  /* ==================================================
   * Render
   * ================================================== */

  return (
    <main className="navigation-page">
      <video ref={videoRef} className="navigation-camera" autoPlay playsInline muted />

      <div className="navigation-overlay">
        {/* ==================================================
            TOP
            ================================================== */}

        <div className="navigation-top">
          <button className="navigation-back-button" type="button" onClick={() => router.back()}>
            ←
          </button>

          <div className="navigation-brand">
            <strong>PEROG</strong>

            <span>LIVE NAVIGATION</span>
          </div>

          {currentPosition && (
            <div className={gpsReliable ? "navigation-gps" : "navigation-gps navigation-gps--weak"}>
              GPS ±{Math.round(currentPosition.accuracy)}m
            </div>
          )}
        </div>

        {/* ==================================================
            DEBUG
            ================================================== */}

        <div className="navigation-debug">
          <div>
            <small>HEADING</small>

            <strong>{debugHeading}</strong>
          </div>

          <div>
            <small>TARGET</small>

            <strong>{debugTarget}</strong>
          </div>

          <div>
            <small>DIFF</small>

            <strong>{debugDiff}</strong>
          </div>
        </div>

        {/* ==================================================
            ORIENTATION PERMISSION
            ================================================== */}

        {!orientationEnabled && (
          <button
            type="button"
            className="navigation-orientation-button-fixed"
            onClick={enableOrientation}
          >
            방향 센서 시작
          </button>
        )}

        {orientationError && (
          <div className="navigation-orientation-error-fixed">{orientationError}</div>
        )}

        {/* ==================================================
            CENTER
            ================================================== */}

        <div className="navigation-center">
          {isCameraStarting ? (
            <div className="navigation-status">카메라를 시작하고 있습니다...</div>
          ) : cameraError ? (
            <div className="navigation-status navigation-status--error">{cameraError}</div>
          ) : (
            <>
              <div
                className={
                  isOffRoute
                    ? "navigation-main-icon navigation-main-icon--invalid"
                    : "navigation-main-icon navigation-main-icon--valid"
                }
                style={{
                  /*
                   * 평상시에는 화살표가
                   * 실제 가야 할 방향을 가리킨다.
                   *
                   * 좌/우회전 turn icon은
                   * 표지판처럼 고정해서 보여준다.
                   */
                  transform:
                    !isOffRoute && visibleArrowType === "straight"
                      ? `rotate(${arrowRotation}deg)`
                      : "none",
                }}
              >
                <NavigationArrowIcon type={visibleArrowType} />
              </div>

              <strong
                className={
                  isOffRoute
                    ? "navigation-instruction navigation-instruction--invalid"
                    : "navigation-instruction"
                }
              >
                {mainInstruction}
              </strong>

              <span className="navigation-sub-instruction">{subInstruction}</span>
            </>
          )}
        </div>

        {/* ==================================================
            BOTTOM
            ================================================== */}

        <div className="navigation-bottom">
          <div>
            <small>REMAINING</small>

            <strong>{remainingKm !== null ? `${remainingKm.toFixed(2)} KM` : "-"}</strong>
          </div>

          <div>
            <small>NEXT</small>

            <strong>
              {isOffRoute
                ? "OFF ROUTE"
                : instruction?.type === "finish"
                  ? "ARRIVAL"
                  : instruction?.type === "left" || instruction?.type === "right"
                    ? instruction.text
                    : "STRAIGHT"}
            </strong>
          </div>
        </div>
      </div>
    </main>
  );
}
