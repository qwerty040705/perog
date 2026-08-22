"use client";

let sdkPromise: Promise<typeof kakao.maps> | null = null;

export function loadKakaoMapsSdk(): Promise<typeof kakao.maps> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("브라우저에서만 카카오 지도를 불러올 수 있습니다."));
  }

  if (sdkPromise) {
    return sdkPromise;
  }

  sdkPromise = new Promise<typeof kakao.maps>((resolve, reject) => {
    const finishLoad = () => {
      const maps = window.kakao?.maps;

      if (!maps) {
        reject(new Error("카카오 지도 SDK를 불러오지 못했습니다."));
        return;
      }

      maps.load(() => resolve(maps));
    };

    if (window.kakao?.maps) {
      finishLoad();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-perog-kakao-maps="true"]');

    if (existing) {
      existing.addEventListener("load", finishLoad, { once: true });
      existing.addEventListener("error", () => reject(new Error("카카오 지도 SDK 로드에 실패했습니다.")), { once: true });
      return;
    }

    const appKey = process.env.NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY;

    if (!appKey) {
      reject(new Error("NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY가 설정되지 않았습니다."));
      return;
    }

    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false`;
    script.async = true;
    script.dataset.perogKakaoMaps = "true";
    script.addEventListener("load", finishLoad, { once: true });
    script.addEventListener("error", () => reject(new Error("카카오 지도 SDK 로드에 실패했습니다.")), { once: true });
    document.head.appendChild(script);
  });

  return sdkPromise.catch((error: unknown) => {
    sdkPromise = null;
    throw error;
  });
}
