"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCurrentUser } from "./useCurrentUser";

type ActiveWorkout = { workoutDistanceMeters: number; movingSeconds: number };

export function ActiveWorkoutBanner() {
  const auth = useCurrentUser();
  const [activeWorkout, setActiveWorkout] = useState<ActiveWorkout | null>(null);
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    void fetch("/api/workouts/active", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ activeWorkout?: ActiveWorkout | null }> : null).then((data) => setActiveWorkout(data?.activeWorkout ?? null)).catch(() => undefined);
  }, [auth.status]);
  if (!activeWorkout) return null;
  return <aside className="active-workout-banner"><div><small>RUN IN PROGRESS</small><strong>진행 중인 러닝이 있습니다.</strong><span>{(activeWorkout.workoutDistanceMeters / 1_000).toFixed(2)} KM · {Math.floor(activeWorkout.movingSeconds / 60)}분</span></div><Link href="/navigate">이어서 달리기</Link></aside>;
}
