import { haversineMeters, type RoutePoint } from "./navigation.ts";

export type RequiredSegmentGeometry = {
  start: RoutePoint;
  end: RoutePoint;
  route: RoutePoint[];
  distanceKm: number;
};

export type RequiredSegmentValidation = { valid: true; distanceKm: number } | { valid: false; message: string };

export function validateRequiredSegmentGeometry(item: RequiredSegmentGeometry): RequiredSegmentValidation {
  const endpointToleranceMeters = 80;
  const maxJumpMeters = 600;
  const first = item.route[0];
  const last = item.route[item.route.length - 1];
  if (!first || !last || haversineMeters(first, item.start) > endpointToleranceMeters || haversineMeters(last, item.end) > endpointToleranceMeters) {
    return { valid: false, message: "필수 구간의 시작점 또는 끝점이 경로와 일치하지 않습니다." };
  }
  let meters = 0;
  for (let index = 1; index < item.route.length; index += 1) {
    const jumpMeters = haversineMeters(item.route[index - 1], item.route[index]);
    if (jumpMeters > maxJumpMeters) return { valid: false, message: "필수 구간에 비정상적으로 큰 좌표 점프가 있습니다." };
    meters += jumpMeters;
  }
  const distanceKm = meters / 1000;
  if (Math.abs(item.distanceKm - distanceKm) > Math.max(0.15, distanceKm * 0.25)) {
    return { valid: false, message: "필수 구간 거리가 경로 좌표와 일치하지 않습니다." };
  }
  return { valid: true, distanceKm };
}
