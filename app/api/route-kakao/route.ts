import { NextRequest, NextResponse } from "next/server";
import { validateRequiredSegmentGeometry } from "@/lib/required-segment";
import { createRouteIndex, haversineMeters, projectPointToRouteProgress } from "@/lib/navigation";

type RoutePoint = {
  latitude: number;
  longitude: number;
};

type RouteType = "순환형" | "왕복형" | "편도형";

type RequiredWaypoint = {
  id: string;
  type: "waypoint";
  location: RoutePoint;
};

type RequiredSegment = {
  id: string;
  type: "segment";
  start: RoutePoint;
  end: RoutePoint;
  route: RoutePoint[];
  distanceKm: number;
};

type RequiredItem = RequiredWaypoint | RequiredSegment;

type RoutePreferences = {
  elevation?: {
    min?: number | null;
    max?: number | null;
  };
  sceneries?: string[];
  signalPreference?: string | null;
};

type RouteRequestBody = {
  routeType: RouteType;
  start: RoutePoint;
  destination?: RoutePoint | null;
  targetDistanceKm?: number | null;
  requiredItems?: RequiredItem[];
  preferences?: RoutePreferences;
};

type RoutedPath = {
  route: RoutePoint[];
  distanceKm: number;
  durationSeconds: number | null;
  navigationSteps: NavigationStep[];
  overlapMetrics?: OverlapMetrics;
};

type NavigationStep = {
  progressMeters: number;
  distanceMeters: number;
  guidance: string;
};

type OverlapMetrics = {
  ratio: number;
  duplicatedLengthMeters: number;
  totalLengthMeters: number;
  penalty: number;
};

type BuiltRequiredPath = {
  route: RoutePoint[];
  distanceKm: number;
  durationSeconds: number | null;
  current: RoutePoint;
  navigationSteps: NavigationStep[];
};

type KakaoWalkResponse = {
  status?: string;
  route?: {
    properties?: {
      totalDistance?: number;
      totalTime?: number;
    };
    legs?: {
      steps?: {
        properties?: {
          distance?: number;
          guidance?: string;
          time?: number;
          x?: number;
          y?: number;
        };
        path?: {
          points?: number[][];
        };
      }[];
    }[];
  };
};

type KakaoPlaceDocument = {
  id?: string;
  place_name?: string;
  category_name?: string;
  x?: string;
  y?: string;
  distance?: string;
};

type KakaoKeywordResponse = {
  documents?: KakaoPlaceDocument[];
};

type SceneryPoint = RoutePoint & {
  scenery: string;
  name: string;
};

type LoopCandidateSeed = {
  p1: RoutePoint;
  p2: RoutePoint;
  anchor?: SceneryPoint;
  orientation: number;
  radiusKm: number;
  cheapScore: number;
};

type ScoredCandidate = {
  path: RoutedPath;
  totalDistanceKm: number;
  relativeDistanceError: number;
  sceneryScore: number;
  overlapMetrics: OverlapMetrics;
  totalScore: number;
};

const KAKAO_WALK_URL = "https://dapi.kakao.com/v2/routing/walk";
const KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";

/*
 * 외부 경로/지도 서비스 없이 Kakao-only로 동작한다.
 *
 * - 실제 보행 경로: Kakao Walking
 * - 경관 힌트: Kakao Local keyword search
 * - 후보 생성/점수 계산: PEROG 자체 로직
 */
/*
 * API를 호출하지 않는 cheap random candidate는 많이 만든다.
 * 실제 Kakao Walking 호출은 상위 소수 후보에만 사용한다.
 */
const RANDOM_SEED_POOL_SIZE = 32;
const SHORTLIST_SIZE = 3;
const MAX_ROUTED_CANDIDATES = 2;

const DISTANCE_TOLERANCE = 0.05;
const SECOND_ROUTE_TRIGGER = 0.07;

const OVERLAP_DISTANCE_METERS = 20;
const OVERLAP_DIRECTION_TOLERANCE_DEGREES = 25;
const OVERLAP_ADJACENT_SEGMENTS = 4;
const OVERLAP_START_IGNORE_METERS = 80;
const MAX_OVERLAP_RATIO = 0.18;
const EARLY_ACCEPT_OVERLAP_RATIO = 0.08;

const MAX_LOCAL_RADIUS_M = 20_000;
const MAX_REQUIRED_ITEMS = 8;
const MAX_REQUIRED_SEGMENT_POINTS = 1_500;
const KAKAO_REQUEST_TIMEOUT_MS = 12_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 8;

/*
 * 같은 지역/경관을 반복 생성할 때 Kakao Local API 재호출을 줄인다.
 * Next.js server process가 살아 있는 동안 유효한 memory cache다.
 */
const LOCAL_CACHE_TTL_MS = 30 * 60 * 1000;

/*
 * Kakao Local은 지형 polygon 자체를 주는 API가 아니라 장소 검색 API다.
 * 따라서 MVP에서는 장소/POI를 "경관 힌트"로 사용한다.
 */
const SCENERY_KEYWORDS: Record<string, string[]> = {
  /* 첫 keyword만 먼저 호출하고, 결과가 없을 때만 두 번째 keyword를 fallback으로 호출한다. */
  수변: ["수변공원", "하천"],
  "공원·녹지": ["공원", "도시숲"],
  도심: ["광장", "쇼핑몰"],
  자연: ["둘레길", "산"],
};

type LocalCacheEntry = {
  expiresAt: number;
  points: SceneryPoint[];
};

const localSearchCache = new Map<string, LocalCacheEntry>();
const requestRateLimits = new Map<string, { count: number; resetAt: number }>();

