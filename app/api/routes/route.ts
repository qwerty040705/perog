import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validFinite, validPoint, validRoute, validRouteType, validText, type StoredLocation, type StoredNavigationStep, type StoredRoutePoint, type StoredRouteType } from "@/lib/private-api";

export const runtime = "nodejs";

type RouteDocument = {
  _id: ObjectId;
  userId: ObjectId;
  name: string;
  sport: "run";
  routeType: StoredRouteType;
  start: StoredLocation | null;
  destination: StoredLocation | null;
  generationRequest: { targetDistanceKm: number | null; preferences: { sceneries: string[]; signalPreference: string | null; elevation: { min: number | null; max: number | null } }; requiredItems: unknown[] };
  route: StoredRoutePoint[];
  navigationSteps: StoredNavigationStep[];
  summary: { distanceMeters: number; targetDistanceMeters: number | null; distanceErrorPercent: number | null; durationSeconds: number | null; overlapRatio: number | null };
  isFavorite: boolean;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
};

function validLocation(value: unknown): value is StoredLocation | null {
  if (value === null) return true;
  return validPoint(value) && typeof (value as StoredLocation).name === "string" && typeof (value as StoredLocation).address === "string";
}

function validSteps(value: unknown): value is StoredNavigationStep[] {
  return Array.isArray(value) && value.length <= 2_000 && value.every((step) => {
    if (!step || typeof step !== "object") return false;
    const candidate = step as Partial<StoredNavigationStep>;
    return validFinite(candidate.progressMeters) && validFinite(candidate.distanceMeters) && validText(candidate.guidance, 400);
  });
}

function publicRoute(route: RouteDocument) {
  return { ...route, id: route._id.toHexString(), _id: undefined, userId: undefined };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  const routes = await getPerogDb().then((db) => db.collection<RouteDocument>("routes").find({ userId: identity.userId }).sort({ isFavorite: -1, createdAt: -1 }).limit(100).toArray());
  return NextResponse.json({ routes: routes.map(publicRoute) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") return jsonError("올바른 경로 정보가 필요합니다.");
    const value = body as Record<string, unknown>;
    if (!validRoute(value.route) || !validRouteType(value.routeType) || !validLocation(value.start) || !validLocation(value.destination) || !validSteps(value.navigationSteps)) return jsonError("경로 정보가 올바르지 않습니다.");
    const summary = value.summary as Record<string, unknown> | null;
    if (!summary || !validFinite(summary.distanceMeters, 1, 200_000)) return jsonError("경로 요약 정보가 올바르지 않습니다.");
    const now = new Date();
    const document: Omit<RouteDocument, "_id"> = {
      userId: identity.userId,
      name: validText(value.name, 80) ? value.name.trim() : `${value.routeType ?? "러닝"} 경로 · ${now.toLocaleDateString("ko-KR")}`,
      sport: "run",
      routeType: value.routeType,
      start: value.start,
      destination: value.destination,
      generationRequest: {
        targetDistanceKm: validFinite(value.targetDistanceKm, 0, 50) ? value.targetDistanceKm : null,
        preferences: {
          sceneries: Array.isArray((value.preferences as Record<string, unknown> | null)?.sceneries) ? (value.preferences as { sceneries: unknown[] }).sceneries.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
          signalPreference: typeof (value.preferences as Record<string, unknown> | null)?.signalPreference === "string" ? (value.preferences as { signalPreference: string }).signalPreference : null,
          elevation: { min: null, max: null },
        },
        requiredItems: Array.isArray(value.requiredItems) ? value.requiredItems.slice(0, 12) : [],
      },
      route: value.route,
      navigationSteps: value.navigationSteps,
      summary: {
        distanceMeters: summary.distanceMeters,
        targetDistanceMeters: validFinite(summary.targetDistanceMeters, 0, 200_000) ? summary.targetDistanceMeters : null,
        distanceErrorPercent: typeof summary.distanceErrorPercent === "number" && Number.isFinite(summary.distanceErrorPercent) ? summary.distanceErrorPercent : null,
        durationSeconds: validFinite(summary.durationSeconds, 0, 86_400) ? summary.durationSeconds : null,
        overlapRatio: validFinite(summary.overlapRatio, 0, 1) ? summary.overlapRatio : null,
      },
      isFavorite: false,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const result = await getPerogDb().then((db) => db.collection<RouteDocument>("routes").insertOne(document as RouteDocument));
    return NextResponse.json({ route: publicRoute({ ...document, _id: result.insertedId } as RouteDocument) }, { status: 201 });
  } catch {
    return jsonError("경로를 저장하지 못했습니다.", 500);
  }
}
