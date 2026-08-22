"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { setCurrentUserGuest, useCurrentUser } from "@/components/auth/useCurrentUser";

function initials(nickname: string | null): string {
  return nickname?.trim().slice(0, 1).toUpperCase() || "P";
}

export default function Header() {
  const auth = useCurrentUser();
  const router = useRouter();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const user = auth.status === "authenticated" ? auth.user : null;

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setIsMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsMenuOpen(false);
    }

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  async function logout() {
    setIsMenuOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } finally {
      setCurrentUserGuest();
      router.replace("/");
      router.refresh();
    }
  }

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-logo">
          PEROG
        </Link>

        <nav className="site-nav" aria-label="주요 메뉴">
          <Link href="/create">경로 만들기</Link>
          <Link href="/#product">기능</Link>
        </nav>

        {auth.status === "loading" ? (
          <span className="site-header__auth-skeleton" aria-label="로그인 상태 확인 중" />
        ) : !user ? (
          <div className="site-header__auth-actions">
            <a href="/api/auth/kakao?intent=login" className="site-header__login" aria-label="카카오로 로그인">로그인</a>
            <a href="/api/auth/kakao?intent=signup" className="site-header__cta" aria-label="카카오로 회원가입">회원가입</a>
          </div>
        ) : (
          <div className="site-account" ref={menuRef}>
            <button
              type="button"
              className="site-account__trigger"
              aria-expanded={isMenuOpen}
              aria-haspopup="menu"
              aria-label={`${user.nickname || "PEROG"} 계정 메뉴`}
              onClick={() => setIsMenuOpen((open) => !open)}
            >
              {user.profileImage ? (
                // Kakao controls this externally hosted profile image.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.profileImage} alt="" className="site-account__image" referrerPolicy="no-referrer" />
              ) : (
                <span className="site-account__fallback" aria-hidden="true">{initials(user.nickname)}</span>
              )}
              <span className="site-account__name">{user.nickname || "PEROG 러너"}</span>
            </button>
            {isMenuOpen ? (
              <div className="site-account__menu" role="menu">
                <Link href="/my/routes" role="menuitem" onClick={() => setIsMenuOpen(false)}>내 경로</Link>
                <Link href="/my/workouts" role="menuitem" onClick={() => setIsMenuOpen(false)}>러닝 기록</Link>
                <Link href="/my/settings" role="menuitem" onClick={() => setIsMenuOpen(false)}>설정</Link>
                <button type="button" role="menuitem" onClick={logout}>
                  로그아웃
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </header>
  );
}