/*
 * Best-effort in-process limiter only. Vercel serverless instances do not share
 * this memory, so production-wide enforcement requires a shared store (e.g. Redis).
 */

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function getClientKey(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(request: NextRequest) {
  const key = getClientKey(request);
  const now = Date.now();
  const entry = requestRateLimits.get(key);
  if (!entry || entry.resetAt <= now) {
    requestRateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function validPoint(point?: RoutePoint | null) {
  return Boolean(
    point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180
  );
}

function validRequiredItems(items: unknown): items is RequiredItem[] {
  if (!Array.isArray(items) || items.length > MAX_REQUIRED_ITEMS) return false;
  return items.every((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<RequiredItem>;
    if (candidate.type === "waypoint") return validPoint(candidate.location);
    if (candidate.type !== "segment") return false;
    return (
      validPoint(candidate.start) &&
      validPoint(candidate.end) &&
      Array.isArray(candidate.route) &&
      candidate.route.length >= 2 &&
      candidate.route.length <= MAX_REQUIRED_SEGMENT_POINTS &&
      candidate.route.every(validPoint) &&
      typeof candidate.distanceKm === "number" &&
      Number.isFinite(candidate.distanceKm) &&
      candidate.distanceKm > 0
    );
  });
}

function samePoint(a: RoutePoint, b: RoutePoint) {
  const tolerance = 1e-7;

  return (
    Math.abs(a.latitude - b.latitude) < tolerance && Math.abs(a.longitude - b.longitude) < tolerance
  );
}

function validateRequiredSegmentRoute(item: RequiredSegment) {
  const result = validateRequiredSegmentGeometry(item);
  if (!result.valid) throw new ApiError(result.message, 400);
  return result.distanceKm;
}

function appendRoute(target: RoutePoint[], additional: RoutePoint[]) {
  if (additional.length === 0) {
    return;
  }

  if (target.length === 0) {
    target.push(...additional);
    return;
  }

  const last = target[target.length - 1];
  const first = additional[0];

  if (last && first && samePoint(last, first)) {
    target.push(...additional.slice(1));
  } else {
    target.push(...additional);
  }
}

function addDuration(current: number | null, additional: number | null) {
  if (current === null || additional === null) {
    return null;
  }

  return current + additional;
}

function offsetNavigationSteps(steps: NavigationStep[], offsetMeters: number) {
  return steps.map((step) => ({ ...step, progressMeters: step.progressMeters + offsetMeters }));
}

function routeGeometryMeters(route: RoutePoint[]) {
  let meters = 0;
  for (let index = 1; index < route.length; index += 1) meters += haversineMeters(route[index - 1], route[index]);
  return meters;
}

function parseKakaoRoute(data: KakaoWalkResponse): RoutedPath {
  if (data.status !== "OK" || !data.route) {
    throw new Error(`카카오 도보 경로를 찾지 못했습니다. status=${data.status ?? "UNKNOWN"}`);
  }

  const route: RoutePoint[] = [];
  const rawNavigationSteps: Array<NavigationStep & { anchor?: RoutePoint }> = [];
  let fallbackProgressMeters = 0;

  for (const leg of data.route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const stepDistance = step.properties?.distance;
      const guidance = step.properties?.guidance;
      const firstPathPoint = step.path?.points?.[0];
      const anchorLongitude = Number(step.properties?.x ?? firstPathPoint?.[0]);
      const anchorLatitude = Number(step.properties?.y ?? firstPathPoint?.[1]);
      const anchor = Number.isFinite(anchorLatitude) && Number.isFinite(anchorLongitude) ? { latitude: anchorLatitude, longitude: anchorLongitude } : undefined;
      if (typeof stepDistance === "number" && Number.isFinite(stepDistance) && stepDistance > 0 && typeof guidance === "string" && guidance.trim()) {
        rawNavigationSteps.push({ progressMeters: fallbackProgressMeters, distanceMeters: stepDistance, guidance: guidance.trim(), anchor });
      }
      if (typeof stepDistance === "number" && Number.isFinite(stepDistance) && stepDistance > 0) fallbackProgressMeters += stepDistance;
      for (const point of step.path?.points ?? []) {
        if (!Array.isArray(point) || point.length < 2) {
          continue;
        }

        const longitude = Number(point[0]);
        const latitude = Number(point[1]);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          continue;
        }

        const previous = route[route.length - 1];

        if (
          previous &&
          Math.abs(previous.latitude - latitude) < 1e-10 &&
          Math.abs(previous.longitude - longitude) < 1e-10
        ) {
          continue;
        }

        route.push({
          latitude,
          longitude,
        });
      }
    }
  }

  const distanceMeters = data.route.properties?.totalDistance;

  if (route.length < 2 || typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters)) {
    throw new Error("카카오 보행 경로를 계산하지 못했습니다.");
  }

  const totalTime = data.route.properties?.totalTime;
  const routeIndex = createRouteIndex(route);
  const navigationSteps = rawNavigationSteps.flatMap(({ anchor, ...step }) => {
    if (!anchor) return [step];
    const projection = projectPointToRouteProgress(routeIndex, anchor);
    if (!projection || projection.distanceMeters > 80) return [step];
    return [{ ...step, progressMeters: projection.progressMeters }];
  }).sort((a, b) => a.progressMeters - b.progressMeters);

  return {
    route,
    distanceKm: distanceMeters / 1000,
    durationSeconds: typeof totalTime === "number" && Number.isFinite(totalTime) ? totalTime : null,
    navigationSteps,
  };
}

