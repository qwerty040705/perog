"use client";

import { useState } from "react";
import { useCurrentUser } from "./useCurrentUser";

const ACTIVE_KEY = "perog-active-workout";
const SUMMARY_KEY = "perog-last-workout";

export function DeviceDataMigration() {
  const auth = useCurrentUser();
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasDeviceData = auth.status === "authenticated" && typeof window !== "undefined" && !localStorage.getItem("perog-device-data-migrated") && Boolean(localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(SUMMARY_KEY));

  if (auth.status !== "authenticated" || !hasDeviceData || done) return null;

  const migrate = async () => {
    setSaving(true);
    try {
      const active = localStorage.getItem(ACTIVE_KEY);
      const summary = localStorage.getItem(SUMMARY_KEY);
      if (active) await fetch("/api/workouts/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: active });
      if (summary) {
        const parsed = JSON.parse(summary) as Record<string, unknown>;
        await fetch("/api/workouts/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...parsed, sourceWorkoutId: parsed.id, actualDistanceMeters: parsed.distanceMeters, plannedRoute: parsed.plannedRoute }) });
      }
      localStorage.setItem("perog-device-data-migrated", "1");
      setDone(true);
    } catch {
      // Local records stay intact; the user can retry after a connection recovers.
    } finally { setSaving(false); }
  };

  return <aside className="device-migration"><div><small>PEROG ACCOUNT</small><strong>현재 기기의 러닝 데이터를 계정에 저장할까요?</strong><span>동의한 데이터만 계정에 연결됩니다.</span></div><button type="button" onClick={migrate} disabled={saving}>{saving ? "저장 중..." : "계정에 저장"}</button><button type="button" onClick={() => setDone(true)}>나중에</button></aside>;
}
