"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { useCurrentUser } from "@/components/auth/useCurrentUser";
import Header from "@/components/layout/Header";
import { DeviceDataMigration } from "@/components/auth/DeviceDataMigration";
import { ActiveWorkoutBanner } from "@/components/auth/ActiveWorkoutBanner";

function RouteProductVisual() {
  return (
    <div className="landing-route-visual" aria-label="PEROG가 생성한 10.02킬로미터 순환 러닝 경로 예시">
      <div className="landing-route-visual__grid" />
      <div className="landing-route-visual__topline">
        <span>PEROG / ROUTE PREVIEW</span>
        <span className="landing-route-visual__live"><i /> LIVE</span>
      </div>
      <svg viewBox="0 0 640 480" role="img" aria-label="강변을 따라 생성된 순환 러닝 경로">
        <path className="landing-route-visual__water" d="M478 0 C433 88 517 156 461 258 C431 313 453 390 408 480" />
        <path className="landing-route-visual__street" d="M-20 110 L204 245 L395 122 L660 215" />
        <path className="landing-route-visual__street landing-route-visual__street--thin" d="M72 470 L244 311 L385 382 L602 293" />
        <path className="landing-route-visual__street landing-route-visual__street--thin" d="M115 31 L209 175 L150 326 L344 452" />
        <path className="landing-route-visual__route-shadow" d="M145 354 C77 300 120 172 219 152 C320 131 367 187 399 251 C430 314 379 386 281 395 C203 402 183 380 145 354" />
        <path className="landing-route-visual__route" d="M145 354 C77 300 120 172 219 152 C320 131 367 187 399 251 C430 314 379 386 281 395 C203 402 183 380 145 354" />
        <circle className="landing-route-visual__start-pulse" cx="145" cy="354" r="19" />
        <circle className="landing-route-visual__start" cx="145" cy="354" r="13" />
        <text x="145" y="358" textAnchor="middle">A</text>
        <circle className="landing-route-visual__waypoint" cx="399" cy="251" r="7" />
        <circle className="landing-route-visual__runner" cx="310" cy="389" r="6" />
      </svg>
      <div className="landing-route-visual__metric landing-route-visual__metric--distance"><span>DISTANCE</span><strong>10.02 <small>KM</small></strong></div>
      <div className="landing-route-visual__metric landing-route-visual__metric--match"><span>ROUTE MATCH</span><strong>94<small>%</small></strong></div>
      <div className="landing-route-visual__scenery">WATERFRONT</div>
    </div>
  );
}

type AuthNotice = "kakao" | "account_not_found" | "state" | "signup" | null;
const authNoticeMessages: Record<Exclude<AuthNotice, null>, string> = {
  kakao: "카카오 로그인을 완료하지 못했습니다.",
  account_not_found: "등록된 PEROG 계정이 없습니다. 회원가입을 진행해주세요.",
  state: "로그인 요청이 만료되었습니다. 다시 시도해주세요.",
  signup: "PEROG에 오신 것을 환영합니다.",
};

function readAuthNotice(): AuthNotice {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const error = params.get("authError");
  if (error === "kakao" || error === "account_not_found" || error === "state") return error;
  return params.get("authSuccess") === "signup" ? "signup" : null;
}

function subscribeToLocation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

