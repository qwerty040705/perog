export type RoutePoint = { latitude: number; longitude: number };

export type RouteMatch = {
  matched: true;
  segmentIndex: number;
  segmentFraction: number;
  distanceMeters: number;
  matchedPoint: RoutePoint;
  progressMeters: number;
  totalMeters: number;
  reacquired: boolean;
};

export type UnmatchedRoute = {
  matched: false;
  distanceMeters: number;
  totalMeters: number;
};

export type RouteMatchResult = RouteMatch | UnmatchedRoute;
export type TurnInstruction = {
  type: "straight" | "left" | "right";
  text: string;
  distanceMeters: number | null;
  key: string;
};
export type NavigationStep = { progressMeters: number; distanceMeters: number; guidance: string };

type LocalPoint = { x: number; y: number };
type IndexedSegment = { index: number; from: RoutePoint; to: RoutePoint; lengthMeters: number; startMeters: number; bearing: number };
export type RouteIndex = { route: RoutePoint[]; segments: IndexedSegment[]; cumulativeMeters: number[]; totalMeters: number; grid: Map<string, number[]> };
export type MatchOptions = { previousProgressMeters: number; accuracyMeters: number; movementHeading?: number | null; speedMetersPerSecond?: number | null };

const GRID_SIZE_METERS = 80;
const LOCAL_CORRIDOR_BEHIND_METERS = 35;
const LOCAL_CORRIDOR_AHEAD_METERS = 180;
const MATCH_SEARCH_RADII_CELLS = [2, 4, 8, 16];

export function normalizeAngle(angle: number) {
  let result = angle % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

export function haversineMeters(a: RoutePoint, b: RoutePoint) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(from: RoutePoint, to: RoutePoint) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function toLocalPoint(point: RoutePoint, origin: RoutePoint): LocalPoint {
  const latitudeRadians = (origin.latitude * Math.PI) / 180;
  return { x: (point.longitude - origin.longitude) * 111_320 * Math.cos(latitudeRadians), y: (point.latitude - origin.latitude) * 111_320 };
}

function projectPointToSegment(current: RoutePoint, from: RoutePoint, to: RoutePoint) {
  const a = toLocalPoint(from, current);
  const b = toLocalPoint(to, current);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
  return { fraction, distanceMeters: Math.hypot(a.x + fraction * dx, a.y + fraction * dy) };
}

function interpolateRoutePoint(from: RoutePoint, to: RoutePoint, fraction: number): RoutePoint {
  return { latitude: from.latitude + (to.latitude - from.latitude) * fraction, longitude: from.longitude + (to.longitude - from.longitude) * fraction };
}

function gridKey(latitude: number, longitude: number) {
  const y = Math.floor((latitude * 111_320) / GRID_SIZE_METERS);
  const x = Math.floor((longitude * 111_320 * Math.cos((latitude * Math.PI) / 180)) / GRID_SIZE_METERS);
  return `${x}:${y}`;
}

export function createRouteIndex(route: RoutePoint[]): RouteIndex {
  const segments: IndexedSegment[] = [];
  const cumulativeMeters = [0];
  const grid = new Map<string, number[]>();
  let totalMeters = 0;
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    const lengthMeters = haversineMeters(from, to);
    const segment: IndexedSegment = { index: index - 1, from, to, lengthMeters, startMeters: totalMeters, bearing: bearingDegrees(from, to) };
    segments.push(segment);
    totalMeters += lengthMeters;
    cumulativeMeters.push(totalMeters);
    const latStep = GRID_SIZE_METERS / 111_320;
    const midpointLatitude = (from.latitude + to.latitude) / 2;
    const lonStep = GRID_SIZE_METERS / (111_320 * Math.cos((midpointLatitude * Math.PI) / 180));
    for (let latitude = Math.min(from.latitude, to.latitude); latitude <= Math.max(from.latitude, to.latitude) + latStep; latitude += latStep) {
      for (let longitude = Math.min(from.longitude, to.longitude); longitude <= Math.max(from.longitude, to.longitude) + lonStep; longitude += lonStep) {
        const key = gridKey(latitude, longitude);
        const bucket = grid.get(key) ?? [];
        if (!bucket.includes(segment.index)) bucket.push(segment.index);
        grid.set(key, bucket);
      }
    }
  }
  return { route, segments, cumulativeMeters, totalMeters, grid };
}

function nearbySegmentIndexes(index: RouteIndex, point: RoutePoint, radiusCells: number) {
  const [xText, yText] = gridKey(point.latitude, point.longitude).split(":");
  const x = Number(xText);
  const y = Number(yText);
  const candidates = new Set<number>();
  for (let gridX = x - radiusCells; gridX <= x + radiusCells; gridX += 1) {
    for (let gridY = y - radiusCells; gridY <= y + radiusCells; gridY += 1) {
      for (const segmentIndex of index.grid.get(`${gridX}:${gridY}`) ?? []) candidates.add(segmentIndex);
    }
  }
  return [...candidates];
}

