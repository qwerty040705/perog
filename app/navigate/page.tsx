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

const STRAIGHT_LOOK_AHEAD_METERS = 35;

const TURN_DISPLAY_DISTANCE_METERS = 20;

const TURN_THRESHOLD_DEGREES = 38;

const TURN_SAMPLE_DISTANCE_METERS = 12;

const FINISH_THRESHOLD_METERS = 15;

const FINISH_PROGRESS_RATIO = 0.9;

const MIN_OFF_ROUTE_METERS = 20;

const MAX_RELIABLE_GPS_ACCURACY_METERS = 60;

const GPS_SMOOTHING_ALPHA = 0.38;

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
   * 매우 중요:
   *
   * 순환형 / 왕복형은
   * route[0]과 route[end]가 A 근처이므로
   * 처음부터 route 전체를 검색하면
   * 마지막 segment에 매칭될 수 있다.
   *
   * 따라서 이전 진행 위치 주변만 검색한다.
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

  let distanceFromCurrent = haversineMeters(match.matchedPoint, route[startIndex]);

  for (let candidateIndex = startIndex; candidateIndex < route.length - 1; candidateIndex += 1) {
    if (candidateIndex > startIndex) {
      distanceFromCurrent += haversineMeters(route[candidateIndex - 1], route[candidateIndex]);
    }

    /*
     * 좌/우회전 안내는 20m 이내에서만.
     */
    if (distanceFromCurrent > TURN_DISPLAY_DISTANCE_METERS) {
      break;
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

    if (Math.abs(turnAngle) < TURN_THRESHOLD_DEGREES) {
      continue;
    }

    const roundedDistance = Math.max(1, Math.round(distanceFromCurrent));

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
  if (type === "invalid") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path
          d="M30 30L90 90M90 30L30 90"
          fill="none"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (type === "left") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path
          d="
            M78 102
            V68
            C78 48 65 36 46 36
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

  if (type === "right") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path
          d="
            M42 102
            V68
            C42 48 55 36 74 36
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

  if (type === "finish") {
    return (
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="28" fill="none" stroke="currentColor" strokeWidth="12" />

        <circle cx="60" cy="60" r="8" fill="currentColor" />
      </svg>
    );
  }

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
   * 순환형/왕복형 최초 매칭이
   * route 마지막으로 튀지 않도록 0에서 시작한다.
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
   * 저장된 route
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

      /*
       * 새 경로를 불러오면 진행상태 초기화.
       */
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

    const handleOrientation = (event: DeviceOrientationEvent) => {
      const iosHeading = (
        event as DeviceOrientationEvent & {
          webkitCompassHeading?: number;
        }
      ).webkitCompassHeading;

      if (typeof iosHeading === "number" && Number.isFinite(iosHeading)) {
        setDeviceHeading(iosHeading);

        return;
      }

      if (typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
        setDeviceHeading((360 - event.alpha) % 360);
      }
    };

    window.addEventListener("deviceorientationabsolute", handleOrientation, true);

    window.addEventListener("deviceorientation", handleOrientation, true);

    return () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation, true);

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
     * route 진행 index는 앞으로 진행시키되,
     * GPS 튐 때문에 갑자기 너무 뒤로 가지 않도록 한다.
     */
    if (match.segmentIndex >= lastRouteSegmentRef.current - 3) {
      lastRouteSegmentRef.current = match.segmentIndex;
    }

    const targetIndex = findIndexAtDistance(route, match.segmentIndex, STRAIGHT_LOOK_AHEAD_METERS);

    const target = route[targetIndex] ?? route[route.length - 1];

    const targetBearing = bearingDegrees(currentPosition, target);

    const remainingDistanceMeters = remainingRouteDistance(route, match);

    /*
     * 단순 좌표 거리만으로 도착 판정하면
     * 순환형 / 왕복형에서 시작하자마자
     * A가 도착점이라 도착으로 잘못 판단할 수 있다.
     *
     * 따라서 경로 진행률을 반드시 같이 본다.
     */
    const progressRatio =
      route.length > 1 ? (match.segmentIndex + match.segmentFraction) / (route.length - 1) : 0;

    let turnInstruction: TurnInstruction;

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
   * Heading
   * ================================================== */

  const activeHeading = useMemo(() => {
    if (deviceHeading !== null) {
      return deviceHeading;
    }

    /*
     * DeviceOrientation이 없을 경우
     * 실제 움직일 때 GPS heading 사용.
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

  const arrowRotation = useMemo(() => {
    if (!navigationState || activeHeading === null) {
      return 0;
    }

    return normalizeAngle(navigationState.targetBearing - activeHeading);
  }, [navigationState, activeHeading]);

  /* ==================================================
   * Route validity
   * ================================================== */

  const gpsReliable =
    currentPosition !== null && currentPosition.accuracy <= MAX_RELIABLE_GPS_ACCURACY_METERS;

  const offRouteThreshold = currentPosition
    ? Math.max(MIN_OFF_ROUTE_METERS, currentPosition.accuracy * 1.25)
    : MIN_OFF_ROUTE_METERS;

  const isOffRoute = Boolean(
    navigationState && gpsReliable && navigationState.routeMatch.distanceMeters > offRouteThreshold
  );

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

  return (
    <main className="navigation-page">
      <video ref={videoRef} className="navigation-camera" autoPlay playsInline muted />

      <div className="navigation-overlay">
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

        <div className="navigation-center">
          {isCameraStarting ? (
            <div className="navigation-status">카메라를 시작하고 있습니다...</div>
          ) : cameraError ? (
            <div className="navigation-status navigation-status--error">{cameraError}</div>
          ) : (
            <>
              {!orientationEnabled && (
                <button
                  type="button"
                  className="navigation-orientation-button"
                  onClick={enableOrientation}
                >
                  방향 센서 시작
                </button>
              )}

              {orientationError && (
                <div className="navigation-orientation-error">{orientationError}</div>
              )}

              <div
                className={
                  isOffRoute
                    ? "navigation-main-icon navigation-main-icon--invalid"
                    : "navigation-main-icon navigation-main-icon--valid"
                }
                style={{
                  /*
                   * 직진 화살표만 실제 진행 방향에 맞춰 회전.
                   *
                   * 좌/우회전 아이콘 자체는 고정된 안내 표지처럼 보여준다.
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
