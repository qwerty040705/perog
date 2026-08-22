"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthRequired } from "@/components/auth/AuthRequired";
import Header from "@/components/layout/Header";
type Workout = { id: string; startedAt: string; actualDistanceMeters: number; movingSeconds: number; averagePaceSecondsPerKm: number | null; routeType: string | null; completionRatio: number };
function pace(value: number | null) { return value === null ? "--'--\"" : `${Math.floor(value / 60)}'${String(Math.round(value % 60)).padStart(2, "0")}"`; }
function MyWorkouts() { const [workouts, setWorkouts] = useState<Workout[] | null>(null); useEffect(() => { fetch("/api/workouts", { cache: "no-store" }).then((response) => response.json()).then((data: { workouts?: Workout[] }) => setWorkouts(data.workouts ?? [])).catch(() => setWorkouts([])); }, []); return <main className="my-page"><Header /><section className="my-content"><p className="landing-eyebrow"><span /> RUN HISTORY</p><h1>러닝 기록</h1>{workouts === null ? <p className="my-loading">기록을 불러오고 있습니다...</p> : workouts.length === 0 ? <div className="my-empty"><h2>첫 러닝을 시작해보세요.</h2><Link href="/create">경로 만들기</Link></div> : <div className="my-list">{workouts.map((workout) => <Link key={workout.id} href={`/my/workouts/${workout.id}`} className="my-workout"><small>{new Date(workout.startedAt).toLocaleDateString("ko-KR")} · {workout.routeType ?? "러닝"}</small><h2>{(workout.actualDistanceMeters / 1_000).toFixed(2)} KM</h2><p>{Math.round(workout.movingSeconds / 60)}분 · {pace(workout.averagePaceSecondsPerKm)} /KM · 완료 {Math.round(workout.completionRatio * 100)}%</p></Link>)}</div>}</section></main>; }
export default function MyWorkoutsPage() { return <AuthRequired><MyWorkouts /></AuthRequired>; }