function angleDistance(a: number, b: number) { return Math.abs(normalizeAngle(a - b)); }

export function isFreshTimestamp(updatedAt: number, now: number, maxAgeMs: number) {
  return updatedAt > 0 && now >= updatedAt && now - updatedAt <= maxAgeMs;
}

export function selectMovementHeading(options: {
  gpsHeading: number | null;
  speedMetersPerSecond: number | null;
  orientationHeading: number | null;
  orientationUpdatedAt: number;
  now: number;
  maxOrientationAgeMs: number;
}) {
  if (options.gpsHeading !== null && Number.isFinite(options.gpsHeading) && (options.speedMetersPerSecond ?? 0) >= 1.2) return options.gpsHeading;
  return isFreshTimestamp(options.orientationUpdatedAt, options.now, options.maxOrientationAgeMs) ? options.orientationHeading : null;
}

export function updateArrivalSampleCount(previousCount: number, isArrivalSample: boolean) {
  return isArrivalSample ? previousCount + 1 : 0;
}

export function matchRoute(index: RouteIndex, current: RoutePoint, options: MatchOptions): RouteMatchResult {
  if (index.segments.length === 0) return { matched: false, distanceMeters: Infinity, totalMeters: index.totalMeters };
  const snapLimit = Math.max(30, Math.min(100, options.accuracyMeters * 1.6));
  const localMin = Math.max(0, options.previousProgressMeters - LOCAL_CORRIDOR_BEHIND_METERS);
  const localMax = Math.min(index.totalMeters, options.previousProgressMeters + LOCAL_CORRIDOR_AHEAD_METERS);
  const useHeading = options.movementHeading !== null && options.movementHeading !== undefined && (options.speedMetersPerSecond ?? 0) >= 1.2;
  const evaluate = (candidateIndexes: number[], localOnly: boolean, reacquired: boolean): RouteMatch | null => {
    let best: RouteMatch | null = null;
    let bestScore = Infinity;
    for (const segmentIndex of candidateIndexes) {
      const segment = index.segments[segmentIndex];
      if (!segment) continue;
      if (localOnly && (segment.startMeters + segment.lengthMeters < localMin || segment.startMeters > localMax)) continue;
      const projected = projectPointToSegment(current, segment.from, segment.to);
      const progressMeters = segment.startMeters + segment.lengthMeters * projected.fraction;
      const headingPenalty = useHeading ? Math.min(36, angleDistance(options.movementHeading!, segment.bearing) * 0.2) : 0;
      const continuityPenalty = localOnly ? Math.min(20, Math.abs(progressMeters - options.previousProgressMeters) * 0.06) : 0;
      const score = projected.distanceMeters + headingPenalty + continuityPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = { matched: true, segmentIndex, segmentFraction: projected.fraction, distanceMeters: projected.distanceMeters, matchedPoint: interpolateRoutePoint(segment.from, segment.to, projected.fraction), progressMeters, totalMeters: index.totalMeters, reacquired };
      }
    }
    return best;
  };

  for (const radius of MATCH_SEARCH_RADII_CELLS) {
    const candidates = nearbySegmentIndexes(index, current, radius);
    if (candidates.length === 0) continue;
    const local = evaluate(candidates, true, false);
    if (local && local.distanceMeters <= snapLimit) return local;
    const reacquired = evaluate(candidates, false, true);
    if (reacquired && reacquired.distanceMeters <= snapLimit && reacquired.progressMeters + 40 >= options.previousProgressMeters) return reacquired;
  }
  return { matched: false, distanceMeters: Infinity, totalMeters: index.totalMeters };
}

export function findSegmentAtDistance(index: RouteIndex, distanceMeters: number) {
  const target = Math.min(index.totalMeters, Math.max(0, distanceMeters));
  let low = 0;
  let high = index.segments.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = index.segments[middle];
    if (target < segment.startMeters) high = middle - 1;
    else if (target > segment.startMeters + segment.lengthMeters && middle < index.segments.length - 1) low = middle + 1;
    else return segment;
  }
  return index.segments[Math.min(index.segments.length - 1, Math.max(0, low))] ?? null;
}

export function pointAtDistance(index: RouteIndex, progressMeters: number, distanceAheadMeters = 0) {
  const target = progressMeters + distanceAheadMeters;
  const segment = findSegmentAtDistance(index, target);
  if (!segment || segment.lengthMeters === 0) return index.route[index.route.length - 1];
  return interpolateRoutePoint(segment.from, segment.to, Math.max(0, Math.min(1, (Math.min(index.totalMeters, Math.max(0, target)) - segment.startMeters) / segment.lengthMeters)));
}

