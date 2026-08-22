"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthRequired } from "@/components/auth/AuthRequired";
import Header from "@/components/layout/Header";

type SavedRoute = { id: string; name: string; routeType: string | null; summary: { distanceMeters: number }; isFavorite: boolean; runCount: number; createdAt: string };

function MyRoutes() {
  const [routes, setRoutes] = useState<SavedRoute[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch("/api/routes", { cache: "no-store" }).then(async (response) => { const data = await response.json() as { routes?: SavedRoute[]; error?: string }; if (!response.ok) throw new Error(data.error); setRoutes(data.routes ?? []); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "경로를 불러오지 못했습니다.")); }, []);
  const update = async (route: SavedRoute, payload: Record<string, unknown>) => { const response = await fetch(`/api/routes/${route.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); if (response.ok) setRoutes((current) => current?.map((item) => item.id === route.id ? { ...item, ...payload } : item) ?? null); };
  const remove = async (route: SavedRoute) => { if (!confirm("이 경로를 삭제할까요?")) return; const response = await fetch(`/api/routes/${route.id}`, { method: "DELETE" }); if (response.ok) setRoutes((current) => current?.filter((item) => item.id !== route.id) ?? null); };
  return <main className="my-page"><Header /><section className="my-content"><p className="landing-eyebrow"><span /> MY ROUTES</p><h1>내 경로</h1>{error ? <p className="my-error">{error}</p> : routes === null ? <p className="my-loading">경로를 불러오고 있습니다...</p> : routes.length === 0 ? <div className="my-empty"><h2>아직 저장한 경로가 없습니다.</h2><Link href="/create">첫 경로 만들기</Link></div> : <div className="my-list">{routes.map((route) => <article key={route.id}><div><small>{route.routeType ?? "러닝"} · {new Date(route.createdAt).toLocaleDateString("ko-KR")}</small><h2>{route.name}</h2><p>{(route.summary.distanceMeters / 1_000).toFixed(2)} KM · {route.runCount}회 러닝</p></div><div className="my-list__actions"><Link href={`/my/routes/${route.id}`}>다시 보기</Link><Link href={`/my/routes/${route.id}?start=1`}>러닝 시작</Link><button type="button" onClick={() => update(route, { isFavorite: !route.isFavorite })}>{route.isFavorite ? "★" : "☆"}</button><button type="button" onClick={() => remove(route)}>삭제</button></div></article>)}</div>}</section></main>;
}
export default function MyRoutesPage() { return <AuthRequired><MyRoutes /></AuthRequired>; }
