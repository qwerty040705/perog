"use client";

import Link from "next/link";
import { useCurrentUser } from "./useCurrentUser";
import type { AuthResultType } from "@/lib/auth";

type ResultCopy = {
  title: string;
  description: string;
  primaryHref: string;
  primaryLabel: string;
};

const resultCopy: Record<AuthResultType, ResultCopy> = {
  account_not_found: {
    title: "등록된 PEROG 계정이 없습니다.",
    description: "카카오 계정을 선택했지만 아직 PEROG 회원가입이 완료되지 않았습니다.",
    primaryHref: "/api/auth/kakao?intent=signup",
    primaryLabel: "카카오로 회원가입",
  },
  already_registered: {
    title: "이미 가입된 카카오 계정입니다.",
    description: "로그인 후 기존 경로와 러닝 기록을 이어서 사용할 수 있습니다.",
    primaryHref: "/api/auth/kakao?intent=login",
    primaryLabel: "카카오로 로그인",
  },
  signup_success: {
    title: "PEROG 회원가입이 완료되었습니다.",
    description: "PEROG에서 나만의 러닝 경로를 만들어보세요.",
    primaryHref: "/create",
    primaryLabel: "시작하기",
  },
  login_error: {
    title: "카카오 로그인을 완료하지 못했습니다.",
    description: "잠시 후 다시 시도해주세요. 문제가 계속되면 Kakao 로그인 설정을 확인해주세요.",
    primaryHref: "/api/auth/kakao?intent=login",
    primaryLabel: "카카오로 로그인",
  },
};

export function AuthResultContent({ type }: { type: AuthResultType }) {
  const auth = useCurrentUser();
  const copy = resultCopy[type];
  const description = type === "signup_success" && auth.status === "authenticated" && auth.user.nickname
    ? `${auth.user.nickname}님, PEROG에 오신 것을 환영합니다.`
    : copy.description;

  return (
    <main className="auth-result-page">
      <section className="auth-result-card" aria-labelledby="auth-result-title">
        <p className="auth-result-card__eyebrow">PEROG ACCOUNT</p>
        <h1 id="auth-result-title">{copy.title}</h1>
        <p>{description}</p>
        <div className="auth-result-card__actions">
          {copy.primaryHref.startsWith("/api/auth/") ? (
            <a href={copy.primaryHref}>{copy.primaryLabel}</a>
          ) : (
            <Link href={copy.primaryHref}>{copy.primaryLabel}</Link>
          )}
          <Link href="/" className="auth-result-card__secondary">홈으로</Link>
        </div>
      </section>
    </main>
  );
}
