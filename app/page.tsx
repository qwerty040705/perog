import Link from "next/link";
import Header from "@/components/layout/Header";

export default function Home() {
  return (
    <>
      <Header />

      <main>
        <section className="hero">
          <div className="hero__glow" />

          <div className="hero__content">
            <div className="hero__eyebrow">
              <span className="hero__eyebrow-dot" />
              나만을 위한 아웃도어 코스
            </div>

            <h1 className="hero__title">
              내가 원하는 운동,
              <br />
              <span>내게 맞는 경로.</span>
            </h1>

            <p className="hero__description">
              거리, 지형, 환경과 선호 조건을 선택하세요. PEROG가 나만의 아웃도어 경로를
              만들어드립니다.
            </p>

            <div className="hero__actions">
              <Link href="/create" className="hero__primary">
                내 경로 만들기
                <span aria-hidden="true">→</span>
              </Link>

              <Link href="/discover" className="hero__secondary">
                경로 둘러보기
              </Link>
            </div>
          </div>

          <div className="hero__visual" aria-hidden="true">
            <div className="route-visual">
              <svg viewBox="0 0 760 300" className="route-visual__svg" role="presentation">
                <path
                  className="route-visual__ghost"
                  d="M82 204 C142 108 210 114 264 174 C312 228 363 232 409 172 C462 103 523 84 582 123 C630 155 651 210 685 189"
                />

                <path
                  className="route-visual__route"
                  d="M82 204 C142 108 210 114 264 174 C312 228 363 232 409 172 C462 103 523 84 582 123 C630 155 651 210 685 189"
                />

                <circle className="route-visual__start-ring" cx="82" cy="204" r="11" />
                <circle className="route-visual__start" cx="82" cy="204" r="5" />

                <circle className="route-visual__point" cx="409" cy="172" r="4" />

                <circle className="route-visual__finish-ring" cx="685" cy="189" r="11" />
                <circle className="route-visual__finish" cx="685" cy="189" r="5" />
              </svg>

              <div className="route-visual__metric route-visual__metric--distance">
                <span>10.0</span>
                <small>KM</small>
              </div>

              <div className="route-visual__metric route-visual__metric--match">
                <span>94%</span>
                <small>경로 적합도</small>
              </div>
            </div>
          </div>

          <div className="hero__scroll">
            <span />
            아래로 스크롤
          </div>
        </section>
        <section className="difference">
          <div className="difference__inner">
            <div className="difference__heading">
              <div className="section-label">
                <span />
                WHY PEROG
              </div>

              <h2>
                목적지를 찾지 마세요.
                <br />
                <strong>나에게 맞는 경로를 만드세요.</strong>
              </h2>

              <p>
                기존 내비게이션은 목적지까지 가는 길을 찾습니다.
                <br />
                PEROG는 내가 원하는 운동을 위한 길을 만듭니다.
              </p>
            </div>

            <div className="difference__comparison">
              <article className="comparison-card comparison-card--normal">
                <div className="comparison-card__top">
                  <span>일반 내비게이션</span>
                  <small>A → B</small>
                </div>

                <div className="comparison-card__visual">
                  <div className="normal-route">
                    <span className="normal-route__point">A</span>
                    <div className="normal-route__line" />
                    <span className="normal-route__arrow">→</span>
                    <div className="normal-route__line" />
                    <span className="normal-route__point">B</span>
                  </div>
                </div>

                <div className="comparison-card__bottom">
                  <span className="comparison-card__question">“어디로 갈까요?”</span>

                  <p>
                    목적지를 입력하면
                    <br />
                    그곳까지의 경로를 안내합니다.
                  </p>
                </div>
              </article>

              <article className="comparison-card comparison-card--perog">
                <div className="comparison-card__top">
                  <span>PEROG</span>
                  <small>PERSONALIZED ROUTE</small>
                </div>

                <div className="comparison-card__visual">
                  <svg className="perog-loop" viewBox="0 0 400 190" aria-hidden="true">
                    <path
                      className="perog-loop__glow"
                      d="M70 132 C52 76 112 43 166 70 C208 91 218 142 265 142 C313 142 344 105 329 70 C311 30 245 35 222 74 C194 122 168 153 122 151 C95 150 78 143 70 132"
                    />

                    <path
                      className="perog-loop__line"
                      d="M70 132 C52 76 112 43 166 70 C208 91 218 142 265 142 C313 142 344 105 329 70 C311 30 245 35 222 74 C194 122 168 153 122 151 C95 150 78 143 70 132"
                    />

                    <circle className="perog-loop__ring" cx="70" cy="132" r="10" />

                    <circle className="perog-loop__dot" cx="70" cy="132" r="4" />
                  </svg>
                </div>

                <div className="comparison-card__bottom">
                  <span className="comparison-card__question">“어떻게 운동하고 싶나요?”</span>

                  <p>
                    운동 목표와 선호 조건을 입력하면
                    <br />
                    나에게 맞는 경로를 생성합니다.
                  </p>
                </div>
              </article>
            </div>

            <div className="preference-flow">
              <div className="preference-flow__item">
                <small>DISTANCE</small>
                <strong>10 KM</strong>
              </div>

              <span className="preference-flow__plus">+</span>

              <div className="preference-flow__item">
                <small>TERRAIN</small>
                <strong>평지</strong>
              </div>

              <span className="preference-flow__plus">+</span>

              <div className="preference-flow__item">
                <small>ENVIRONMENT</small>
                <strong>강변</strong>
              </div>

              <span className="preference-flow__plus">+</span>

              <div className="preference-flow__item">
                <small>ROUTE TYPE</small>
                <strong>순환형</strong>
              </div>

              <span className="preference-flow__arrow">→</span>

              <div className="preference-flow__result">
                <small>PEROG</small>
                <strong>나만의 경로</strong>
              </div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
