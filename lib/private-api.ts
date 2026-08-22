import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "./auth";
import { getSessionIdentity, type SessionIdentity } from "./auth-server";

export type StoredRoutePoint = { latitude: number; longitude: number };
export type StoredNavigationStep = { progressMeters: number; distanceMeters: number; guidance: string };
export type StoredLocation = StoredRoutePoint & { name: string; address: string };
export type StoredRouteType = "순환형" | "왕복형" | "편도형" | null;

export async function requireIdentity(request: NextRequest): Promise<SessionIdentity | NextResponse> {
  try {
    const identity = await getSessionIdentity(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    return identity ?? NextResponse.json({ error: "로그인이 필요한 기능입니다." }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "로그인 정보를 확인하지 못했습니다." }, { status: 503 });
  }
}

export function isApiError(value: SessionIdentity | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}

export function validObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

export function validPoint(value: unknown): value is StoredRoutePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<StoredRoutePoint>;
  return typeof point.latitude === "number" && Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 && typeof point.longitude === "number" && Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

export function validRoute(value: unknown, maximumPoints = 8_000): value is StoredRoutePoint[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= maximumPoints && value.every(validPoint);
}

export function validRouteType(value: unknown): value is StoredRouteType {
  return value === null || value === "순환형" || value === "왕복형" || value === "편도형";
}

export function validFinite(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function validText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximumLength;
}

export function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
