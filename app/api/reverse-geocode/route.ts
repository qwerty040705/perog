import { NextRequest, NextResponse } from "next/server";

type KakaoAddress = { address_name?: string; building_name?: string };
type KakaoCoordAddressResponse = {
  documents?: { address?: KakaoAddress | null; road_address?: KakaoAddress | null }[];
};

const KAKAO_COORD_TO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/geo/coord2address.json";

export async function GET(request: NextRequest) {
  const apiKey = process.env.KAKAO_REST_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "KAKAO_REST_API_KEY가 설정되지 않았습니다." }, { status: 500 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const latitude = Number(searchParams.get("lat"));
    const longitude = Number(searchParams.get("lon"));

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return NextResponse.json({ error: "올바른 좌표가 필요합니다." }, { status: 400 });
    }

    const params = new URLSearchParams({ x: String(longitude), y: String(latitude), input_coord: "WGS84" });
    const response = await fetch(`${KAKAO_COORD_TO_ADDRESS_URL}?${params.toString()}`, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      cache: "no-store",
    });

    if (!response.ok) {
      console.error("Kakao reverse geocode HTTP error:", response.status);
      return NextResponse.json({ error: "주소 조회에 실패했습니다." }, { status: 502 });
    }

    const document = ((await response.json()) as KakaoCoordAddressResponse).documents?.[0];
    const roadAddress = document?.road_address;
    const address = document?.address;
    const resolvedAddress = roadAddress?.address_name || address?.address_name || "주소 정보 없음";

    return NextResponse.json({
      location: {
        name: roadAddress?.building_name || resolvedAddress,
        address: resolvedAddress,
      },
    });
  } catch (error) {
    console.error("Kakao reverse geocode error:", error);
    return NextResponse.json({ error: "주소 조회에 실패했습니다." }, { status: 500 });
  }
}
