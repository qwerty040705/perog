"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadKakaoMapsSdk } from "@/lib/kakao-map";

export type SelectedLocation = { latitude: number; longitude: number; name: string; address: string };
type PickerMode = "gps" | "map";
type Props = { open: boolean; mode: PickerMode; targetLabel: string; initialCenter?: { latitude: number; longitude: number } | null; onClose: () => void; onConfirm: (location: SelectedLocation) => void };

export default function LocationPickerModal({ open, mode, targetLabel, initialCenter, onClose, onConfirm }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<kakao.maps.Map | null>(null);
  const markerRef = useRef<kakao.maps.CustomOverlay | null>(null);
  const selectPointRef = useRef<(latitude: number, longitude: number) => Promise<void>>(async () => {});
  const manualSelectionRef = useRef(false);
  const isLoadingRef = useRef(false);
  const requestIdRef = useRef(0);
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null);
  const [manualSelection, setManualSelection] = useState(mode === "map");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const resolveAddress = useCallback(async (latitude: number, longitude: number): Promise<SelectedLocation> => {
    const response = await fetch(`/api/reverse-geocode?${new URLSearchParams({ lat: String(latitude), lon: String(longitude) })}`);
    const data = (await response.json()) as { location?: { name?: string; address?: string }; error?: string };
    if (!response.ok) throw new Error(data.error ?? "주소를 확인하지 못했습니다.");
    return { latitude, longitude, name: data.location?.name ?? "선택한 위치", address: data.location?.address ?? "주소 정보 없음" };
  }, []);

  const selectPoint = useCallback(async (latitude: number, longitude: number) => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setErrorMessage("");
    setSelectedLocation({ latitude, longitude, name: "주소 확인 중...", address: "선택한 위치의 주소를 확인하고 있습니다." });
    try {
      const resolved = await resolveAddress(latitude, longitude);
      if (requestId !== requestIdRef.current) return;
      setSelectedLocation(resolved);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error("Kakao reverse geocode failed:", error);
      setSelectedLocation({ latitude, longitude, name: "선택한 위치", address: "주소 정보를 불러오지 못했습니다." });
      setErrorMessage("주소 정보를 불러오지 못했습니다.");
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [resolveAddress]);

  useEffect(() => {
    selectPointRef.current = selectPoint;
  }, [selectPoint]);

  useEffect(() => {
    manualSelectionRef.current = manualSelection;
    isLoadingRef.current = isLoading;
  }, [manualSelection, isLoading]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        requestIdRef.current += 1;
        setSelectedLocation(null);
        setErrorMessage("");
      }
    });
    const initialize = async () => {
      try {
        const maps = await loadKakaoMapsSdk();
        if (cancelled || !containerRef.current) return;
        const center = initialCenter ?? { latitude: 37.5665, longitude: 126.978 };
        const map = new maps.Map(containerRef.current, { center: new maps.LatLng(center.latitude, center.longitude), level: 5 });
        mapRef.current = map;
        map.addControl(new maps.ZoomControl(), maps.ControlPosition.RIGHT);
        maps.event.addListener(map, "click", (event) => {
          if (manualSelectionRef.current && !isLoadingRef.current) {
            void selectPointRef.current(event.latLng.getLat(), event.latLng.getLng());
          }
        });
        window.setTimeout(() => map.relayout(), 0);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "카카오 지도를 불러오지 못했습니다.");
      }
    };
    void initialize();
    return () => { cancelled = true; requestIdRef.current += 1; markerRef.current?.setMap(null); mapRef.current = null; markerRef.current = null; };
  }, [open, initialCenter]);

  useEffect(() => {
    if (!selectedLocation || !mapRef.current) return;
    void loadKakaoMapsSdk().then((maps) => {
      if (!mapRef.current) return;
      markerRef.current?.setMap(null);
      const content = document.createElement("div");
      content.className = "kakao-route-marker kakao-route-marker--accent";
      content.textContent = "선택 위치";
      markerRef.current = new maps.CustomOverlay({ position: new maps.LatLng(selectedLocation.latitude, selectedLocation.longitude), content, xAnchor: 0.5, yAnchor: 0.5 });
      markerRef.current.setMap(mapRef.current);
      mapRef.current.setCenter(new maps.LatLng(selectedLocation.latitude, selectedLocation.longitude));
      mapRef.current.setLevel(4);
    });
  }, [selectedLocation]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (mode === "map") { setManualSelection(true); return; }
      setManualSelection(false);
      if (!navigator.geolocation) { setErrorMessage("현재 위치 기능을 사용할 수 없습니다."); setManualSelection(true); return; }
      setIsLoading(true);
      navigator.geolocation.getCurrentPosition(
        (position) => { if (!cancelled) void selectPoint(position.coords.latitude, position.coords.longitude); },
        () => { if (!cancelled) { setIsLoading(false); setErrorMessage("현재 위치를 가져오지 못했습니다. 지도에서 직접 선택해주세요."); setManualSelection(true); } },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
    return () => { cancelled = true; };
  }, [open, mode, selectPoint]);

  if (!open) return null;
  return <div className="location-modal-backdrop"><div className="location-modal" role="dialog" aria-modal="true"><div className="location-modal__header"><div><small>LOCATION SELECT</small><h2>{targetLabel}</h2></div><button type="button" className="location-modal__close" onClick={onClose} aria-label="닫기">×</button></div><div className="location-modal__map"><div ref={containerRef} className="location-modal__kakao" />{manualSelection && !isLoading && <div className="location-modal__map-hint">지도에서 원하는 위치를 클릭하세요</div>}{isLoading && <div className="location-modal__loading">위치를 확인하고 있습니다...</div>}</div><div className="location-modal__content">{errorMessage && <div className="location-modal__error">{errorMessage}</div>}{selectedLocation && !isLoading ? <><div className="location-modal__selected"><span className="location-modal__selected-dot" /><div><small>{mode === "gps" && !manualSelection ? "현재 위치" : "선택한 위치"}</small><strong>{selectedLocation.name}</strong><p>{selectedLocation.address}</p></div></div><div className="location-modal__actions"><button type="button" className="location-modal__confirm" onClick={() => onConfirm(selectedLocation)}>이 위치로 선택</button><button type="button" onClick={() => setManualSelection(true)}>지도에서 다시 선택</button></div></> : <div className="location-modal__description"><strong>{isLoading ? "위치를 확인하고 있습니다." : "지도에서 위치를 선택하세요."}</strong><p>선택한 좌표는 카카오 주소 API로 확인합니다.</p></div>}</div></div></div>;
}
