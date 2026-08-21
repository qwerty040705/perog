"use client";

import { useEffect, useRef, useState } from "react";
import { loadKakaoMapsSdk } from "@/lib/kakao-map";

type RoutePoint = { latitude: number; longitude: number };
type SelectedLocation = RoutePoint & { name: string; address: string };
type RouteType = "순환형" | "왕복형" | "편도형";
type RequiredItem =
  | { id: string; type: "waypoint"; location: SelectedLocation }
  | {
      id: string;
      type: "segment";
      start: SelectedLocation;
      end: SelectedLocation;
      route: RoutePoint[];
      distanceKm: number;
    };

type RouteMapProps = {
  route: RoutePoint[] | null;
  routeType: RouteType | null;
  locationA: SelectedLocation | null;
  locationB: SelectedLocation | null;
  requiredItems: RequiredItem[];
};

type MapOverlay = kakao.maps.Polyline | kakao.maps.CustomOverlay;

type RouteRun = {
  points: RoutePoint[];
  overlaps: boolean;
};

const OVERLAP_COLOR = "#ff8a3d";

function segmentKey(from: RoutePoint, to: RoutePoint) {
  const first = `${from.latitude.toFixed(5)},${from.longitude.toFixed(5)}`;
  const second = `${to.latitude.toFixed(5)},${to.longitude.toFixed(5)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function overlappingSegmentKeys(route: RoutePoint[]) {
  const counts = new Map<string, number>();

  for (let index = 1; index < route.length; index += 1) {
    const key = segmentKey(route[index - 1], route[index]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function splitRouteRuns(route: RoutePoint[], overlapKeys: Set<string>): RouteRun[] {
  const runs: RouteRun[] = [];
  let current: RouteRun | null = null;

  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    const overlaps = overlapKeys.has(segmentKey(from, to));

    if (!current || current.overlaps !== overlaps) {
      current = { points: [from, to], overlaps };
      runs.push(current);
    } else {
      current.points.push(to);
    }
  }

  return runs;
}

function distanceMeters(from: RoutePoint, to: RoutePoint) {
  const latitudeRadians = ((from.latitude + to.latitude) / 2) * (Math.PI / 180);
  const latitudeMeters = (to.latitude - from.latitude) * 111_320;
  const longitudeMeters = (to.longitude - from.longitude) * 111_320 * Math.cos(latitudeRadians);
  return Math.hypot(latitudeMeters, longitudeMeters);
}

function routeTangentDegrees(from: RoutePoint, to: RoutePoint) {
  const latitudeRadians = ((from.latitude + to.latitude) / 2) * (Math.PI / 180);
  const x = (to.longitude - from.longitude) * Math.cos(latitudeRadians);
  /* 지도 화면의 y축은 아래가 양수이므로 위도 변화는 반전한다. */
  const y = -(to.latitude - from.latitude);
  return Math.atan2(y, x) * (180 / Math.PI);
}

function arrowSpacingMeters(zoomLevel: number) {
  if (zoomLevel <= 3) return 520;
  if (zoomLevel <= 5) return 820;
  if (zoomLevel <= 7) return 1_250;
  return 1_800;
}

function createDirectionOverlays(
  maps: typeof kakao.maps,
  map: kakao.maps.Map,
  route: RoutePoint[]
) {
  const overlapKeys = overlappingSegmentKeys(route);
  const overlays: kakao.maps.CustomOverlay[] = [];
  const spacing = arrowSpacingMeters(map.getLevel());
  let metersSinceArrow = 0;

  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    const length = distanceMeters(from, to);
    metersSinceArrow += length;

    if (metersSinceArrow < spacing || length < 4) continue;

    metersSinceArrow = 0;
    const content = document.createElement("span");
    const overlaps = overlapKeys.has(segmentKey(from, to));
    content.className = overlaps
      ? "kakao-route-direction kakao-route-direction--overlap"
      : "kakao-route-direction";
    content.textContent = "➤";
    const tangentFrom = route[Math.max(0, index - 2)];
    const tangentTo = route[Math.min(route.length - 1, index + 2)];
    content.style.setProperty(
      "--perog-route-angle",
      `${routeTangentDegrees(tangentFrom, tangentTo)}deg`
    );
    const arrow = new maps.CustomOverlay({
      position: new maps.LatLng(
        (from.latitude + to.latitude) / 2,
        (from.longitude + to.longitude) / 2
      ),
      content,
      xAnchor: 0.5,
      yAnchor: 0.5,
    });
    arrow.setMap(map);
    overlays.push(arrow);
  }

  return overlays;
}

export default function RouteMap({
  route,
  routeType,
  locationA,
  locationB,
  requiredItems,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const overlaysRef = useRef<MapOverlay[]>([]);
  const directionOverlaysRef = useRef<kakao.maps.CustomOverlay[]>([]);
  const routeRef = useRef<RoutePoint[] | null>(null);
  const fittedRouteRef = useRef<RoutePoint[] | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    let cancelled = false;
    const renderMap = async () => {
      try {
        const maps = await loadKakaoMapsSdk();
        if (cancelled || !containerRef.current) return;

        if (!mapRef.current) {
          const center = locationA ?? { latitude: 37.5665, longitude: 126.978 };
          mapRef.current = new maps.Map(containerRef.current, {
            center: new maps.LatLng(center.latitude, center.longitude),
            level: locationA ? 6 : 8,
          });
          mapRef.current.setDraggable(true);
          mapRef.current.setZoomable(true);
          mapRef.current.addControl(new maps.ZoomControl(), maps.ControlPosition.RIGHT);
          maps.event.addListener(mapRef.current, "zoom_changed", () => {
            const activeMap = mapRef.current;
            const activeRoute = routeRef.current;

            if (!activeMap || !activeRoute || activeRoute.length < 2) return;

            directionOverlaysRef.current.forEach((overlay) => overlay.setMap(null));
            directionOverlaysRef.current = createDirectionOverlays(maps, activeMap, activeRoute);
          });
        }

        const map = mapRef.current;
        map.relayout();
        overlaysRef.current.forEach((overlay) => overlay.setMap(null));
        overlaysRef.current = [];
        directionOverlaysRef.current.forEach((overlay) => overlay.setMap(null));
        directionOverlaysRef.current = [];
        const bounds = new maps.LatLngBounds();
        let hasBounds = false;
        const pointToLatLng = (point: RoutePoint) => {
          const latLng = new maps.LatLng(point.latitude, point.longitude);
          bounds.extend(latLng);
          hasBounds = true;
          return latLng;
        };
        const addMarker = (location: SelectedLocation, label: string, accent = false) => {
          const content = document.createElement("div");
          content.className = accent
            ? "kakao-route-marker kakao-route-marker--accent"
            : "kakao-route-marker";
          content.textContent = label;
          const marker = new maps.CustomOverlay({
            position: pointToLatLng(location),
            content,
            xAnchor: 0.5,
            yAnchor: 0.5,
          });
          marker.setMap(map);
          overlaysRef.current.push(marker);
        };

        if (route && route.length >= 2) {
          const overlapKeys = overlappingSegmentKeys(route);
          const runs = splitRouteRuns(route, overlapKeys);

          runs.forEach((run) => {
            const path = run.points.map(pointToLatLng);
            const color = run.overlaps ? OVERLAP_COLOR : "#c6ff00";
            const glow = new maps.Polyline({
              path,
              strokeWeight: 14,
              strokeColor: "#070807",
              strokeOpacity: 0.62,
              strokeStyle: "solid",
            });
            const line = new maps.Polyline({
              path,
              strokeWeight: 6,
              strokeColor: color,
              strokeOpacity: 1,
              strokeStyle: "solid",
            });
            glow.setMap(map);
            line.setMap(map);
            overlaysRef.current.push(glow, line);
          });

          directionOverlaysRef.current = createDirectionOverlays(maps, map, route);
        }

        requiredItems.forEach((item, index) => {
          if (item.type === "waypoint") {
            addMarker(item.location, `경유 ${index + 1}`);
            return;
          }
          const path = item.route.map(pointToLatLng);
          if (path.length >= 2) {
            const line = new maps.Polyline({
              path,
              strokeWeight: 6,
              strokeColor: "#ffb547",
              strokeOpacity: route ? 0.45 : 1,
              strokeStyle: "solid",
            });
            line.setMap(map);
            overlaysRef.current.push(line);
          }
        });

        if (locationA) addMarker(locationA, routeType === "순환형" ? "A · 출발/도착" : "A", true);
        if (locationB && routeType !== "순환형") addMarker(locationB, "B", true);
        if (hasBounds) {
          if (fittedRouteRef.current !== route) {
            map.setBounds(bounds, 60, 60, 60, 60);
            fittedRouteRef.current = route;
          }
        } else if (locationA) {
          map.setCenter(new maps.LatLng(locationA.latitude, locationA.longitude));
          map.setLevel(6);
        }
        setMapError(null);
      } catch (error) {
        console.error("Kakao route map error:", error);
        setMapError(error instanceof Error ? error.message : "카카오 지도를 불러오지 못했습니다.");
      }
    };
    void renderMap();
    return () => {
      cancelled = true;
    };
  }, [route, routeType, locationA, locationB, requiredItems]);

  return (
    <div className="kakao-route-map">
      <div ref={containerRef} className="kakao-route-map__canvas" />

      {route && (
        <div className="kakao-route-legend">
          <span>
            <i className="kakao-route-legend__line" />
            진행 구간
          </span>

          <span>
            <i className="kakao-route-legend__line kakao-route-legend__line--overlap" />
            겹치는 구간
          </span>

          <span>
            <i className="kakao-route-legend__arrow">➜</i>
            진행 방향
          </span>
        </div>
      )}

      {!locationA && !mapError && (
        <div className="route-map__hint">
          <span className="route-map__hint-dot" />
          경로 설정에서 위치를 선택해주세요.
        </div>
      )}

      {mapError && <div className="kakao-route-map__error">{mapError}</div>}
    </div>
  );
}
