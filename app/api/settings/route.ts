import { NextRequest, NextResponse } from "next/server";
import { getPerogDb } from "@/lib/mongodb";
import { isApiError, jsonError, requireIdentity, validFinite } from "@/lib/private-api";

export const runtime = "nodejs";
type Settings = { voiceGuidance: boolean; vibration: boolean; displayMode: "camera" | "map" | "simple" };
type Preferences = { preferredRouteTypes: string[]; preferredSceneries: string[]; defaultDistanceKm: number | null };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  const user = await getPerogDb().then((db) => db.collection<{ navigationSettings?: Settings; preferences?: Preferences }>("users").findOne({ _id: identity.userId }, { projection: { navigationSettings: 1, preferences: 1 } }));
  return NextResponse.json({ navigationSettings: user?.navigationSettings ?? { voiceGuidance: true, vibration: true, displayMode: "camera" }, preferences: user?.preferences ?? { preferredRouteTypes: [], preferredSceneries: [], defaultDistanceKm: null } }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const identity = await requireIdentity(request);
  if (isApiError(identity)) return identity;
  try {
    const body = await request.json() as Record<string, unknown>;
    const navigationSettings = body.navigationSettings as Partial<Settings> | undefined;
    const preferences = body.preferences as Partial<Preferences> | undefined;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (navigationSettings) {
      if (typeof navigationSettings.voiceGuidance === "boolean") update["navigationSettings.voiceGuidance"] = navigationSettings.voiceGuidance;
      if (typeof navigationSettings.vibration === "boolean") update["navigationSettings.vibration"] = navigationSettings.vibration;
      if (navigationSettings.displayMode === "camera" || navigationSettings.displayMode === "map" || navigationSettings.displayMode === "simple") update["navigationSettings.displayMode"] = navigationSettings.displayMode;
    }
    if (preferences) {
      if (Array.isArray(preferences.preferredRouteTypes) && preferences.preferredRouteTypes.every((item) => typeof item === "string")) update["preferences.preferredRouteTypes"] = preferences.preferredRouteTypes.slice(0, 3);
      if (Array.isArray(preferences.preferredSceneries) && preferences.preferredSceneries.every((item) => typeof item === "string")) update["preferences.preferredSceneries"] = preferences.preferredSceneries.slice(0, 8);
      if (preferences.defaultDistanceKm === null || validFinite(preferences.defaultDistanceKm, 1, 50)) update["preferences.defaultDistanceKm"] = preferences.defaultDistanceKm;
    }
    await getPerogDb().then((db) => db.collection("users").updateOne({ _id: identity.userId }, { $set: update }));
    return GET(request);
  } catch { return jsonError("설정을 저장하지 못했습니다.", 400); }
}
