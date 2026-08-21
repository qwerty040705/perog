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
};

type TurnType = "straight" | "left" | "right" | "finish";

type TurnInstruction = {
  type: TurnType;
  text: string;
  distanceMeters: number;
  turnAngle: number;
};

type NavigationState = {
  nearestIndex: number;
  targetIndex: number;
  distanceToRouteMeters: number;
  targetBearing: number;
  remainingDistanceMeters: number;
  turnInstruction: TurnInstruction;
};

const LOOK_AHEAD_METERS = 40;
const TURN_LOOK_AHEAD_METERS = 35;
const TURN_THRESHOLD_DEGREES = 25;
const FINISH_THRESHOLD_METERS = 20;
const OFF_ROUTE_THRESHOLD_METERS = 35;

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

function findNearestRouteIndex(route: RoutePoint[], current: RoutePoint) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < route.length; index += 1) {
    const distance = haversineMeters(current, route[index]);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return {
    index: nearestIndex,
    distanceMeters: nearestDistance,
  };
}

function findLookAheadIndex(route: RoutePoint[], startIndex: number, lookAheadMeters: number) {
  let accumulated = 0;

  for (let index = startIndex + 1; index < route.length; index += 1) {
    accumulated += haversineMeters(route[index - 1], route[index]);

    if (accumulated >= lookAheadMeters) {
      return index;
    }
  }

  return route.length - 1;
}

function remainingRouteDistance(
  route: RoutePoint[],
  startIndex: number,
  currentPosition: RoutePoint
) {
  if (route.length < 2) {
    return 0;
  }

  let total = haversineMeters(currentPosition, route[startIndex]);

  for (let index = startIndex + 1; index < route.length; index += 1) {
    total += haversineMeters(route[index - 1], route[index]);
  }

  return total;
}

function routeDistanceBetweenIndexes(route: RoutePoint[], fromIndex: number, toIndex: number) {
  let total = 0;

  for (let index = fromIndex + 1; index <= toIndex && index < route.length; index += 1) {
    total += haversineMeters(route[index - 1], route[index]);
  }

  return total;
}

function findTurnInstruction(
  route: RoutePoint[],
  nearestIndex: number,
  remainingDistanceMeters: number
): TurnInstruction {
  if (remainingDistanceMeters <= FINISH_THRESHOLD_METERS) {
    return {
      type: "finish",
      text: "목적지에 도착했습니다",
      distanceMeters: remainingDistanceMeters,
      turnAngle: 0,
    };
  }

  if (nearestIndex >= route.length - 2) {
    return {
      type: "straight",
      text: "계속 직진하세요",
      distanceMeters: remainingDistanceMeters,
      turnAngle: 0,
    };
  }

  const firstIndex = findLookAheadIndex(route, nearestIndex, LOOK_AHEAD_METERS);

  const secondIndex = findLookAheadIndex(route, firstIndex, TURN_LOOK_AHEAD_METERS);

  if (firstIndex <= nearestIndex || secondIndex <= firstIndex) {
    return {
      type: "straight",
      text: "계속 직진하세요",
      distanceMeters: LOOK_AHEAD_METERS,
      turnAngle: 0,
    };
  }

  const incomingBearing = bearingDegrees(route[nearestIndex], route[firstIndex]);

  const outgoingBearing = bearingDegrees(route[firstIndex], route[secondIndex]);

  const turnAngle = normalizeAngle(outgoingBearing - incomingBearing);

  const distanceToTurn = routeDistanceBetweenIndexes(route, nearestIndex, firstIndex);

  if (Math.abs(turnAngle) < TURN_THRESHOLD_DEGREES) {
    return {
      type: "straight",
      text: "계속 직진하세요",
      distanceMeters: distanceToTurn,
      turnAngle,
    };
  }

  if (turnAngle > 0) {
    return {
      type: "right",
      text: `${Math.max(10, Math.round(distanceToTurn / 10) * 10)}m 후 우회전`,
      distanceMeters: distanceToTurn,
      turnAngle,
    };
  }

  return {
    type: "left",
    text: `${Math.max(10, Math.round(distanceToTurn / 10) * 10)}m 후 좌회전`,
    distanceMeters: distanceToTurn,
    turnAngle,
  };
}

function arrowSymbol(type: TurnType) {
  if (type === "left") {
    return "↖";
  }

  if (type === "right") {
    return "↗";
  }

  if (type === "finish") {
    return "●";
  }

  return "↑";
}

