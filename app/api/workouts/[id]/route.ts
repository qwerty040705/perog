import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validObjectId } from "@/lib/private-api";

export const runtime = "nodejs";
type Workout = { _id: ObjectId; userId: ObjectId; plannedRoute: unknown[]; routeType: string | null; startedAt: Date; endedAt: Date; elapsedSeconds: number; movingSeconds: number; actualDistanceMeters: number; plannedDistanceMeters: number; completionRatio: number; averagePaceSecondsPerKm: number | null; pauseCount: number; offRouteCount: number };

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  const id = validObjectId((await params).id);
  if (!id) return jsonError("올바르지 않은 러닝 기록 ID입니다.");
  const db = await getPerogDb();
  const workout = await db.collection<Workout>("workouts").findOne({ _id: id, userId: identity.userId });
  if (!workout) return jsonError("러닝 기록을 찾을 수 없습니다.", 404);
  const chunks = await db.collection<{ workoutId: ObjectId; points: unknown[] }>("workoutTrackChunks").find({ workoutId: id }).sort({ chunkIndex: 1 }).toArray();
  return NextResponse.json({ workout: { ...workout, id: workout._id.toHexString(), _id: undefined, userId: undefined, track: chunks.flatMap((chunk) => chunk.points) } }, { headers: { "Cache-Control": "no-store" } });
}
