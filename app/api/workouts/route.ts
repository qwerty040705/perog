import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, requireIdentity } from "@/lib/private-api";

export const runtime = "nodejs";
type Workout = { _id: ObjectId; userId: ObjectId; routeType: string | null; startedAt: Date; endedAt: Date; elapsedSeconds: number; movingSeconds: number; actualDistanceMeters: number; completionRatio: number; averagePaceSecondsPerKm: number | null; pauseCount: number; offRouteCount: number };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  const workouts = await getPerogDb().then((db) => db.collection<Workout>("workouts").find({ userId: identity.userId }).sort({ startedAt: -1 }).limit(100).toArray());
  return NextResponse.json({ workouts: workouts.map((workout) => ({ ...workout, id: workout._id.toHexString(), _id: undefined, userId: undefined })) }, { headers: { "Cache-Control": "no-store" } });
}
