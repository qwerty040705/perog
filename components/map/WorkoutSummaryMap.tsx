"use client";

import { useEffect, useRef, useState } from "react";
import { loadKakaoMapsSdk } from "@/lib/kakao-map";
import type { RoutePoint } from "@/lib/navigation";

type WorkoutSummaryMapProps = {
  plannedRoute: RoutePoint[];
  track: RoutePoint[];
};

export default function WorkoutSummaryMap({ plannedRoute, track }: WorkoutSummaryMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const plannedLineRef = useRef<kakao.maps.Polyline | null>(null);
  const trackLineRef = useRef<kakao.maps.Polyline | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadKakaoMapsSdk().then((maps) => {
      if (cancelled || !containerRef.current) return;
      const first = track[0] ?? plannedRoute[0] ?? { latitude: 37.5665, longitude: 126.978 };
      const map = new maps.Map(containerRef.current, { center: new maps.LatLng(first.latitude, first.longitude), level: 5 });
      map.setDraggable(true);
      map.setZoomable(true);
      mapRef.current = map;
      const bounds = new maps.LatLngBounds();
      let hasPoints = false;
      const addPath = (points: RoutePoint[], color: string, weight: number, opacity: number) => {
        if (points.length < 2) return null;
        const path = points.map((point) => {
          const latLng = new maps.LatLng(point.latitude, point.longitude);
          bounds.extend(latLng);
          hasPoints = true;
          return latLng;
        });
        const line = new maps.Polyline({ path, strokeWeight: weight, strokeColor: color, strokeOpacity: opacity, strokeStyle: "solid" });
        line.setMap(map);
        return line;
      };
      plannedLineRef.current = addPath(plannedRoute, "#c6ff00", 5, 0.86);
      trackLineRef.current = addPath(track, "#f5f7f2", 4, 0.96);
      if (hasPoints) map.setBounds(bounds, 24, 24, 24, 24);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      plannedLineRef.current?.setMap(null);
      trackLineRef.current?.setMap(null);
      plannedLineRef.current = null;
      trackLineRef.current = null;
      mapRef.current = null;
    };
  }, [plannedRoute, track]);

  return <div className="workout-summary-map">{failed ? <span>지도를 불러오지 못했습니다.</span> : <div ref={containerRef} className="workout-summary-map__canvas" />}</div>;
}
