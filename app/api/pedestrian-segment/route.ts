import { NextRequest, NextResponse } from "next/server";

type RoutePoint = {
  latitude: number;
  longitude: number;
};

type RequestBody = {
  start: RoutePoint;
  end: RoutePoint;
};

type KakaoWalkResponse = {
  status?: string;

  route?: {
    properties?: {
      totalDistance?: number;
      totalTime?: number;
    };

    legs?: {
      steps?: {
        path?: {
          points?: number[][];
        };
      }[];
    }[];
  };
};

const KAKAO_WALK_URL = "https://dapi.kakao.com/v2/routing/walk";
const KAKAO_REQUEST_TIMEOUT_MS = 12_000;

function validPoint(point: RoutePoint | undefined) {
  return Boolean(
    point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180
  );
}

function samePoint(a: RoutePoint, b: RoutePoint) {
  const tolerance = 1e-7;

  return (
    Math.abs(a.latitude - b.latitude) < tolerance && Math.abs(a.longitude - b.longitude) < tolerance
  );
}

export async function POST(request: NextRequest) {
  try {
    /*
     * ==================================================
     * Kakao REST API Key
     * ==================================================
     */

    const apiKey = process.env.KAKAO_REST_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          error: "KAKAO_REST_API_KEY가 설정되지 않았습니다.",
        },
        {
          status: 500,
        }
      );
    }

    /*
     * ==================================================
     * Request
     * ==================================================
     */

    const body = (await request.json()) as RequestBody;

    const { start, end } = body;

    /*
     * ==================================================
     * Validation
     * ==================================================
     */

    if (!validPoint(start) || !validPoint(end)) {
      return NextResponse.json(
        {
          error: "올바른 시작점과 끝점이 필요합니다.",
        },
        {
          status: 400,
        }
      );
    }

    /*
     * 같은 점이면 Kakao에서 SAME_POINT가 발생하므로
     * 미리 차단.
     */
    if (samePoint(start, end)) {
      return NextResponse.json(
        {
          error: "시작점과 끝점이 너무 가깝습니다. 서로 다른 위치를 선택해주세요.",
        },
        {
          status: 400,
        }
      );
    }

    /*
     * ==================================================
     * Kakao Walking API
     * ==================================================
     *
     * Kakao:
     *
     * x = longitude
     * y = latitude
     */

    const params = new URLSearchParams({
      start_x: String(start.longitude),

      start_y: String(start.latitude),

      end_x: String(end.longitude),

      end_y: String(end.latitude),

      input_coord: "WGS84",

      output_coord: "WGS84",

      route_mode: "SHORTEST",
    });

    const response = await fetch(`${KAKAO_WALK_URL}?${params.toString()}`, {
      method: "GET",

      headers: {
        Authorization: `KakaoAK ${apiKey}`,
      },

      cache: "no-store",
      signal: AbortSignal.timeout(KAKAO_REQUEST_TIMEOUT_MS),
    });

    /*
     * Kakao가 JSON이 아닌 값을 반환할 가능성까지 방어.
     */
    const rawText = await response.text();

    let data: KakaoWalkResponse;

    try {
      data = JSON.parse(rawText) as KakaoWalkResponse;
    } catch {
      console.log("Kakao pedestrian segment raw response:", rawText);

      throw new Error("카카오 보행 API 응답을 해석하지 못했습니다.");
    }

    /*
     * ==================================================
     * HTTP Error
     * ==================================================
     */

    if (!response.ok) {
      console.log("Kakao pedestrian segment HTTP error:", response.status, data);

      throw new Error(`카카오 보행 API 오류: HTTP ${response.status}`);
    }

    /*
     * ==================================================
     * Kakao status
     * ==================================================
     */

    if (data.status !== "OK" || !data.route) {
      console.log("Kakao pedestrian segment failed:", data);

      throw new Error(`보행 구간을 찾지 못했습니다. status=${data.status ?? "UNKNOWN"}`);
    }

    /*
     * ==================================================
     * Route polyline 추출
     * ==================================================
     *
     * path.points:
     *
     * [
     *   [longitude, latitude],
     *   ...
     * ]
     */

    const route: RoutePoint[] = [];

    for (const leg of data.route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        for (const point of step.path?.points ?? []) {
          if (!Array.isArray(point) || point.length < 2) {
            continue;
          }

          const longitude = Number(point[0]);

          const latitude = Number(point[1]);

          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            continue;
          }

          /*
           * step 경계에서 중복 좌표 제거.
           */
          const previous = route[route.length - 1];

          if (
            previous &&
            Math.abs(previous.latitude - latitude) < 1e-10 &&
            Math.abs(previous.longitude - longitude) < 1e-10
          ) {
            continue;
          }

          route.push({
            latitude,
            longitude,
          });
        }
      }
    }

    /*
     * ==================================================
     * Distance / Duration
     * ==================================================
     */

    const distanceMeters = data.route.properties?.totalDistance;

    const durationSeconds = data.route.properties?.totalTime;

    if (
      route.length < 2 ||
      typeof distanceMeters !== "number" ||
      !Number.isFinite(distanceMeters)
    ) {
      throw new Error("카카오 보행 구간을 계산하지 못했습니다.");
    }

    /*
     * ==================================================
     * Response
     * ==================================================
     *
     * RequiredSegmentPickerModal과 호환되는 응답 구조를 유지한다.
     */

    return NextResponse.json({
      route,

      distanceKm: distanceMeters / 1000,

      durationSeconds:
        typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
          ? durationSeconds
          : null,

      costing: "pedestrian",

      provider: "kakao",
    });
  } catch (error) {
    console.log("Kakao pedestrian segment error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "필수 구간 생성 중 오류가 발생했습니다.",
      },
      {
        status: 500,
      }
    );
  }
}
