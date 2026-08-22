import { NextRequest, NextResponse } from "next/server";

type RoutePoint = { latitude: number; longitude: number };
type RequestBody = { start?: RoutePoint; target?: RoutePoint };
type KakaoWalkResponse = {
  status?: string;
  route?: {
    properties?: { totalDistance?: number; totalTime?: number };
    legs?: { steps?: { path?: { points?: number[][] } }[] }[];
  };
};

const KAKAO_WALK_URL = "https://dapi.kakao.com/v2/routing/walk";
const REQUEST_TIMEOUT_MS = 12_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 4;
const requests = new Map<string, { count: number; resetAt: number }>();

function validPoint(point: RoutePoint | undefined): point is RoutePoint {
  return Boolean(point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180);
}

function isSamePoint(start: RoutePoint, target: RoutePoint) {
  return Math.abs(start.latitude - target.latitude) < 1e-7 && Math.abs(start.longitude - target.longitude) < 1e-7;
}

function isRateLimited(request: NextRequest) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const previous = requests.get(key);
  if (!previous || previous.resetAt <= now) {
    requests.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  previous.count += 1;
  return previous.count > RATE_LIMIT_MAX_REQUESTS;
}

export async function POST(request: NextRequest) {
  if (isRateLimited(request)) return NextResponse.json({ error: "복귀 경로 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });

  try {
    const apiKey = process.env.KAKAO_REST_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "KAKAO_REST_API_KEY가 설정되지 않았습니다." }, { status: 500 });

    const body = await request.json() as RequestBody;
    if (!validPoint(body.start) || !validPoint(body.target)) return NextResponse.json({ error: "올바른 현재 위치와 복귀 지점이 필요합니다." }, { status: 400 });
    if (isSamePoint(body.start, body.target)) return NextResponse.json({ error: "복귀 지점이 현재 위치와 너무 가깝습니다." }, { status: 400 });

    const params = new URLSearchParams({
      start_x: String(body.start.longitude), start_y: String(body.start.latitude),
      end_x: String(body.target.longitude), end_y: String(body.target.latitude),
      input_coord: "WGS84", output_coord: "WGS84", route_mode: "SHORTEST",
    });
    const response = await fetch(`${KAKAO_WALK_URL}?${params}`, {
      headers: { Authorization: `KakaoAK ${apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null) as KakaoWalkResponse | null;
    if (!response.ok || !data || data.status !== "OK" || !data.route) {
      return NextResponse.json({ error: "복귀 보행 경로를 찾지 못했습니다." }, { status: response.status === 429 ? 429 : 502 });
    }

    const route: RoutePoint[] = [];
    for (const leg of data.route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        for (const point of step.path?.points ?? []) {
          const longitude = Number(point[0]);
          const latitude = Number(point[1]);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
          const previous = route.at(-1);
          if (!previous || previous.latitude !== latitude || previous.longitude !== longitude) route.push({ latitude, longitude });
        }
      }
    }
    if (route.length < 2) return NextResponse.json({ error: "복귀 경로의 좌표를 읽지 못했습니다." }, { status: 502 });

    return NextResponse.json({
      route,
      distanceMeters: data.route.properties?.totalDistance ?? null,
      durationSeconds: data.route.properties?.totalTime ?? null,
      provider: "kakao",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "복귀 경로 생성 중 오류가 발생했습니다." }, { status: 500 });
  }
}
