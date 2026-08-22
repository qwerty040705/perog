"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AuthRequired } from "@/components/auth/AuthRequired";
import Header from "@/components/layout/Header";
type Workout = { startedAt: string; actualDistanceMeters: number; plannedDistanceMeters: number; elapsedSeconds: number; movingSeconds: number; completionRatio: number; averagePaceSecondsPerKm: number | null; pauseCount: number; offRouteCount: number; routeType: string | null; plannedRoute: unknown[]; track: unknown[] };
function Detail() { const { id } = useParams<{ id: string }>(); const [workout, setWorkout] = useState<Workout | null>(null); useEffect(() => { fetch(`/api/workouts/${id}`, { cache: "no-store" }).then((response) => response.json()).then((data: { workout?: Workout }) => setWorkout(data.workout ?? null)).catch(() => setWorkout(null)); }, [id]); return <main className="my-page"><Header /><section className="my-content">{!workout ? <p className="my-loading">러닝 기록을 불러오고 있습니다...</p> : <><p className="landing-eyebrow"><span /> RUN DETAIL</p><h1>{(workout.actualDistanceMeters / 1_000).toFixed(2)} KM</h1><div className="my-detail-grid"><span>계획 거리 <b>{(workout.plannedDistanceMeters / 1_000).toFixed(2)} KM</b></span><span>경과 시간 <b>{Math.round(workout.elapsedSeconds / 60)}분</b></span><span>완료율 <b>{Math.round(workout.completionRatio * 100)}%</b></span><span>이탈 / 일시정지 <b>{workout.offRouteCount} / {workout.pauseCount}</b></span></div><p className="my-track-note">GPS 트랙 {workout.track.length}개 지점은 계정 본인에게만 저장됩니다.</p><Link className="my-back" href="/my/workouts">러닝 기록으로 돌아가기</Link></>}</section></main>; }
export default function WorkoutDetailPage() { return <AuthRequired><Detail /></AuthRequired>; }
