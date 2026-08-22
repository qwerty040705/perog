import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validFinite, validObjectId } from "@/lib/private-api";

export const runtime = "nodejs";
const ALLOWED_TAGS = new Set(["경치가 좋았어요", "신호가 많았어요", "길 찾기 쉬웠어요", "경로가 반복됐어요", "거리 정확했어요", "경사가 많았어요"]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!validFinite(body.overallRating, 1, 5)) return jsonError("평점은 1점부터 5점까지 선택해주세요.");
    const routeId = typeof body.routeId === "string" ? validObjectId(body.routeId) : null;
    const sourceWorkoutId = typeof body.sourceWorkoutId === "string" ? body.sourceWorkoutId : null;
    const workout = sourceWorkoutId ? await getPerogDb().then((db) => db.collection<{ _id: ObjectId; userId: ObjectId }>("workouts").findOne({ userId: identity.userId, sourceWorkoutId })) : null;
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string" && ALLOWED_TAGS.has(tag)).slice(0, 6) : [];
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 500) : "";
    await getPerogDb().then((db) => db.collection("routeFeedback").updateOne({ userId: identity.userId, workoutId: workout?._id ?? null }, { $set: { userId: identity.userId, routeId, workoutId: workout?._id ?? null, overallRating: body.overallRating, tags, comment, createdAt: new Date() } }, { upsert: true }));
    return NextResponse.json({ ok: true });
  } catch { return jsonError("피드백을 저장하지 못했습니다.", 400); }
}