export default function NavigatePage() {
  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [navigationData, setNavigationData] = useState<NavigationData | null>(null);

  const [currentPosition, setCurrentPosition] = useState<CurrentPosition | null>(null);

  const [deviceHeading, setDeviceHeading] = useState<number | null>(null);

  const [navigationState, setNavigationState] = useState<NavigationState | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);

  const [gpsError, setGpsError] = useState<string | null>(null);

  const [isCameraStarting, setIsCameraStarting] = useState(true);

  /*
   * ==================================================
   * 저장된 route 불러오기
   * ==================================================
   */

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

      setNavigationData(parsed);
    } catch (error) {
      console.error("Navigation route load failed:", error);

      setCameraError("경로 데이터를 불러오지 못했습니다.");
    }
  }, []);

  /*
   * ==================================================
   * 카메라
   * ==================================================
   */

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

  /*
   * ==================================================
   * GPS
   * ==================================================
   */

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("이 브라우저는 위치 정보를 지원하지 않습니다.");

      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setCurrentPosition({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });

        setGpsError(null);
      },
      (error) => {
        console.error("GPS error:", error);

        setGpsError("현재 위치를 확인할 수 없습니다.");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15_000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  /*
   * ==================================================
   * Device heading
   * ==================================================
   */

  useEffect(() => {
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

    window.addEventListener("deviceorientation", handleOrientation, true);

    return () => {
      window.removeEventListener("deviceorientation", handleOrientation, true);
    };
  }, []);

  /*
   * ==================================================
   * 현재 route 상태 계산
   * ==================================================
   */

  useEffect(() => {
    if (!navigationData || !currentPosition) {
      return;
    }

    const route = navigationData.route;

    const nearest = findNearestRouteIndex(route, currentPosition);

    const targetIndex = findLookAheadIndex(route, nearest.index, LOOK_AHEAD_METERS);

    const target = route[targetIndex] ?? route[route.length - 1];

    const targetBearing = bearingDegrees(currentPosition, target);

    const remainingDistanceMeters = remainingRouteDistance(route, nearest.index, currentPosition);

    const turnInstruction = findTurnInstruction(route, nearest.index, remainingDistanceMeters);

    setNavigationState({
      nearestIndex: nearest.index,
      targetIndex,
      distanceToRouteMeters: nearest.distanceMeters,
      targetBearing,
      remainingDistanceMeters,
      turnInstruction,
    });
  }, [navigationData, currentPosition]);

  /*
   * ==================================================
   * 카메라 기준 화살표 회전
   * ==================================================
   */

  const arrowRotation = useMemo(() => {
    if (!navigationState || deviceHeading === null) {
      return 0;
    }

    return normalizeAngle(navigationState.targetBearing - deviceHeading);
  }, [navigationState, deviceHeading]);

  const offRouteThreshold = currentPosition
    ? Math.max(OFF_ROUTE_THRESHOLD_METERS, currentPosition.accuracy * 1.5)
    : OFF_ROUTE_THRESHOLD_METERS;

  const isOffRoute =
    navigationState !== null && navigationState.distanceToRouteMeters > offRouteThreshold;

  const remainingKm = navigationState
    ? navigationState.remainingDistanceMeters / 1000
    : (navigationData?.distanceKm ?? null);

  const instruction = navigationState?.turnInstruction ?? null;

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
            <div className="navigation-gps">GPS ±{Math.round(currentPosition.accuracy)}m</div>
          )}
        </div>

        <div className="navigation-center">
          {isCameraStarting ? (
            <div className="navigation-status">카메라를 시작하고 있습니다...</div>
          ) : cameraError ? (
            <div className="navigation-status navigation-status--error">{cameraError}</div>
          ) : (
            <>
              {isOffRoute && <div className="navigation-off-route">경로에서 벗어났습니다</div>}

              <div
                className="navigation-arrow"
                style={{
                  transform:
                    instruction?.type === "finish" ? "none" : `rotate(${arrowRotation}deg)`,
                }}
              >
                {instruction ? arrowSymbol(instruction.type) : "↑"}
              </div>

              <strong className="navigation-instruction">
                {instruction ? instruction.text : "GPS 연결 중"}
              </strong>

              <span className="navigation-sub-instruction">
                {navigationState
                  ? `경로까지 ${Math.round(navigationState.distanceToRouteMeters)}m`
                  : (gpsError ?? "현재 위치를 확인하고 있습니다.")}
              </span>
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
              {instruction ? (instruction.type === "finish" ? "ARRIVAL" : instruction.text) : "-"}
            </strong>
          </div>
        </div>
      </div>
    </main>
  );
}
