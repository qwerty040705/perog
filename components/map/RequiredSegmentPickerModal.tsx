"use client";

import { useEffect, useRef, useState } from "react";
import { loadKakaoMapsSdk } from "@/lib/kakao-map";

type RoutePoint = { latitude: number; longitude: number };
type SelectedLocation = RoutePoint & { name: string; address: string };
type Props = { open: boolean; initialCenter?: RoutePoint | null; onClose: () => void; onConfirm: (segment: { start: SelectedLocation; end: SelectedLocation; route: RoutePoint[]; distanceKm: number }) => void };
type SegmentResponse = { route?: RoutePoint[]; distanceKm?: number; error?: string };
type Overlay = kakao.maps.CustomOverlay | kakao.maps.Polyline;

export default function RequiredSegmentPickerModal({ open, initialCenter, onClose, onConfirm }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const overlaysRef = useRef<Overlay[]>([]);
  const selectPointRef = useRef<(point: RoutePoint) => Promise<void>>(async () => {});
  const isLoadingRef = useRef(false);
  const [start, setStart] = useState<SelectedLocation | null>(null);
  const [end, setEnd] = useState<SelectedLocation | null>(null);
  const [route, setRoute] = useState<RoutePoint[]>([]);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const reverseGeocode = async (point: RoutePoint, fallbackName: string): Promise<SelectedLocation> => {
    try {
      const response = await fetch(`/api/reverse-geocode?${new URLSearchParams({ lat: String(point.latitude), lon: String(point.longitude) })}`);
      const data = (await response.json()) as { location?: { name?: string; address?: string } };
      return { ...point, name: data.location?.name ?? fallbackName, address: data.location?.address ?? "주소 정보 없음" };
    } catch { return { ...point, name: fallbackName, address: "주소 정보 없음" }; }
  };

  const requestSegment = async (segmentStart: SelectedLocation, segmentEnd: SelectedLocation) => {
    setIsLoading(true); setError(""); setRoute([]); setDistanceKm(null);
    try {
      const response = await fetch("/api/pedestrian-segment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start: segmentStart, end: segmentEnd }) });
      const data = (await response.json()) as SegmentResponse;
      if (!response.ok || !data.route || data.distanceKm === undefined) throw new Error(data.error ?? "구간을 생성하지 못했습니다.");
      setRoute(data.route); setDistanceKm(data.distanceKm);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "구간을 생성하지 못했습니다."); }
    finally { setIsLoading(false); }
  };

  const selectPoint = async (point: RoutePoint) => {
    if (!start) { setStart(await reverseGeocode(point, "구간 시작점")); setEnd(null); setRoute([]); setDistanceKm(null); return; }
    if (!end) { const location = await reverseGeocode(point, "구간 끝점"); setEnd(location); await requestSegment(start, location); return; }
    setStart(await reverseGeocode(point, "구간 시작점")); setEnd(null); setRoute([]); setDistanceKm(null); setError("");
  };

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    selectPointRef.current = selectPoint;
  }, [selectPoint]);

  useEffect(() => {
    if (!open) return;
    setStart(null); setEnd(null); setRoute([]); setDistanceKm(null); setError("");
    let cancelled = false;
    const initialize = async () => {
      try {
        const maps = await loadKakaoMapsSdk();
        if (cancelled || !containerRef.current) return;
        const center = initialCenter ?? { latitude: 37.5665, longitude: 126.978 };
        const map = new maps.Map(containerRef.current, { center: new maps.LatLng(center.latitude, center.longitude), level: 5 });
        map.addControl(new maps.ZoomControl(), maps.ControlPosition.RIGHT);
        maps.event.addListener(map, "click", (event) => {
          if (!isLoadingRef.current) {
            void selectPointRef.current({ latitude: event.latLng.getLat(), longitude: event.latLng.getLng() });
          }
        });
        mapRef.current = map;
        window.setTimeout(() => map.relayout(), 0);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "카카오 지도를 불러오지 못했습니다."); }
    };
    void initialize();
    return () => { cancelled = true; mapRef.current = null; overlaysRef.current = []; };
  }, [open, initialCenter]);

  useEffect(() => {
    if (!mapRef.current) return;
    void loadKakaoMapsSdk().then((maps) => {
      const map = mapRef.current; if (!map) return;
      overlaysRef.current.forEach((overlay) => overlay.setMap(null)); overlaysRef.current = [];
      const bounds = new maps.LatLngBounds(); let hasBounds = false;
      const point = (value: RoutePoint) => { const latLng = new maps.LatLng(value.latitude, value.longitude); bounds.extend(latLng); hasBounds = true; return latLng; };
      const marker = (value: SelectedLocation, label: string, accent: boolean) => { const content = document.createElement("div"); content.className = accent ? "kakao-route-marker kakao-route-marker--accent" : "kakao-route-marker"; content.textContent = label; const overlay = new maps.CustomOverlay({ position: point(value), content, xAnchor: .5, yAnchor: .5 }); overlay.setMap(map); overlaysRef.current.push(overlay); };
      if (route.length >= 2) { const path = route.map(point); const line = new maps.Polyline({ path, strokeWeight: 6, strokeColor: "#ffb547", strokeOpacity: 1, strokeStyle: "solid" }); line.setMap(map); overlaysRef.current.push(line); }
      if (start) marker(start, "S", true); if (end) marker(end, "E", false);
      if (hasBounds) map.setBounds(bounds, 50, 50, 50, 50);
    });
  }, [start, end, route]);

  if (!open) return null;
  return <div className="location-modal-backdrop"><div className="location-modal segment-picker-modal" role="dialog" aria-modal="true"><div className="location-modal__header"><div><small>REQUIRED SEGMENT</small><h2>필수 구간 선택</h2></div><button type="button" className="location-modal__close" onClick={onClose}>×</button></div><div className="segment-picker-steps"><div className={start ? "active complete" : "active"}><span>1</span><div><strong>시작점</strong><small>{start ? start.name : "지도에서 시작점을 클릭하세요"}</small></div></div><div className={end ? "active complete" : start ? "active" : ""}><span>2</span><div><strong>끝점</strong><small>{end ? end.name : "그 다음 끝점을 클릭하세요"}</small></div></div></div><div className="location-modal__map segment-picker-map"><div ref={containerRef} className="location-modal__kakao" />{!start && <div className="location-modal__map-hint">시작점을 클릭하세요</div>}{start && !end && <div className="location-modal__map-hint">끝점을 클릭하세요</div>}{isLoading && <div className="location-modal__loading">보행 구간을 확인하고 있습니다...</div>}</div><div className="location-modal__content">{error && <div className="location-modal__error">{error}</div>}{start && end && route.length >= 2 && distanceKm !== null ? <><div className="segment-result"><small>REQUIRED PEDESTRIAN SEGMENT</small><strong>{start.name} → {end.name}</strong><p>이 보행 경로 {distanceKm.toFixed(2)} km를 최종 경로에 그대로 포함합니다.</p></div><div className="location-modal__actions"><button type="button" className="location-modal__confirm" onClick={() => onConfirm({ start, end, route, distanceKm })}>이 구간 포함</button><button type="button" onClick={() => { setStart(null); setEnd(null); setRoute([]); setDistanceKm(null); setError(""); }}>다시 선택</button></div></> : <div className="segment-picker-description"><strong>{!start ? "필수 구간의 시작점을 선택하세요." : !end ? "이제 끝점을 선택하세요." : "보행 경로를 확인하고 있습니다."}</strong><p>시작점과 끝점 사이의 실제 Kakao 보행 경로가 최종 러닝 경로에 그대로 포함됩니다.</p></div>}</div></div></div>;
}
