"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCurrentUser } from "./useCurrentUser";

export function AuthRequired({ children }: { children: React.ReactNode }) {
  const auth = useCurrentUser();
  const pathname = usePathname();
  if (auth.status === "loading") return <main className="my-page"><div className="my-loading">계정을 확인하고 있습니다...</div></main>;
  if (auth.status === "authenticated") return <>{children}</>;
  return <main className="my-page"><section className="my-auth-gate"><small>PEROG ACCOUNT</small><h1>로그인이 필요한 기능입니다.</h1><p>저장한 경로와 러닝 기록은 카카오 계정에 안전하게 연결됩니다.</p><div><a href={`/api/auth/kakao?intent=login&returnTo=${encodeURIComponent(pathname)}`}>카카오로 로그인</a><Link href="/" className="my-auth-gate__secondary">홈으로</Link></div></section></main>;
}
