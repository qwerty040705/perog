import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { parseActiveWorkout, type ActiveWorkoutState } from "@/lib/active-workout";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validObjectId } from "@/lib/private-api";

export const runtime = "nodejs";

type ActiveWorkoutDocument = ActiveWorkoutState & { _id: ObjectId; userId: ObjectId; routeId: ObjectId | null; createdAt: Date; updatedAt: Date };
const publicActiveWorkout = (workout: ActiveWorkoutDocument) => ({ ...workout, id: workout._id.toHexString(), _id: undefined, userId: undefined, routeId: workout.routeId?.toHexString() ?? null });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  const activeWorkout = await getPerogDb().then((db) => db.collection<ActiveWorkoutDocument>("activeWorkouts").findOne({ userId: identity.userId }));
  return NextResponse.json({ activeWorkout: activeWorkout ? publicActiveWorkout(activeWorkout) : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  try {
    const payload: unknown = await request.json();
    const activeWorkout = parseActiveWorkout(JSON.stringify(payload));
    if (!activeWorkout) return jsonError("진행 중인 러닝 정보가 올바르지 않습니다.");
    const body = payload as Record<string, unknown>;
    const routeId = typeof body.routeId === "string" ? validObjectId(body.routeId) : null;
    const db = await getPerogDb();
    const collection = db.collection<ActiveWorkoutDocument>("activeWorkouts");
    const existing = await collection.findOne({ userId: identity.userId });
    if (existing && existing.lastSavedAt > activeWorkout.lastSavedAt) {
      return NextResponse.json({ activeWorkout: publicActiveWorkout(existing), conflict: true });
    }
    const now = new Date();
    const result = await collection.findOneAndUpdate(
      { userId: identity.userId },
      { $set: { ...activeWorkout, routeId, updatedAt: now }, $setOnInsert: { userId: identity.userId, createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    if (!result) return jsonError("러닝 상태를 저장하지 못했습니다.", 500);
    return NextResponse.json({ activeWorkout: publicActiveWorkout(result) });
  } catch { return jsonError("러닝 상태를 저장하지 못했습니다.", 400); }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  await getPerogDb().then((db) => db.collection<ActiveWorkoutDocument>("activeWorkouts").deleteOne({ userId: identity.userId }));
  return NextResponse.json({ ok: true });
}
