"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AuthRequired } from "@/components/auth/AuthRequired";
import Header from "@/components/layout/Header";

type Route = { id: string; name: string; routeType: "순환형" | "왕복형" | "편도형" | null; route: { latitude: number; longitude: number }[]; navigationSteps: { progressMeters: number; distanceMeters: number; guidance: string }[]; summary: { distanceMeters: number }; start: { latitude: number; longitude: number; name: string; address: string } | null; destination: { latitude: number; longitude: number; name: string; address: string } | null };

function RouteDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch(`/api/routes/${id}`, { cache: "no-store" }).then(async (response) => { const data = await response.json() as { route?: Route; error?: string }; if (!response.ok || !data.route) throw new Error(data.error); setRoute(data.route); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "경로를 불러오지 못했습니다.")); }, [id]);
  const start = useCallback(() => { if (!route) return; sessionStorage.setItem("perog-navigation-route", JSON.stringify({ route: route.route, routeType: route.routeType, distanceKm: route.summary.distanceMeters / 1_000, start: route.start, destination: route.destination, navigationSteps: route.navigationSteps, routeId: route.id })); router.push("/navigate"); }, [route, router]);
  useEffect(() => { if (route && search.get("start") === "1") start(); }, [route, search, start]);
  return <main className="my-page"><Header /><section className="my-content">{error ? <p className="my-error">{error}</p> : !route ? <p className="my-loading">경로를 불러오고 있습니다...</p> : <><p className="landing-eyebrow"><span /> SAVED ROUTE</p><h1>{route.name}</h1><p className="my-route-distance">{(route.summary.distanceMeters / 1_000).toFixed(2)} KM · {route.routeType ?? "러닝"}</p><div className="my-route-preview"><svg viewBox="0 0 400 160" aria-hidden="true"><path d="M30 120 C80 20 150 20 210 85 C260 140 315 130 370 42" /></svg></div><button className="my-save" type="button" onClick={start}>이 경로로 러닝 시작</button><Link className="my-back" href="/my/routes">내 경로로 돌아가기</Link></>}</section></main>;
}
export default function MyRouteDetailPage() { return <AuthRequired><RouteDetail /></AuthRequired>; }
