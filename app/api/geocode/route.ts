import { NextRequest, NextResponse } from "next/server";

type KakaoPlace = {
  id?: string;
  place_name?: string;
  address_name?: string;
  road_address_name?: string;
  x?: string;
  y?: string;
};

type KakaoKeywordResponse = { documents?: KakaoPlace[] };

const KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";

function finiteCoordinate(value: string | null, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.KAKAO_REST_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "KAKAO_REST_API_KEY가 설정되지 않았습니다." }, { status: 500 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim();

    if (!query || query.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const params = new URLSearchParams({ query, size: "8" });
    const latitude = finiteCoordinate(searchParams.get("lat"), -90, 90);
    const longitude = finiteCoordinate(searchParams.get("lon"), -180, 180);

    if (latitude !== null && longitude !== null) {
      params.set("x", String(longitude));
      params.set("y", String(latitude));
      params.set("radius", "20000");
      params.set("sort", "distance");
    }

    const response = await fetch(`${KAKAO_KEYWORD_URL}?${params.toString()}`, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      cache: "no-store",
    });

    if (!response.ok) {
      console.error("Kakao geocode HTTP error:", response.status);
      return NextResponse.json({ error: "장소 검색에 실패했습니다." }, { status: 502 });
    }

    const data = (await response.json()) as KakaoKeywordResponse;
    const results = (data.documents ?? []).flatMap((place, index) => {
      const latitude = Number(place.y);
      const longitude = Number(place.x);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return [];
      }

      return [{
        id: place.id ?? `kakao-${index}-${latitude}-${longitude}`,
        latitude,
        longitude,
        name: place.place_name?.trim() || query,
        address: place.road_address_name?.trim() || place.address_name?.trim() || "주소 정보 없음",
      }];
    });

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Kakao geocode error:", error);
    return NextResponse.json({ error: "장소 검색에 실패했습니다." }, { status: 500 });
  }
}
