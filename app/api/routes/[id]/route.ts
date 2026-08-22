import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validObjectId, validText } from "@/lib/private-api";

export const runtime = "nodejs";

type RouteDocument = { _id: ObjectId; userId: ObjectId; name: string; isFavorite: boolean; route: unknown[]; routeType: string | null; summary: Record<string, unknown>; navigationSteps: unknown[]; start: unknown; destination: unknown; createdAt: Date; updatedAt: Date; runCount: number };
const publicRoute = (route: RouteDocument) => ({ ...route, id: route._id.toHexString(), _id: undefined, userId: undefined });

async function owner(request: NextRequest, params: Promise<{ id: string }>) {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  const id = validObjectId((await params).id);
  return id ? { identity, id } : jsonError("올바르지 않은 경로 ID입니다.");
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const context = await owner(request, params);
  if (context instanceof NextResponse) return context;
  const route = await getPerogDb().then((db) => db.collection<RouteDocument>("routes").findOne({ _id: context.id, userId: context.identity.userId }));
  return route ? NextResponse.json({ route: publicRoute(route) }, { headers: { "Cache-Control": "no-store" } }) : jsonError("경로를 찾을 수 없습니다.", 404);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const context = await owner(request, params);
  if (context instanceof NextResponse) return context;
  try {
    const body = await request.json() as Record<string, unknown>;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.isFavorite === "boolean") update.isFavorite = body.isFavorite;
    if (body.name !== undefined) { if (!validText(body.name, 80)) return jsonError("경로 이름이 올바르지 않습니다."); update.name = body.name.trim(); }
    const result = await getPerogDb().then((db) => db.collection<RouteDocument>("routes").findOneAndUpdate({ _id: context.id, userId: context.identity.userId }, { $set: update }, { returnDocument: "after" }));
    return result ? NextResponse.json({ route: publicRoute(result) }) : jsonError("경로를 찾을 수 없습니다.", 404);
  } catch { return jsonError("경로를 수정하지 못했습니다.", 400); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const context = await owner(request, params);
  if (context instanceof NextResponse) return context;
  const result = await getPerogDb().then((db) => db.collection<RouteDocument>("routes").deleteOne({ _id: context.id, userId: context.identity.userId }));
  return result.deletedCount === 1 ? NextResponse.json({ ok: true }) : jsonError("경로를 찾을 수 없습니다.", 404);
}