async function requestKakaoChunk(points: RoutePoint[], apiKey: string): Promise<RoutedPath> {
  if (points.length < 2) {
    throw new Error("경로 계산을 위한 위치가 부족합니다.");
  }

  if (points.length > 7) {
    throw new Error("내부 오류: 카카오 한 번의 요청에는 최대 7개의 위치만 사용할 수 있습니다.");
  }

  const start = points[0];
  const destination = points[points.length - 1];
  const waypoints = points.slice(1, -1);

  if (samePoint(start, destination)) {
    throw new Error("내부 오류: 동일한 출발점/도착점 요청이 카카오에 전달되었습니다.");
  }

  const params = new URLSearchParams({
    start_x: String(start.longitude),
    start_y: String(start.latitude),
    end_x: String(destination.longitude),
    end_y: String(destination.latitude),
    input_coord: "WGS84",
    output_coord: "WGS84",
    route_mode: "SHORTEST",
  });

  if (waypoints.length > 0) {
    params.set("via_x", waypoints.map((point) => point.longitude).join(","));

    params.set("via_y", waypoints.map((point) => point.latitude).join(","));
  }

  const response = await fetch(`${KAKAO_WALK_URL}?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `KakaoAK ${apiKey}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(KAKAO_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();

  let data: KakaoWalkResponse;

  try {
    data = JSON.parse(text) as KakaoWalkResponse;
  } catch {
    console.error("Kakao walking response parse failed", { responseLength: text.length });
    throw new Error("카카오 API 응답을 해석하지 못했습니다.");
  }

  if (!response.ok) {
    console.error("Kakao walking HTTP error", { status: response.status, category: data.status ?? "unknown" });
    throw new ApiError(`카카오 도보 API 오류: HTTP ${response.status}`, response.status === 429 ? 429 : 502);
  }

  return parseKakaoRoute(data);
}

async function requestPedestrianRoute(points: RoutePoint[]): Promise<RoutedPath> {
  if (points.length < 2) {
    throw new Error("경로 계산을 위한 위치가 부족합니다.");
  }

  const apiKey = process.env.KAKAO_REST_API_KEY;

  if (!apiKey) {
    throw new Error("KAKAO_REST_API_KEY가 설정되지 않았습니다.");
  }

  const normalized: RoutePoint[] = [];

  for (const point of points) {
    const previous = normalized[normalized.length - 1];

    if (!previous || !samePoint(previous, point)) {
      normalized.push(point);
    }
  }

  if (normalized.length < 2) {
    throw new Error("서로 다른 두 개 이상의 위치가 필요합니다.");
  }

  /*
   * Kakao Walking은 start === end인 요청에서 SAME_POINT를 반환할 수 있다.
   * A -> ... -> A는 마지막 중간점에서 두 요청으로 나눈다.
   */
  if (normalized.length >= 3 && samePoint(normalized[0], normalized[normalized.length - 1])) {
    const pivotIndex = normalized.length - 2;
    const firstPart = normalized.slice(0, pivotIndex + 1);
    const secondPart = normalized.slice(pivotIndex);

    const [first, second] = await Promise.all([
      requestPedestrianRoute(firstPart),
      requestPedestrianRoute(secondPart),
    ]);

    const route = [...first.route];
    appendRoute(route, second.route);

    return {
      route,
      distanceKm: first.distanceKm + second.distanceKm,
      durationSeconds: addDuration(first.durationSeconds, second.durationSeconds),
      navigationSteps: [...first.navigationSteps, ...offsetNavigationSteps(second.navigationSteps, routeGeometryMeters(first.route))],
    };
  }

  /*
   * Kakao Walking은 start + via 최대 5 + end = 총 7 point.
   */
  if (normalized.length > 7) {
    const completeRoute: RoutePoint[] = [];
    let totalDistanceKm = 0;
    let totalDurationSeconds: number | null = 0;
    const navigationSteps: NavigationStep[] = [];

    let index = 0;

    while (index < normalized.length - 1) {
      const endIndex = Math.min(index + 6, normalized.length - 1);
      const chunk = normalized.slice(index, endIndex + 1);
      const routed = await requestKakaoChunk(chunk, apiKey);

      const navigationOffsetMeters = routeGeometryMeters(completeRoute);
      appendRoute(completeRoute, routed.route);
      totalDistanceKm += routed.distanceKm;
      totalDurationSeconds = addDuration(totalDurationSeconds, routed.durationSeconds);
      navigationSteps.push(...offsetNavigationSteps(routed.navigationSteps, navigationOffsetMeters));

      index = endIndex;
    }

    return {
      route: completeRoute,
      distanceKm: totalDistanceKm,
      durationSeconds: totalDurationSeconds,
      navigationSteps,
    };
  }

  return requestKakaoChunk(normalized, apiKey);
}

async function buildRequiredPath(
  start: RoutePoint,
  requiredItems: RequiredItem[]
): Promise<BuiltRequiredPath> {
  const completeRoute: RoutePoint[] = [];
  let totalDistanceKm = 0;
  let totalDurationSeconds: number | null = 0;
  const navigationSteps: NavigationStep[] = [];
  let current = start;
  let pendingPoints: RoutePoint[] = [current];

  const flushPending = async () => {
    if (pendingPoints.length < 2) {
      return;
    }

    const routed = await requestPedestrianRoute(pendingPoints);

    const navigationOffsetMeters = routeGeometryMeters(completeRoute);
    appendRoute(completeRoute, routed.route);
    totalDistanceKm += routed.distanceKm;
    totalDurationSeconds = addDuration(totalDurationSeconds, routed.durationSeconds);
    navigationSteps.push(...offsetNavigationSteps(routed.navigationSteps, navigationOffsetMeters));

    current = pendingPoints[pendingPoints.length - 1];
    pendingPoints = [current];
  };

  for (const item of requiredItems) {
    if (item.type === "waypoint") {
      if (!validPoint(item.location)) {
        throw new Error("올바르지 않은 필수 경유지가 있습니다.");
      }

      pendingPoints.push(item.location);
      continue;
    }

    if (
      !validPoint(item.start) ||
      !validPoint(item.end) ||
      !Array.isArray(item.route) ||
      item.route.length < 2 ||
      typeof item.distanceKm !== "number" ||
      !Number.isFinite(item.distanceKm)
    ) {
      throw new Error("올바르지 않은 필수 구간이 있습니다.");
    }

    pendingPoints.push(item.start);
    await flushPending();

    /* 사용자가 선택한 필수 구간은 그대로 삽입한다. */
    appendRoute(completeRoute, item.route);
    totalDistanceKm += validateRequiredSegmentRoute(item);
    totalDurationSeconds = null;
    current = item.end;
    pendingPoints = [current];
  }

  await flushPending();

  if (completeRoute.length === 0) {
    completeRoute.push(start);
  }

  return {
    route: completeRoute,
    distanceKm: totalDistanceKm,
    durationSeconds: totalDurationSeconds,
    current,
    navigationSteps,
  };
}

function destinationPoint(
  latitude: number,
  longitude: number,
  distanceKm: number,
  bearingDegrees: number
): RoutePoint {
  const earthRadiusKm = 6371;
  const angularDistance = distanceKm / earthRadiusKm;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    latitude: (lat2 * 180) / Math.PI,
    longitude: (lon2 * 180) / Math.PI,
  };
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function haversineKm(a: RoutePoint, b: RoutePoint) {
  const earthRadiusKm = 6371;
  const toRad = (degree: number) => (degree * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);

  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

type LocalPoint = { x: number; y: number };

type RouteSegment = {
  index: number;
  from: LocalPoint;
  to: LocalPoint;
  midpoint: LocalPoint;
  lengthMeters: number;
  bearing: number;
};

function toLocalPoint(point: RoutePoint, origin: RoutePoint): LocalPoint {
  const latitudeRadians = origin.latitude * (Math.PI / 180);

  return {
    x: (point.longitude - origin.longitude) * 111_320 * Math.cos(latitudeRadians),
    y: (point.latitude - origin.latitude) * 111_320,
  };
}

function localDistance(a: LocalPoint, b: LocalPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointToSegmentDistance(point: LocalPoint, from: LocalPoint, to: LocalPoint) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return localDistance(point, from);
  }

  const projection = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)
  );

  return localDistance(point, { x: from.x + projection * dx, y: from.y + projection * dy });
}

