"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createRouteIndex, findUpcomingTurn, pointAtDistance, routeWindow, type RoutePoint } from "@/lib/navigation";
import { loadKakaoMapsSdk } from "@/lib/kakao-map";

type Turn = {
  type: "straight" | "left" | "right" | "finish";
  distanceMeters: number | null;
};

type NavigationMiniMapProps = {
  route: RoutePoint[];
  actualTrack?: RoutePoint[];
  recoveryPath?: RoutePoint[] | null;
  currentPosition: RoutePoint | null;
  progressMeters: number | null;
  headingDegrees: number | null;
  nextTurn: Turn | null;
  isOffRoute: boolean;
  variant?: "mini" | "large";
};

const LOOK_AHEAD_METERS = 260;

function makePositionMarker() {
  const marker = document.createElement("div");
  marker.className = "navigation-mini-map__position";
  const arrow = document.createElement("span");
  arrow.textContent = "▲";
  marker.appendChild(arrow);
  return marker;
}

function makeTurnMarker(type: "left" | "right") {
  const marker = document.createElement("div");
  marker.className = `navigation-mini-map__turn navigation-mini-map__turn--${type}`;
  marker.textContent = type === "left" ? "↰" : "↱";
  return marker;
}

export default function NavigationMiniMap({
  route,
  actualTrack = [],
  recoveryPath = null,
  currentPosition,
  progressMeters,
  headingDegrees,
  nextTurn,
  isOffRoute,
  variant = "mini",
}: NavigationMiniMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const routeLineRef = useRef<kakao.maps.Polyline | null>(null);
  const actualTrackLineRef = useRef<kakao.maps.Polyline | null>(null);
  const recoveryLineRef = useRef<kakao.maps.Polyline | null>(null);
  const positionOverlayRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const turnOverlayRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const turnTypeRef = useRef<"left" | "right" | null>(null);
  const positionMarkerRef = useRef<HTMLDivElement | null>(null);
  const initialPointRef = useRef(route[0]);
  const [mapsSdk, setMapsSdk] = useState<typeof kakao.maps | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const index = useMemo(() => createRouteIndex(route), [route]);
  const activeProgress = progressMeters ?? 0;
  const visibleRoute = useMemo(
    () => routeWindow(index, activeProgress, activeProgress + LOOK_AHEAD_METERS),
    [activeProgress, index]
  );
  const markerTurn = useMemo(() => {
    if (nextTurn?.type === "left" || nextTurn?.type === "right") return nextTurn;
    const nextGeometryTurn = findUpcomingTurn(index, activeProgress, LOOK_AHEAD_METERS);
    return nextGeometryTurn.type === "left" || nextGeometryTurn.type === "right" ? nextGeometryTurn : null;
  }, [activeProgress, index, nextTurn]);

  useEffect(() => {
    let cancelled = false;

    void loadKakaoMapsSdk()
      .then((maps) => {
        if (cancelled || !containerRef.current) return;

        mapRef.current = new maps.Map(containerRef.current, {
          center: new maps.LatLng(initialPointRef.current?.latitude ?? 37.5665, initialPointRef.current?.longitude ?? 126.978),
          level: 4,
        });
        mapRef.current.setDraggable(false);
        mapRef.current.setZoomable(false);
        setMapsSdk(maps);
      })
      .catch(() => {
        if (!cancelled) setMapFailed(true);
      });

    return () => {
      cancelled = true;
      routeLineRef.current?.setMap(null);
      actualTrackLineRef.current?.setMap(null);
      recoveryLineRef.current?.setMap(null);
      positionOverlayRef.current?.setMap(null);
      turnOverlayRef.current?.setMap(null);
      routeLineRef.current = null;
      actualTrackLineRef.current = null;
      recoveryLineRef.current = null;
      positionOverlayRef.current = null;
      turnOverlayRef.current = null;
      turnTypeRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapsSdk || !map || visibleRoute.length < 2) return;

    const path = visibleRoute.map((point) => new mapsSdk.LatLng(point.latitude, point.longitude));
    if (!routeLineRef.current) {
      routeLineRef.current = new mapsSdk.Polyline({
        path,
        strokeWeight: 5,
        strokeColor: isOffRoute ? "#ff4141" : "#c6ff00",
        strokeOpacity: 0.96,
        strokeStyle: "solid",
      });
      routeLineRef.current.setMap(map);
    } else {
      routeLineRef.current.setPath(path);
      routeLineRef.current.setOptions({ strokeColor: isOffRoute ? "#ff4141" : "#c6ff00" });
    }

    const center = currentPosition ?? visibleRoute[0];
    map.setCenter(new mapsSdk.LatLng(center.latitude, center.longitude));
  }, [currentPosition, isOffRoute, mapsSdk, visibleRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapsSdk || !map) return;
    if (actualTrack.length < 2) {
      actualTrackLineRef.current?.setMap(null);
      actualTrackLineRef.current = null;
      return;
    }
    const path = actualTrack.map((point) => new mapsSdk.LatLng(point.latitude, point.longitude));
    if (!actualTrackLineRef.current) {
      actualTrackLineRef.current = new mapsSdk.Polyline({ path, strokeWeight: 3, strokeColor: "#f5f7f2", strokeOpacity: 0.9, strokeStyle: "solid" });
      actualTrackLineRef.current.setMap(map);
    } else {
      actualTrackLineRef.current.setPath(path);
    }
  }, [actualTrack, mapsSdk]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapsSdk || !map) return;
    if (!recoveryPath || recoveryPath.length < 2) {
      recoveryLineRef.current?.setMap(null);
      recoveryLineRef.current = null;
      return;
    }
    const path = recoveryPath.map((point) => new mapsSdk.LatLng(point.latitude, point.longitude));
    if (!recoveryLineRef.current) {
      recoveryLineRef.current = new mapsSdk.Polyline({ path, strokeWeight: 4, strokeColor: "#ffb547", strokeOpacity: 0.95, strokeStyle: "shortdash" });
      recoveryLineRef.current.setMap(map);
    } else {
      recoveryLineRef.current.setPath(path);
    }
  }, [mapsSdk, recoveryPath]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapsSdk || !map || !currentPosition) return;

    const position = new mapsSdk.LatLng(currentPosition.latitude, currentPosition.longitude);
    if (!positionOverlayRef.current) {
      positionMarkerRef.current = makePositionMarker();
      positionOverlayRef.current = new mapsSdk.CustomOverlay({
        position,
        content: positionMarkerRef.current,
        xAnchor: 0.5,
        yAnchor: 0.5,
      });
      positionOverlayRef.current.setMap(map);
    } else {
      positionOverlayRef.current.setPosition(position);
    }

    positionMarkerRef.current?.style.setProperty("--perog-mini-heading", `${headingDegrees ?? 0}deg`);
    positionMarkerRef.current?.classList.toggle("navigation-mini-map__position--off-route", isOffRoute);
  }, [currentPosition, headingDegrees, isOffRoute, mapsSdk]);

  useEffect(() => {
    const map = mapRef.current;
    const turnType = markerTurn?.type;
    if (!mapsSdk || !map || markerTurn === null || (turnType !== "left" && turnType !== "right") || markerTurn.distanceMeters === null) {
      turnOverlayRef.current?.setMap(null);
      turnOverlayRef.current = null;
      turnTypeRef.current = null;
      return;
    }

    const point = pointAtDistance(index, activeProgress, markerTurn.distanceMeters);
    const position = new mapsSdk.LatLng(point.latitude, point.longitude);
    if (!turnOverlayRef.current || turnTypeRef.current !== markerTurn.type) {
      turnOverlayRef.current?.setMap(null);
      turnOverlayRef.current = new mapsSdk.CustomOverlay({
        position,
        content: makeTurnMarker(turnType),
        xAnchor: 0.5,
        yAnchor: 0.5,
      });
      turnOverlayRef.current.setMap(map);
      turnTypeRef.current = turnType;
    } else {
      turnOverlayRef.current.setPosition(position);
    }
  }, [activeProgress, index, mapsSdk, markerTurn]);

  useEffect(() => {
    mapRef.current?.relayout();
  }, [variant]);

  return (
    <div className={`navigation-mini-map navigation-mini-map--${variant}`} aria-label="현재 위치 주변 경로 지도">
      <div ref={containerRef} className="navigation-mini-map__canvas" />
      <span className="navigation-mini-map__label">{mapFailed ? "MAP OFFLINE" : "ROUTE AHEAD"}</span>
    </div>
  );
}
