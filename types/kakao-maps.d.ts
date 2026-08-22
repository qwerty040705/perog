declare global {
  namespace kakao.maps {
    class LatLng { constructor(latitude: number, longitude: number); getLat(): number; getLng(): number; }
    class LatLngBounds { extend(latLng: LatLng): void; }
    class Map { constructor(container: HTMLElement, options: { center: LatLng; level?: number }); addControl(control: ZoomControl, position: ControlPosition): void; setCenter(latLng: LatLng): void; setLevel(level: number): void; getLevel(): number; setDraggable(draggable: boolean): void; setZoomable(zoomable: boolean): void; setBounds(bounds: LatLngBounds, top?: number, right?: number, bottom?: number, left?: number): void; relayout(): void; }
    class ZoomControl {}
    class Polyline { constructor(options: { path: LatLng[]; strokeWeight: number; strokeColor: string; strokeOpacity: number; strokeStyle: string }); setMap(map: Map | null): void; setPath(path: LatLng[]): void; setOptions(options: Partial<{ strokeWeight: number; strokeColor: string; strokeOpacity: number; strokeStyle: string }>): void; }
    class CustomOverlay { constructor(options: { position: LatLng; content: HTMLElement; xAnchor?: number; yAnchor?: number }); setMap(map: Map | null): void; setPosition(position: LatLng): void; }
    const ControlPosition: { RIGHT: ControlPosition };
    type ControlPosition = unknown;
    namespace event { function addListener(target: Map, eventName: "click", handler: (event: { latLng: LatLng }) => void): void; function addListener(target: Map, eventName: "zoom_changed", handler: () => void): void; }
    function load(callback: () => void): void;
  }
  interface Window { kakao?: { maps: typeof kakao.maps }; }
}

export {};