function segmentBearing(from: LocalPoint, to: LocalPoint) {
  return (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
}

function overlapGridKey(point: LocalPoint) {
  return `${Math.floor(point.x / OVERLAP_DISTANCE_METERS)}:${Math.floor(
    point.y / OVERLAP_DISTANCE_METERS
  )}`;
}

function calculateOverlapPenalty(ratio: number) {
  if (ratio <= 0.05) return 0;
  if (ratio <= 0.12) return (ratio - 0.05) * 14;
  if (ratio <= 0.2) return 0.98 + (ratio - 0.12) * 35;
  return 3.78 + (ratio - 0.2) * 70;
}

function calculateRouteOverlap(route: RoutePoint[], start: RoutePoint): OverlapMetrics {
  const segments: RouteSegment[] = [];
  const grid = new Map<string, RouteSegment[]>();
  let totalLengthMeters = 0;
  let duplicatedLengthMeters = 0;

  for (let index = 1; index < route.length; index += 1) {
    const from = toLocalPoint(route[index - 1], start);
    const to = toLocalPoint(route[index], start);
    const lengthMeters = localDistance(from, to);

    if (lengthMeters < 1) continue;

    totalLengthMeters += lengthMeters;
    const segment: RouteSegment = {
      index: segments.length,
      from,
      to,
      midpoint: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      lengthMeters,
      bearing: segmentBearing(from, to),
    };
    const midpointDistanceToStart = localDistance(segment.midpoint, { x: 0, y: 0 });
    let overlaps = false;

    if (midpointDistanceToStart > OVERLAP_START_IGNORE_METERS) {
      const gridX = Math.floor(segment.midpoint.x / OVERLAP_DISTANCE_METERS);
      const gridY = Math.floor(segment.midpoint.y / OVERLAP_DISTANCE_METERS);
      const candidates = new Set<RouteSegment>();

      for (let x = gridX - 1; x <= gridX + 1; x += 1) {
        for (let y = gridY - 1; y <= gridY + 1; y += 1) {
          for (const candidate of grid.get(`${x}:${y}`) ?? []) candidates.add(candidate);
        }
      }

      for (const candidate of candidates) {
        if (segment.index - candidate.index < OVERLAP_ADJACENT_SEGMENTS) continue;

        const directionDifference = angleDifferenceDegrees(segment.bearing, candidate.bearing);
        const directionCompatible =
          directionDifference < OVERLAP_DIRECTION_TOLERANCE_DEGREES ||
          Math.abs(directionDifference - 180) < OVERLAP_DIRECTION_TOLERANCE_DEGREES;

        if (!directionCompatible) continue;

        const distance = Math.min(
          pointToSegmentDistance(segment.midpoint, candidate.from, candidate.to),
          pointToSegmentDistance(candidate.midpoint, segment.from, segment.to)
        );

        if (distance <= OVERLAP_DISTANCE_METERS) {
          overlaps = true;
          break;
        }
      }
    }

    if (overlaps) duplicatedLengthMeters += segment.lengthMeters;
    segments.push(segment);
    const key = overlapGridKey(segment.midpoint);
    const bucket = grid.get(key) ?? [];
    bucket.push(segment);
    grid.set(key, bucket);
  }

  const ratio = totalLengthMeters > 0 ? duplicatedLengthMeters / totalLengthMeters : 0;

  return {
    ratio,
    duplicatedLengthMeters,
    totalLengthMeters,
    penalty: calculateOverlapPenalty(ratio),
  };
}

function sampleRoute(route: RoutePoint[], maxSamples = 40) {
  if (route.length <= maxSamples) {
    return [...route];
  }

  const result: RoutePoint[] = [];

  for (let i = 0; i < maxSamples; i++) {
    const t = i / (maxSamples - 1);
    const index = Math.round(t * (route.length - 1));
    const point = route[index];
    const previous = result[result.length - 1];

    if (!previous || !samePoint(previous, point)) {
      result.push(point);
    }
  }

  return result;
}

function localCacheKey(center: RoutePoint, radiusM: number, scenery: string, keyword: string) {
  const lat = center.latitude.toFixed(3);
  const lon = center.longitude.toFixed(3);
  const roundedRadius = Math.round(radiusM / 500) * 500;

  return `${lat}:${lon}:${roundedRadius}:${scenery}:${keyword}`;
}

async function searchKakaoKeyword(
  center: RoutePoint,
  radiusM: number,
  scenery: string,
  keyword: string,
  apiKey: string
): Promise<SceneryPoint[]> {
  const key = localCacheKey(center, radiusM, scenery, keyword);
  const cached = localSearchCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.points;
  }

  const params = new URLSearchParams({
    query: keyword,
    x: String(center.longitude),
    y: String(center.latitude),
    radius: String(Math.min(MAX_LOCAL_RADIUS_M, Math.max(500, Math.round(radiusM)))),
    size: "15",
    sort: "distance",
  });

  try {
    const response = await fetch(`${KAKAO_KEYWORD_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `KakaoAK ${apiKey}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(KAKAO_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.log("Kakao Local HTTP error:", response.status, scenery, keyword);
      return [];
    }

    const data = (await response.json()) as KakaoKeywordResponse;

    const points = (data.documents ?? [])
      .map((document): SceneryPoint | null => {
        const longitude = Number(document.x);
        const latitude = Number(document.y);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        return {
          latitude,
          longitude,
          scenery,
          name: document.place_name ?? keyword,
        };
      })
      .filter((point): point is SceneryPoint => point !== null);

    localSearchCache.set(key, {
      expiresAt: Date.now() + LOCAL_CACHE_TTL_MS,
      points,
    });

    return points;
  } catch (error) {
    console.log("Kakao Local search failed:", scenery, keyword, error);
    return [];
  }
}

async function loadSceneryPoints(
  center: RoutePoint,
  targetDistanceKm: number,
  sceneries: string[]
) {
  if (sceneries.length === 0) {
    return [];
  }

  const apiKey = process.env.KAKAO_REST_API_KEY;

  if (!apiKey) {
    throw new Error("KAKAO_REST_API_KEY가 설정되지 않았습니다.");
  }

  const radiusM = Math.min(MAX_LOCAL_RADIUS_M, Math.max(2_000, targetDistanceKm * 700));

  /*
   * API 절약 전략:
   * - 선택된 scenery마다 primary keyword 1회만 먼저 요청.
   * - primary가 0건일 때만 fallback keyword 1회.
   *
   * 예전처럼 scenery 하나당 여러 keyword를 모두 호출하지 않는다.
   */
  const jobs = sceneries.map(async (scenery) => {
    const keywords = SCENERY_KEYWORDS[scenery] ?? [];

    if (keywords.length === 0) {
      return [] as SceneryPoint[];
    }

    const primary = await searchKakaoKeyword(center, radiusM, scenery, keywords[0], apiKey);

    if (primary.length > 0 || keywords.length < 2) {
      return primary;
    }

    return searchKakaoKeyword(center, radiusM, scenery, keywords[1], apiKey);
  });

  const groups = await Promise.all(jobs);
  const unique = new Map<string, SceneryPoint>();

  for (const group of groups) {
    for (const point of group) {
      const key = `${point.scenery}:${point.latitude.toFixed(6)}:${point.longitude.toFixed(6)}`;
      unique.set(key, point);
    }
  }

  return [...unique.values()];
}

function sceneryScoreForRoute(
  route: RoutePoint[],
  sceneryPoints: SceneryPoint[],
  selectedSceneries: string[]
) {
  if (selectedSceneries.length === 0 || sceneryPoints.length === 0) {
    return 0;
  }

  const samples = sampleRoute(route, 40);
  const perSceneryScores: number[] = [];

  for (const scenery of selectedSceneries) {
    const points = sceneryPoints.filter((point) => point.scenery === scenery);

    if (points.length === 0) {
      perSceneryScores.push(0);
      continue;
    }

    let sum = 0;

    for (const sample of samples) {
      let nearestKm = Infinity;

      for (const point of points) {
        const distanceKm = haversineKm(sample, point);

        if (distanceKm < nearestKm) {
          nearestKm = distanceKm;
        }
      }

      /*
       * POI까지 0m -> 1.0
       * 약 250m -> 0.5
       * 약 750m -> 0.25
       * 점 형태의 Kakao Local 데이터를 완만하게 반영한다.
       */
      sum += 1 / (1 + nearestKm / 0.25);
    }

    perSceneryScores.push(sum / Math.max(1, samples.length));
  }

  return (
    perSceneryScores.reduce((sum, score) => sum + score, 0) / Math.max(1, perSceneryScores.length)
  );
}

function candidateScore(
  totalDistanceKm: number,
  targetDistanceKm: number,
  sceneryScore: number,
  hasSceneryPreference: boolean,
  overlapPenalty = 0
) {
  const relativeDistanceError = Math.abs(totalDistanceKm - targetDistanceKm) / targetDistanceKm;

  /*
   * 거리 정확도가 최우선.
   * 경관을 선택했을 때만 최대 +2.5 보너스를 준다.
   */
  const distanceScore = -12 * relativeDistanceError;
  const sceneryBonus = hasSceneryPreference ? 2.5 * sceneryScore : 0;

  return distanceScore + sceneryBonus - overlapPenalty;
}

function angleDifferenceDegrees(a: number, b: number) {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

function cheapSceneryScoreForSeed(p1: RoutePoint, p2: RoutePoint, sceneryPoints: SceneryPoint[]) {
  if (sceneryPoints.length === 0) {
    return 0;
  }

  let nearestKm = Infinity;

  for (const point of sceneryPoints) {
    nearestKm = Math.min(nearestKm, haversineKm(p1, point), haversineKm(p2, point));
  }

  return 1 / (1 + nearestKm / 0.35);
}

function buildLoopSeeds(
  center: RoutePoint,
  finalStart: RoutePoint,
  desiredDistanceKm: number,
  sceneryPoints: SceneryPoint[]
): LoopCandidateSeed[] {
  const pool: LoopCandidateSeed[] = [];

  /*
   * API 호출 없이 RANDOM_SEED_POOL_SIZE개의 후보 geometry를 만든다.
   * 같은 출발점/거리라도 매번 방향, 반경, 각도, 회전방향이 달라진다.
   */
  const baseRadiusKm = Math.max(0.25, desiredDistanceKm / 3.8);

  const usableAnchors = sceneryPoints
    .map((point) => ({
      point,
      distanceKm: haversineKm(center, point),
    }))
    .filter(
      (item) =>
        item.distanceKm >= Math.max(0.2, baseRadiusKm * 0.3) &&
        item.distanceKm <= baseRadiusKm * 1.95
    );

  for (let i = 0; i < RANDOM_SEED_POOL_SIZE; i++) {
    const orientation = randomBetween(0, 360);
    const radiusScale = randomBetween(0.72, 1.3);
    const radiusKm = baseRadiusKm * radiusScale;
    const angleGap = randomBetween(70, 145);
    const direction = Math.random() < 0.5 ? -1 : 1;

    let p1 = destinationPoint(center.latitude, center.longitude, radiusKm, orientation);

    let anchor: SceneryPoint | undefined;

    /*
     * 경관 preference가 있어도 약 45% 후보만 POI 쪽으로 유도한다.
     * 나머지는 순수 random으로 남겨 결과 다양성을 유지한다.
     */
    if (usableAnchors.length > 0 && Math.random() < 0.45) {
      const selected = usableAnchors[Math.floor(Math.random() * usableAnchors.length)];

      p1 = selected.point;
      anchor = selected.point;
    }

    const p2RadiusKm = radiusKm * randomBetween(0.82, 1.18);
    const p2 = destinationPoint(
      center.latitude,
      center.longitude,
      p2RadiusKm,
      orientation + direction * angleGap
    );

    /* 실제 Kakao 요청 전에는 직선 거리만으로 cheap filtering. */
    const estimatedDistanceKm =
      haversineKm(center, p1) + haversineKm(p1, p2) + haversineKm(p2, finalStart);

    const estimatedError =
      Math.abs(estimatedDistanceKm - desiredDistanceKm) / Math.max(0.1, desiredDistanceKm);

    const sceneryCheapScore = cheapSceneryScoreForSeed(p1, p2, sceneryPoints);

    const randomJitter = randomBetween(-0.12, 0.12);

    const cheapScore = -8 * estimatedError + 1.4 * sceneryCheapScore + randomJitter;

    pool.push({
      p1,
      p2,
      anchor,
      orientation,
      radiusKm,
      cheapScore,
    });
  }

  pool.sort((a, b) => b.cheapScore - a.cheapScore);

  /* 비슷한 방향만 뽑히지 않게 최소 45도 차이로 shortlist 구성. */
  const shortlist: LoopCandidateSeed[] = [];

  for (const candidate of pool) {
    const sufficientlyDifferent = shortlist.every(
      (selected) => angleDifferenceDegrees(candidate.orientation, selected.orientation) >= 45
    );

    if (sufficientlyDifferent || shortlist.length === 0) {
      shortlist.push(candidate);
    }

    if (shortlist.length >= SHORTLIST_SIZE) {
      break;
    }
  }

  for (const candidate of pool) {
    if (shortlist.length >= SHORTLIST_SIZE) {
      break;
    }

    if (!shortlist.includes(candidate)) {
      shortlist.push(candidate);
    }
  }

  return shortlist;
}

async function generateOneWay(
  start: RoutePoint,
  destination: RoutePoint,
  requiredItems: RequiredItem[]
): Promise<RoutedPath> {
  const requiredPath = await buildRequiredPath(start, requiredItems);

  if (requiredItems.length === 0) {
    return requestPedestrianRoute([start, destination]);
  }

  const finalLeg = await requestPedestrianRoute([requiredPath.current, destination]);

  const completeRoute = [...requiredPath.route];
  appendRoute(completeRoute, finalLeg.route);

  return {
    route: completeRoute,
    distanceKm: requiredPath.distanceKm + finalLeg.distanceKm,
    durationSeconds: addDuration(requiredPath.durationSeconds, finalLeg.durationSeconds),
    navigationSteps: [...requiredPath.navigationSteps, ...offsetNavigationSteps(finalLeg.navigationSteps, routeGeometryMeters(requiredPath.route))],
  };
}

async function generateOutAndBack(
  start: RoutePoint,
  destination: RoutePoint,
  requiredItems: RequiredItem[]
): Promise<RoutedPath> {
  const outbound = await generateOneWay(start, destination, requiredItems);
  const returnRoute = outbound.route.slice(0, -1).reverse();

  return {
    route: [...outbound.route, ...returnRoute],
    distanceKm: outbound.distanceKm * 2,
    durationSeconds: outbound.durationSeconds === null ? null : outbound.durationSeconds * 2,
    navigationSteps: outbound.navigationSteps,
  };
}

async function generateLoop(
  start: RoutePoint,
  targetDistanceKm: number,
  requiredItems: RequiredItem[],
  preferences: RoutePreferences
): Promise<RoutedPath> {
  const startedAt = Date.now();

  const requiredPath =
    requiredItems.length > 0
      ? await buildRequiredPath(start, requiredItems)
      : {
          route: [start],
          distanceKm: 0,
          durationSeconds: 0,
          current: start,
          navigationSteps: [],
        };

  let directHome: RoutedPath | null = null;

  if (requiredItems.length > 0) {
    directHome = await requestPedestrianRoute([requiredPath.current, start]);

    const minimumDistance = requiredPath.distanceKm + directHome.distanceKm;

    if (minimumDistance > targetDistanceKm * (1 + DISTANCE_TOLERANCE)) {
      throw new Error(
        `필수 경유지/구간을 모두 포함하면 최소 약 ${minimumDistance.toFixed(
          2
        )} km가 필요합니다. 목표 거리 ${targetDistanceKm.toFixed(2)} km를 늘려주세요.`
      );
    }

    if (Math.abs(minimumDistance - targetDistanceKm) / targetDistanceKm <= DISTANCE_TOLERANCE) {
      const completeRoute = [...requiredPath.route];
      appendRoute(completeRoute, directHome.route);
      const overlapMetrics = calculateRouteOverlap(completeRoute, start);

      return {
        route: completeRoute,
        distanceKm: minimumDistance,
        durationSeconds: addDuration(requiredPath.durationSeconds, directHome.durationSeconds),
        navigationSteps: [...requiredPath.navigationSteps, ...offsetNavigationSteps(directHome.navigationSteps, routeGeometryMeters(requiredPath.route))],
        overlapMetrics,
      };
    }
  }

  const selectedSceneries = (preferences.sceneries ?? []).filter(
    (scenery) => SCENERY_KEYWORDS[scenery]
  );

  const sceneryStartedAt = Date.now();
  const sceneryPoints = await loadSceneryPoints(start, targetDistanceKm, selectedSceneries);

  console.log("PEROG Kakao Local scenery:", {
    selectedSceneries,
    points: sceneryPoints.length,
    ms: Date.now() - sceneryStartedAt,
  });

  const desiredTailDistanceKm = Math.max(0.8, targetDistanceKm - requiredPath.distanceKm);

  /* 32개 random 후보를 API 없이 생성하고 상위 3개만 남긴다. */
  const seeds = buildLoopSeeds(requiredPath.current, start, desiredTailDistanceKm, sceneryPoints);

  const scored: ScoredCandidate[] = [];
  let walkingCandidatesTried = 0;
  const routingStartedAt = Date.now();

  /*
   * API 절약:
   * - 첫 shortlist 후보만 먼저 실제 Kakao routing.
   * - 경관 조건이 없고 거리 오차가 7% 이내면 즉시 종료.
   * - 그렇지 않을 때만 두 번째 후보까지 실제 routing.
   *
   * loop candidate 하나는 SAME_POINT 회피 때문에 내부 Kakao 요청 2회다.
   * 따라서 보통 2회, 필요할 때 최대 4회 수준으로 제한한다.
   */
  for (const seed of seeds) {
    if (walkingCandidatesTried >= MAX_ROUTED_CANDIDATES) {
      break;
    }

    let tail: RoutedPath;

    try {
      walkingCandidatesTried += 1;

      tail = await requestPedestrianRoute([requiredPath.current, seed.p1, seed.p2, start]);
    } catch (error) {
      console.log("Kakao loop candidate failed:", error);
      continue;
    }

    const completeRoute = [...requiredPath.route];
    appendRoute(completeRoute, tail.route);

    const totalDistanceKm = requiredPath.distanceKm + tail.distanceKm;
    const relativeDistanceError = Math.abs(totalDistanceKm - targetDistanceKm) / targetDistanceKm;
    const sceneryScore = sceneryScoreForRoute(completeRoute, sceneryPoints, selectedSceneries);
    const overlapMetrics = calculateRouteOverlap(completeRoute, start);
    const totalScore = candidateScore(
      totalDistanceKm,
      targetDistanceKm,
      sceneryScore,
      selectedSceneries.length > 0,
      overlapMetrics.penalty
    );

    console.log(`PEROG loop candidate ${walkingCandidatesTried}:`, {
      distanceKm: Number(totalDistanceKm.toFixed(2)),
      distanceErrorPercent: Number((relativeDistanceError * 100).toFixed(1)),
      overlapPercent: Number((overlapMetrics.ratio * 100).toFixed(1)),
      overlapPenalty: Number(overlapMetrics.penalty.toFixed(3)),
      finalScore: Number(totalScore.toFixed(3)),
    });

    scored.push({
      path: {
        route: completeRoute,
        distanceKm: totalDistanceKm,
        durationSeconds: addDuration(requiredPath.durationSeconds, tail.durationSeconds),
        navigationSteps: [...requiredPath.navigationSteps, ...offsetNavigationSteps(tail.navigationSteps, routeGeometryMeters(requiredPath.route))],
        overlapMetrics,
      },
      totalDistanceKm,
      relativeDistanceError,
      sceneryScore,
      overlapMetrics,
      totalScore,
    });

    if (
      selectedSceneries.length === 0 &&
      relativeDistanceError <= SECOND_ROUTE_TRIGGER &&
      overlapMetrics.ratio <= EARLY_ACCEPT_OVERLAP_RATIO
    ) {
      break;
    }
  }

  console.log("PEROG Kakao candidate routing:", {
    randomPool: RANDOM_SEED_POOL_SIZE,
    shortlist: seeds.length,
    routedCandidates: walkingCandidatesTried,
    estimatedWalkingApiCalls: walkingCandidatesTried * 2,
    ms: Date.now() - routingStartedAt,
  });

  if (scored.length === 0) {
    if (directHome) {
      const completeRoute = [...requiredPath.route];
      appendRoute(completeRoute, directHome.route);
      const overlapMetrics = calculateRouteOverlap(completeRoute, start);

      return {
        route: completeRoute,
        distanceKm: requiredPath.distanceKm + directHome.distanceKm,
        durationSeconds: addDuration(requiredPath.durationSeconds, directHome.durationSeconds),
        navigationSteps: [...requiredPath.navigationSteps, ...offsetNavigationSteps(directHome.navigationSteps, routeGeometryMeters(requiredPath.route))],
        overlapMetrics,
      };
    }

    throw new Error("조건에 맞는 카카오 순환형 보행 경로를 찾지 못했습니다.");
  }

  const acceptableOverlapCandidates = scored.filter(
    (candidate) => candidate.overlapMetrics.ratio <= MAX_OVERLAP_RATIO
  );
  const selectionPool = [...(acceptableOverlapCandidates.length > 0 ? acceptableOverlapCandidates : scored)];

  if (acceptableOverlapCandidates.length === 0) {
    selectionPool.sort((a, b) => a.overlapMetrics.ratio - b.overlapMetrics.ratio);
  } else {
    selectionPool.sort((a, b) => {
      const scoreDifference = b.totalScore - a.totalScore;

      if (Math.abs(scoreDifference) > 1e-9) {
        return scoreDifference;
      }

      return a.relativeDistanceError - b.relativeDistanceError;
    });
  }

  const best = selectionPool[0];

  console.log("PEROG Kakao-only selected:", {
    distanceKm: best.totalDistanceKm,
    targetDistanceKm,
    distanceErrorPercent: best.relativeDistanceError * 100,
    sceneryScore: best.sceneryScore,
    overlapRatio: best.overlapMetrics.ratio,
    overlapPenalty: best.overlapMetrics.penalty,
    overlapFallback: acceptableOverlapCandidates.length === 0,
    totalScore: best.totalScore,
    randomPool: RANDOM_SEED_POOL_SIZE,
    routedCandidates: walkingCandidatesTried,
    totalMs: Date.now() - startedAt,
  });

  return best.path;
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();

  try {
    if (isRateLimited(request)) {
      return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });
    }

    let body: RouteRequestBody;
    try {
      body = (await request.json()) as RouteRequestBody;
    } catch {
      return NextResponse.json({ error: "JSON 요청 본문이 필요합니다." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "올바른 요청 본문이 필요합니다." }, { status: 400 });
    }

    const {
      routeType,
      start,
      destination,
      targetDistanceKm,
      requiredItems,
      preferences,
    } = body;

    if (!validRequiredItems(requiredItems ?? [])) {
      return NextResponse.json({ error: `필수 조건은 최대 ${MAX_REQUIRED_ITEMS}개까지, 올바른 좌표로 입력해주세요.` }, { status: 400 });
    }
    const safeRequiredItems = requiredItems ?? [];
    const safePreferences: RoutePreferences = preferences && typeof preferences === "object" ? preferences : {};

    if (!validPoint(start)) {
      return NextResponse.json(
        {
          error: "올바른 A 위치가 필요합니다.",
        },
        {
          status: 400,
        }
      );
    }

    if (routeType !== "순환형" && routeType !== "왕복형" && routeType !== "편도형") {
      return NextResponse.json(
        {
          error: "올바른 경로 형태가 필요합니다.",
        },
        {
          status: 400,
        }
      );
    }

    if (routeType === "순환형") {
      if (
        typeof targetDistanceKm !== "number" ||
        !Number.isFinite(targetDistanceKm) ||
        targetDistanceKm < 1 ||
        targetDistanceKm > 50
      ) {
        return NextResponse.json(
          {
            error: "순환형 목표 거리는 1~50 km 사이여야 합니다.",
          },
          {
            status: 400,
          }
        );
      }
    }

    if ((routeType === "왕복형" || routeType === "편도형") && !validPoint(destination)) {
      return NextResponse.json(
        {
          error: "올바른 B 위치가 필요합니다.",
        },
        {
          status: 400,
        }
      );
    }

    for (const item of safeRequiredItems) {
      if (item.type === "waypoint") {
        if (!validPoint(item.location)) {
          return NextResponse.json(
            {
              error: "올바르지 않은 필수 경유지가 있습니다.",
            },
            {
              status: 400,
            }
          );
        }

        continue;
      }

      if (item.type === "segment") {
        if (
          !validPoint(item.start) ||
          !validPoint(item.end) ||
          !Array.isArray(item.route) ||
          item.route.length < 2 ||
          typeof item.distanceKm !== "number" ||
          !Number.isFinite(item.distanceKm)
        ) {
          return NextResponse.json(
            {
              error: "올바르지 않은 필수 구간이 있습니다.",
            },
            {
              status: 400,
            }
          );
        }
      }
    }

    let result: RoutedPath;

    if (routeType === "순환형") {
      result = await generateLoop(start, targetDistanceKm!, safeRequiredItems, safePreferences);
    } else if (routeType === "왕복형") {
      result = await generateOutAndBack(start, destination!, safeRequiredItems);
    } else {
      result = await generateOneWay(start, destination!, safeRequiredItems);
    }

    const distanceErrorKm = routeType === "순환형" ? result.distanceKm - targetDistanceKm! : null;

    const distanceErrorPercent =
      routeType === "순환형" ? (distanceErrorKm! / targetDistanceKm!) * 100 : null;

    const unsupportedPreferences: string[] = [];

    if (safePreferences.elevation?.min !== null && safePreferences.elevation?.min !== undefined) {
      unsupportedPreferences.push("elevationMin");
    }

    if (safePreferences.elevation?.max !== null && safePreferences.elevation?.max !== undefined) {
      unsupportedPreferences.push("elevationMax");
    }

    if (safePreferences.signalPreference && safePreferences.signalPreference !== "상관없음") {
      unsupportedPreferences.push("signalPreference");
    }

    return NextResponse.json({
      route: result.route,
      navigationSteps: result.navigationSteps,
      summary: {
        targetDistanceKm: routeType === "순환형" ? targetDistanceKm : null,
        distanceKm: result.distanceKm,
        distanceErrorKm,
        distanceErrorPercent,
        durationSeconds: result.durationSeconds,
        routeType,
        costing: "pedestrian",
        overlapRatio: routeType === "순환형" ? result.overlapMetrics?.ratio ?? null : null,
        overlapPercent:
          routeType === "순환형" && result.overlapMetrics
            ? result.overlapMetrics.ratio * 100
            : null,
        overlapPenalty: routeType === "순환형" ? result.overlapMetrics?.penalty ?? null : null,
        provider: "kakao",
        planner: "perog-kakao-only",
        scenerySource: "kakao-local-poi",
        requiredItemsCount: safeRequiredItems.length,
        unsupportedPreferences,
        generationMs: Date.now() - requestStartedAt,
      },
    });
  } catch (error) {
    console.error("PEROG Kakao-only route API error:", error instanceof Error ? error.message : "unknown");

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "경로 생성 중 서버 오류가 발생했습니다.",
      },
      {
        status: error instanceof ApiError ? error.status : error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500,
      }
    );
  }
}
