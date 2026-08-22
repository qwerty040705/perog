"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import WorkoutSummaryMap from "@/components/map/WorkoutSummaryMap";
import type { WorkoutSummary } from "@/lib/workout";
import { useCurrentUser } from "@/components/auth/useCurrentUser";

const SUMMARY_STORAGE_KEY = "perog-last-workout";

function validSummary(value: unknown): value is WorkoutSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<WorkoutSummary>;
  return typeof summary.id === "string" && typeof summary.startedAt === "number" && typeof summary.endedAt === "number" && typeof summary.distanceMeters === "number" && Array.isArray(summary.track) && Array.isArray(summary.plannedRoute);
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatPace(seconds: number | null) {
  if (seconds === null) return "--'--\"";
  return `${Math.floor(seconds / 60)}'${String(Math.round(seconds % 60)).padStart(2, "0")}\"`;
}

export default function NavigationSummaryPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<WorkoutSummary | null>(null);
  const auth = useCurrentUser();
  const [rating, setRating] = useState<number | null>(null);
  const [feedbackSaved, setFeedbackSaved] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem(SUMMARY_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (validSummary(parsed)) queueMicrotask(() => setSummary(parsed));
    } catch {
      // Invalid local data should not block navigation back to route creation.
    }
  }, []);

  if (!summary) return <main className="workout-summary-page"><div className="workout-summary-empty"><strong>기록을 찾을 수 없습니다.</strong><button type="button" onClick={() => router.replace("/create")}>경로 만들기</button></div></main>;

  const saveFeedback = async () => {
    if (rating === null) return;
    const response = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceWorkoutId: summary.id, overallRating: rating, tags: [] }) });
    if (response.ok) setFeedbackSaved(true);
  };

  return (
    <main className="workout-summary-page">
      <header className="workout-summary-header"><button type="button" onClick={() => router.replace("/create")}>←</button><div><small>PEROG</small><h1>RUN SUMMARY</h1></div></header>
      <WorkoutSummaryMap plannedRoute={summary.plannedRoute} track={summary.track} />
      <section className="workout-summary-hero"><small>총 기록 거리</small><strong>{(summary.distanceMeters / 1_000).toFixed(2)} KM</strong><span>{new Date(summary.startedAt).toLocaleString("ko-KR")} — {new Date(summary.endedAt).toLocaleTimeString("ko-KR")}</span></section>
      <section className="workout-summary-grid">
        <div><small>총 경과 시간</small><strong>{formatDuration(summary.elapsedSeconds)}</strong></div>
        <div><small>이동 시간</small><strong>{formatDuration(summary.movingSeconds)}</strong></div>
        <div><small>평균 페이스</small><strong>{formatPace(summary.averagePaceSecondsPerKm)} /KM</strong></div>
        <div><small>계획 거리</small><strong>{(summary.plannedDistanceMeters / 1_000).toFixed(2)} KM</strong></div>
        <div><small>완료율</small><strong>{Math.round(summary.completionRatio * 100)}%</strong></div>
        <div><small>이탈 / 일시정지</small><strong>{summary.offRouteCount} / {summary.pauseCount}</strong></div>
      </section>
      {auth.status === "authenticated" && <section className="workout-feedback"><small>ROUTE FEEDBACK</small><h2>이 경로는 어땠나요?</h2>{feedbackSaved ? <p>피드백을 저장했습니다.</p> : <div>{[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" className={rating === value ? "is-selected" : ""} onClick={() => setRating(value)} aria-label={`${value}점`}>★</button>)}<button type="button" disabled={rating === null} onClick={saveFeedback}>저장</button></div>}</section>}
      <button className="workout-summary-done" type="button" onClick={() => router.replace("/create")}>새 경로 만들기</button>
    </main>
  );
}