/** Returns the route geometry inside a progress window, including exact window endpoints. */
export function routeWindow(index: RouteIndex, startMeters: number, endMeters: number): RoutePoint[] {
  if (index.route.length === 0) return [];

  const start = Math.max(0, Math.min(index.totalMeters, startMeters));
  const end = Math.max(start, Math.min(index.totalMeters, endMeters));
  const points = [pointAtDistance(index, start)];

  for (let vertexIndex = 1; vertexIndex < index.route.length - 1; vertexIndex += 1) {
    const progress = index.cumulativeMeters[vertexIndex] ?? 0;
    if (progress > start && progress < end) points.push(index.route[vertexIndex]);
  }

  const endPoint = pointAtDistance(index, end);
  const lastPoint = points[points.length - 1];
  if (!lastPoint || lastPoint.latitude !== endPoint.latitude || lastPoint.longitude !== endPoint.longitude) {
    points.push(endPoint);
  }

  return points;
}

export function projectPointToRouteProgress(index: RouteIndex, point: RoutePoint) {
  let best: { progressMeters: number; distanceMeters: number } | null = null;
  for (const radius of MATCH_SEARCH_RADII_CELLS) {
    const candidates = nearbySegmentIndexes(index, point, radius);
    for (const segmentIndex of candidates) {
      const segment = index.segments[segmentIndex];
      if (!segment) continue;
      const projection = projectPointToSegment(point, segment.from, segment.to);
      if (!best || projection.distanceMeters < best.distanceMeters) {
        best = { progressMeters: segment.startMeters + segment.lengthMeters * projection.fraction, distanceMeters: projection.distanceMeters };
      }
    }
    if (best) return best;
  }
  return null;
}

export function findUpcomingNavigationStep(steps: NavigationStep[], progressMeters: number, minimumAheadMeters = 5, maximumAheadMeters = 22) {
  let low = 0;
  let high = steps.length - 1;
  let firstAfter = steps.length;
  const target = progressMeters + minimumAheadMeters;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (steps[middle].progressMeters >= target) { firstAfter = middle; high = middle - 1; }
    else low = middle + 1;
  }
  const step = steps[firstAfter];
  return step && step.progressMeters <= progressMeters + maximumAheadMeters ? step : null;
}

export function findUpcomingTurns(index: RouteIndex, progressMeters: number, displayDistanceMeters = 22, maximumResults = 2): TurnInstruction[] {
  const start = findSegmentAtDistance(index, progressMeters + 6)?.index ?? 0;
  const turns: TurnInstruction[] = [];
  for (let vertexIndex = Math.max(1, start + 1); vertexIndex < index.route.length - 1; vertexIndex += 1) {
    const vertexDistance = index.cumulativeMeters[vertexIndex] ?? 0;
    const distanceFromCurrent = vertexDistance - progressMeters;
    if (distanceFromCurrent > displayDistanceMeters) break;
    if (distanceFromCurrent < 6) continue;
    const longBefore = pointAtDistance(index, vertexDistance, -22);
    const longAfter = pointAtDistance(index, vertexDistance, 22);
    const shortBefore = pointAtDistance(index, vertexDistance, -8);
    const shortAfter = pointAtDistance(index, vertexDistance, 8);
    const longAngle = normalizeAngle(bearingDegrees(index.route[vertexIndex], longAfter) - bearingDegrees(longBefore, index.route[vertexIndex]));
    const shortAngle = normalizeAngle(bearingDegrees(index.route[vertexIndex], shortAfter) - bearingDegrees(shortBefore, index.route[vertexIndex]));
    if (Math.abs(longAngle) < 60 || Math.abs(shortAngle) < 38) continue;
    const type = longAngle > 0 ? "right" : "left";
    turns.push({ type, text: `${Math.round(distanceFromCurrent)}m 후 ${type === "right" ? "우" : "좌"}회전`, distanceMeters: distanceFromCurrent, key: `${vertexIndex}:${type}` });
    if (turns.length >= maximumResults) break;
  }
  return turns;
}

export function findUpcomingTurn(index: RouteIndex, progressMeters: number, displayDistanceMeters = 22): TurnInstruction {
  return findUpcomingTurns(index, progressMeters, displayDistanceMeters, 1)[0] ?? { type: "straight", text: "직진하세요", distanceMeters: null, key: "straight" };
}

export function circularEma(previous: number | null, next: number, alpha: number) {
  return previous === null ? next : (previous + alpha * normalizeAngle(next - previous) + 360) % 360;
}