export default function Home() {
  const auth = useCurrentUser();
  const authNotice = useSyncExternalStore(subscribeToLocation, readAuthNotice, () => null);

  useEffect(() => {
    if (!authNotice) return;
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("authError");
      url.searchParams.delete("authSuccess");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [authNotice]);

  const greeting = auth.status === "authenticated" && auth.user.nickname
    ? `${auth.user.nickname}님, 오늘은 어떤 경로를 달릴까요?`
    : null;

  return (
    <>
      <Header />
      <main className="landing">
        {authNotice ? <p className={`landing-auth-notice${authNotice === "signup" ? " landing-auth-notice--success" : ""}`} role="status">{authNotice === "signup" && auth.status === "authenticated" && auth.user.nickname ? `${auth.user.nickname}님, PEROG에 오신 것을 환영합니다.` : authNoticeMessages[authNotice]}</p> : null}
        <DeviceDataMigration />
        <ActiveWorkoutBanner />
        <section className="landing-hero">
          <div className="landing-hero__copy">
            <p className="landing-eyebrow"><span /> PERSONALIZED OUTDOOR ROUTING</p>
            {greeting ? <p className="landing-hero__greeting">{greeting}</p> : null}
            <h1>내가 원하는 운동,<br /><em>내게 맞는 경로.</em></h1>
            <p className="landing-hero__description">거리, 환경, 경로 형태와 선호 조건을 선택하면<br />PEROG가 나만의 러닝 경로를 생성합니다.</p>
            <div className="landing-hero__actions">
              <Link href="/create" className="landing-button landing-button--primary">내 경로 만들기 <span aria-hidden="true">→</span></Link>
              {auth.status !== "authenticated" ? <><a href="/api/auth/kakao?intent=login" className="landing-button landing-button--secondary">카카오로 로그인</a><span className="landing-signup-copy">처음이신가요? <a href="/api/auth/kakao?intent=signup">카카오로 회원가입</a></span></> : <a href="#product" className="landing-button landing-button--secondary">PEROG 기능 보기</a>}
            </div>
            <p className="landing-hero__note">로그인 없이도 바로 경로를 만들 수 있습니다.</p>
          </div>
          <RouteProductVisual />
        </section>

        <section className="landing-why" aria-labelledby="why-title">
          <div className="landing-section-heading">
            <p className="landing-eyebrow"><span /> WHY PEROG</p>
            <h2 id="why-title">목적지를 찾지 마세요.<br /><em>나에게 맞는 경로를 만드세요.</em></h2>
            <p>기존 내비게이션은 도착할 곳을 묻습니다. PEROG는 어떻게 운동하고 싶은지부터 묻습니다.</p>
          </div>
          <div className="landing-comparison">
            <article className="landing-comparison__item"><p>GENERAL NAVIGATION</p><div className="landing-comparison__line"><b>A</b><span /><i>→</i><span /><b>B</b></div><h3>“어디로 갈까요?”</h3><span>목적지까지의 최적 경로</span></article>
            <article className="landing-comparison__item landing-comparison__item--perog"><p>PEROG</p><svg viewBox="0 0 300 120" aria-hidden="true"><path d="M64 87 C39 46 95 24 145 48 C182 66 191 99 226 87 C261 75 260 36 224 32 C182 28 192 71 157 91 C119 113 84 100 64 87" /><circle cx="64" cy="87" r="6" /></svg><h3>“어떻게 운동하고 싶나요?”</h3><span>운동 조건에 맞는 개인화 경로</span></article>
          </div>
        </section>

        <section className="landing-preferences" aria-label="개인화 경로 생성 방식">
          <p className="landing-eyebrow"><span /> BUILT FROM YOUR PREFERENCE</p>
          <div className="landing-preferences__flow"><span><small>DISTANCE</small><b>10 KM</b></span><i>·</i><span><small>TERRAIN</small><b>FLAT</b></span><i>·</i><span><small>ENVIRONMENT</small><b>WATERFRONT</b></span><i>·</i><span><small>ROUTE TYPE</small><b>LOOP</b></span><strong>→</strong><em>PERSONALIZED ROUTE</em></div>
        </section>

        <section className="landing-product" id="product" aria-labelledby="product-title">
          <div className="landing-section-heading"><p className="landing-eyebrow"><span /> PRODUCT</p><h2 id="product-title">계획하고, 달리고,<br /><em>더 나답게 맞춰집니다.</em></h2></div>
          <div className="landing-product__steps">
            <article><b>01</b><h3>GENERATE</h3><p>거리와 선호 조건을 바탕으로 실제 걸을 수 있는 경로를 생성합니다.</p></article>
            <article><b>02</b><h3>NAVIGATE</h3><p>카메라와 GPS를 이용해 러닝 중에도 다음 방향을 간결하게 안내합니다.</p></article>
            <article><b>03</b><h3>ADAPT</h3><p>러닝 기록과 선호를 기반으로, 앞으로의 개인화를 준비합니다.</p></article>
          </div>
        </section>

        <section className="landing-future" aria-labelledby="future-title"><p className="landing-eyebrow"><span /> BUILT FOR THE NEXT INTERFACE</p><h2 id="future-title">Phone today.<br /><em>Smart glasses tomorrow.</em></h2><p>PEROG는 현재 휴대폰에서 동작하며, 앞으로 wearable과 AR 인터페이스로 확장될 개인화 outdoor navigation을 설계합니다.</p></section>
        <section className="landing-final"><p className="landing-eyebrow"><span /> READY WHEN YOU ARE</p><h2>오늘 달릴 경로를<br /><em>만들어보세요.</em></h2><Link href="/create" className="landing-button landing-button--primary">내 경로 만들기 <span aria-hidden="true">→</span></Link></section>
      </main>
      <footer className="landing-footer"><span>PEROG</span><small>PERSONALIZED ROUTE GENERATION</small><small>© 2026 PEROG</small></footer>
    </>
  );
}
