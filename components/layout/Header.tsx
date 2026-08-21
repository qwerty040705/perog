import Link from "next/link";

export default function Header() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-logo">
          PEROG
        </Link>

        <nav className="site-nav" aria-label="주요 메뉴">
          <Link href="/discover">둘러보기</Link>
          <Link href="/create">경로 만들기</Link>
          <Link href="/glass">스마트글래스</Link>
          <Link href="/about">서비스 소개</Link>
        </nav>

        <Link href="/create" className="site-header__cta">
          경로 만들기
        </Link>
      </div>
    </header>
  );
}