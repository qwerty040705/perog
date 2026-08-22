import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validFinite, validObjectId, validRoute, validRouteType, validText, type StoredRoutePoint } from "@/lib/private-api";

export const runtime = "nodejs";
const TRACK_CHUNK_SIZE = 750;
type TrackPoint = StoredRoutePoint & { timestamp: number; accuracy: number };
type Workout = { _id: ObjectId; userId: ObjectId; sourceWorkoutId: string; routeId: ObjectId | null; sport: "run"; routeType: "순환형" | "왕복형" | "편도형" | null; startedAt: Date; endedAt: Date; elapsedSeconds: number; movingSeconds: number; plannedDistanceMeters: number; actualDistanceMeters: number; completionRatio: number; averagePaceSecondsPerKm: number | null; pauseCount: number; offRouteCount: number; plannedRoute: StoredRoutePoint[]; createdAt: Date };

function validTrack(value: unknown): value is TrackPoint[] {
  return Array.isArray(value) && value.length <= 12_000 && value.every((point) => validRoute([point, point]) && validFinite((point as TrackPoint).timestamp, 1) && validFinite((point as TrackPoint).accuracy, 0, 500));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!validText(body.sourceWorkoutId, 120) || !validRouteType(body.routeType) || !validRoute(body.plannedRoute) || !validTrack(body.track) || !validFinite(body.startedAt, 1) || !validFinite(body.endedAt, Number(body.startedAt)) || !validFinite(body.elapsedSeconds) || !validFinite(body.movingSeconds) || !validFinite(body.plannedDistanceMeters) || !validFinite(body.actualDistanceMeters) || !validFinite(body.completionRatio, 0, 1) || !validFinite(body.pauseCount, 0, 10_000) || !validFinite(body.offRouteCount, 0, 10_000)) return jsonError("러닝 기록이 올바르지 않습니다.");
    const db = await getPerogDb();
    const workouts = db.collection<Workout>("workouts");
    const existing = await workouts.findOne({ userId: identity.userId, sourceWorkoutId: body.sourceWorkoutId });
    if (existing) return NextResponse.json({ workoutId: existing._id.toHexString(), duplicate: true });
    const routeId = typeof body.routeId === "string" ? validObjectId(body.routeId) : null;
    const workout: Omit<Workout, "_id"> = {
      userId: identity.userId, sourceWorkoutId: body.sourceWorkoutId, routeId, sport: "run", routeType: body.routeType,
      startedAt: new Date(body.startedAt), endedAt: new Date(body.endedAt), elapsedSeconds: body.elapsedSeconds, movingSeconds: body.movingSeconds,
      plannedDistanceMeters: body.plannedDistanceMeters, actualDistanceMeters: body.actualDistanceMeters, completionRatio: body.completionRatio,
      averagePaceSecondsPerKm: typeof body.averagePaceSecondsPerKm === "number" && Number.isFinite(body.averagePaceSecondsPerKm) ? body.averagePaceSecondsPerKm : null,
      pauseCount: body.pauseCount, offRouteCount: body.offRouteCount, plannedRoute: body.plannedRoute, createdAt: new Date(),
    };
    const inserted = await workouts.insertOne(workout as Workout);
    const trackChunks = body.track.reduce<TrackPoint[][]>((chunks, point, index) => { const chunk = Math.floor(index / TRACK_CHUNK_SIZE); (chunks[chunk] ??= []).push(point); return chunks; }, []);
    if (trackChunks.length) await db.collection("workoutTrackChunks").insertMany(trackChunks.map((points, chunkIndex) => ({ userId: identity.userId, workoutId: inserted.insertedId, chunkIndex, points, createdAt: new Date() })));
    await db.collection("users").updateOne({ _id: identity.userId }, { $inc: { "stats.totalRuns": 1, "stats.totalDistanceMeters": body.actualDistanceMeters, "stats.totalMovingSeconds": body.movingSeconds }, $set: { updatedAt: new Date() } });
    if (routeId) await db.collection("routes").updateOne({ _id: routeId, userId: identity.userId }, { $inc: { runCount: 1 }, $set: { updatedAt: new Date() } });
    await db.collection("activeWorkouts").deleteOne({ userId: identity.userId });
    return NextResponse.json({ workoutId: inserted.insertedId.toHexString() }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: number }).code === 11000) return NextResponse.json({ duplicate: true });
    return jsonError("러닝 기록을 저장하지 못했습니다.", 500);
  }
}
