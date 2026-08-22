"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Header from "@/components/layout/Header";
import { useCurrentUser } from "@/components/auth/useCurrentUser";
import { useRouter } from "next/navigation";

const RouteMap = dynamic(() => import("@/components/map/RouteMap"), { ssr: false });

const LocationPickerModal = dynamic(() => import("@/components/map/LocationPickerModal"), {
  ssr: false,
});

const RequiredSegmentPickerModal = dynamic(
  () => import("@/components/map/RequiredSegmentPickerModal"),
  {
    ssr: false,
  }
);

type SelectedLocation = {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
};

type RoutePoint = {
  latitude: number;
  longitude: number;
};

type RouteType = "순환형" | "왕복형" | "편도형";

type SignalPreference = "상관없음" | "적게" | "최소화";

type PickerMode = "gps" | "map";

type SearchResult = SelectedLocation & {
  id: string;
};

type RequiredWaypoint = {
  id: string;
  type: "waypoint";
  location: SelectedLocation;
};

type RequiredSegment = {
  id: string;
  type: "segment";
  start: SelectedLocation;
  end: SelectedLocation;
  route: RoutePoint[];
  distanceKm: number;
};

type RequiredItem = RequiredWaypoint | RequiredSegment;

type LocationTarget =
  | {
      kind: "base";
      target: "A" | "B";
    }
  | {
      kind: "waypoint-add";
    }
  | {
      kind: "waypoint-edit";
      id: string;
    }
  | null;

type RouteApiResponse = {
  route?: RoutePoint[];
  navigationSteps?: { progressMeters: number; distanceMeters: number; guidance: string }[];

  summary?: {
    targetDistanceKm?: number | null;
    distanceKm?: number;
    distanceErrorKm?: number | null;
    distanceErrorPercent?: number | null;
    durationSeconds?: number | null;
    routeType?: RouteType;
    costing?: string;
    overlapRatio?: number | null;
  };

  error?: string;
};

const routeTypes: RouteType[] = ["순환형", "왕복형", "편도형"];

const sceneryOptions = ["수변", "공원·녹지", "도심", "자연"];

const signalOptions: SignalPreference[] = ["상관없음", "적게", "최소화"];

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type");

  if (!contentType?.includes("application/json")) {
    const text = await response.text();

    console.error("Expected JSON:", text);

    throw new Error(`API 오류: HTTP ${response.status}`);
  }

  return response.json();
}

export default function CreatePage() {
  const router = useRouter();
  const auth = useCurrentUser();
  /*
   * ==================================================
   * 기본 설정
   * ==================================================
   */

  const [routeType, setRouteType] = useState<RouteType | null>(null);

  const [distanceInput, setDistanceInput] = useState("");

  const [minElevationInput, setMinElevationInput] = useState("");

  const [maxElevationInput, setMaxElevationInput] = useState("");

  const [sceneries, setSceneries] = useState<string[]>([]);

  const [signalPreference, setSignalPreference] = useState<SignalPreference | null>(null);

  /*
   * ==================================================
   * A / B
   * ==================================================
   */

  const [locationA, setLocationA] = useState<SelectedLocation | null>(null);

  const [locationB, setLocationB] = useState<SelectedLocation | null>(null);

  /*
   * ==================================================
   * 필수 요소
   *
   * 하나의 배열에 저장하는 이유:
   * 사용자가 추가한 순서를 그대로 유지하기 위함.
   * ==================================================
   */

  const [requiredItems, setRequiredItems] = useState<RequiredItem[]>([]);

  /*
   * ==================================================
   * 위치 선택 modal
   * ==================================================
   */

  const [pickerOpen, setPickerOpen] = useState(false);

  const [pickerMode, setPickerMode] = useState<PickerMode>("map");

  const [locationTarget, setLocationTarget] = useState<LocationTarget>(null);

  /*
   * ==================================================
   * 필수 구간 modal
   * ==================================================
   */

  const [segmentPickerOpen, setSegmentPickerOpen] = useState(false);

  /*
   * ==================================================
   * 장소 검색
   * ==================================================
   */

  const [searchTarget, setSearchTarget] = useState<LocationTarget>(null);

  const [searchQuery, setSearchQuery] = useState("");

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const [isSearching, setIsSearching] = useState(false);

  /*
   * ==================================================
   * Route 결과
   * ==================================================
   */

  const [generatedRoute, setGeneratedRoute] = useState<RoutePoint[] | null>(null);
  const [navigationSteps, setNavigationSteps] = useState<{ progressMeters: number; distanceMeters: number; guidance: string }[]>([]);

  const [actualDistance, setActualDistance] = useState<number | null>(null);

  const [distanceErrorPercent, setDistanceErrorPercent] = useState<number | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);
  const [savedRouteId, setSavedRouteId] = useState<string | null>(null);
  const [isSavingRoute, setIsSavingRoute] = useState(false);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    let active = true;
    void fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ preferences?: { preferredRouteTypes?: string[]; preferredSceneries?: string[]; defaultDistanceKm?: number | null } }> : null)
      .then((data) => {
        if (!active || !data?.preferences) return;
        if (data.preferences.defaultDistanceKm) setDistanceInput((current) => current || String(data.preferences?.defaultDistanceKm));
        if (data.preferences.preferredSceneries?.length) setSceneries((current) => current.length === 0 ? data.preferences?.preferredSceneries ?? current : current);
        const preferredType = data.preferences.preferredRouteTypes?.[0];
        if (preferredType === "순환형" || preferredType === "왕복형" || preferredType === "편도형") setRouteType((current) => current ?? preferredType);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [auth.status]);

  /*
   * ==================================================
   * Route 초기화
   * ==================================================
   */

  const clearGeneratedRoute = () => {
    setGeneratedRoute(null);
    setNavigationSteps([]);
    setActualDistance(null);
    setDistanceErrorPercent(null);
    setSavedRouteId(null);
  };

  /*
   * ==================================================
   * 장소 검색
   * ==================================================
   */

  useEffect(() => {
    if (!searchTarget || searchQuery.trim().length < 2) {
      const clearTimer = window.setTimeout(() => setSearchResults([]), 0);
      return () => window.clearTimeout(clearTimer);
    }

    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        setIsSearching(true);

        const params = new URLSearchParams({
          q: searchQuery.trim(),
        });

        if (locationA) {
          params.set("lat", String(locationA.latitude));
          params.set("lon", String(locationA.longitude));
        }

        const response = await fetch(`/api/geocode?${params.toString()}`, { signal: controller.signal });

        const data = await readJsonResponse(response);

        if (!response.ok) {
          if (active) setSearchResults([]);
          return;
        }

        if (active) setSearchResults(data.results ?? []);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Place search failed:", error);

        if (active) setSearchResults([]);
      } finally {
        if (active) setIsSearching(false);
      }
    }, 350);

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [searchQuery, searchTarget, locationA]);

  /*
   * ==================================================
   * 경로 형태
   * ==================================================
   */

  const handleRouteTypeChange = (value: RouteType) => {
    setRouteType(value);

    setLocationA(null);
    setLocationB(null);

    setRequiredItems([]);

    setDistanceInput("");

    setSearchTarget(null);
    setSearchQuery("");
    setSearchResults([]);

    clearGeneratedRoute();
  };

  /*
   * ==================================================
   * 위치 선택
   * ==================================================
   */

  const openLocationPicker = (target: LocationTarget, mode: PickerMode) => {
    setLocationTarget(target);

    setPickerMode(mode);

    setPickerOpen(true);

    setSearchTarget(null);
    setSearchQuery("");
    setSearchResults([]);
  };

  const closeLocationPicker = () => {
    setPickerOpen(false);
    setLocationTarget(null);
  };

  const applyLocation = (target: LocationTarget, location: SelectedLocation) => {
    if (!target) {
      return;
    }

    if (target.kind === "base") {
      if (target.target === "A") {
        setLocationA(location);
      } else {
        setLocationB(location);
      }
    }

    if (target.kind === "waypoint-add") {
      setRequiredItems((current) => [
        ...current,
        {
          id: createId(),
          type: "waypoint",
          location,
        },
      ]);
    }

    if (target.kind === "waypoint-edit") {
      setRequiredItems((current) =>
        current.map((item) => {
          if (item.id !== target.id || item.type !== "waypoint") {
            return item;
          }

          return {
            ...item,
            location,
          };
        })
      );
    }

    clearGeneratedRoute();
  };

  const confirmPickedLocation = (location: SelectedLocation) => {
    applyLocation(locationTarget, location);

    closeLocationPicker();
  };

  /*
   * ==================================================
   * 장소 검색
   * ==================================================
   */

  const openSearch = (target: LocationTarget) => {
    setSearchTarget(target);

    setSearchQuery("");
    setSearchResults([]);
  };

  const closeSearch = () => {
    setSearchTarget(null);
    setSearchQuery("");
    setSearchResults([]);
  };

  const selectSearchResult = (result: SearchResult) => {
    applyLocation(searchTarget, result);

    closeSearch();
  };

  /*
   * ==================================================
   * 필수 구간
   * ==================================================
   */

  const addRequiredSegment = (segment: Omit<RequiredSegment, "id" | "type">) => {
    setRequiredItems((current) => [
      ...current,
      {
        id: createId(),
        type: "segment",
        ...segment,
      },
    ]);

    clearGeneratedRoute();

    setSegmentPickerOpen(false);
  };

  const removeRequiredItem = (id: string) => {
    setRequiredItems((current) => current.filter((item) => item.id !== id));

    clearGeneratedRoute();
  };

  /*
   * ==================================================
   * 경관
   * ==================================================
   */

  const toggleScenery = (value: string) => {
    setSceneries((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    );
  };

  /*
   * ==================================================
   * Validation
   * ==================================================
   */

  const validateInputs = () => {
    if (!routeType) {
      alert("경로 형태를 선택해주세요.");
      return false;
    }

    if (!locationA) {
      alert("A 위치를 설정해주세요.");
      return false;
    }

    if (routeType === "순환형") {
      const distance = Number(distanceInput);

      if (
        distanceInput.trim() === "" ||
        !Number.isFinite(distance) ||
        distance < 1 ||
        distance > 50
      ) {
        alert("목표 거리를 1km 이상 50km 이하로 입력해주세요.");

        return false;
      }
    }

    if ((routeType === "왕복형" || routeType === "편도형") && !locationB) {
      alert("B 위치를 설정해주세요.");

      return false;
    }

    if (
      minElevationInput !== "" &&
      maxElevationInput !== "" &&
      Number(minElevationInput) > Number(maxElevationInput)
    ) {
      alert("최저 고도 변화는 최고 고도 변화보다 작아야 합니다.");

      return false;
    }

    return true;
  };

  /*
   * ==================================================
   * 경로 생성
   *
   * Kakao Walking API를 사용해 최종 보행 경로를 생성한다.
   * ==================================================
   */

  const generateRoute = async () => {
    if (!validateInputs() || !routeType || !locationA) {
      return;
    }

    setIsGenerating(true);

    clearGeneratedRoute();

    try {
      const response = await fetch("/api/route-kakao", {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          routeType,

          start: {
            latitude: locationA.latitude,
            longitude: locationA.longitude,
          },

          destination: locationB
            ? {
                latitude: locationB.latitude,
                longitude: locationB.longitude,
              }
            : null,

          targetDistanceKm: routeType === "순환형" ? Number(distanceInput) : null,

          requiredItems: requiredItems.map((item) => {
            if (item.type === "waypoint") {
              return {
                id: item.id,
                type: "waypoint",

                location: {
                  latitude: item.location.latitude,
                  longitude: item.location.longitude,
                },
              };
            }

            return {
              id: item.id,
              type: "segment",

              start: {
                latitude: item.start.latitude,
                longitude: item.start.longitude,
              },

              end: {
                latitude: item.end.latitude,
                longitude: item.end.longitude,
              },

              route: item.route,

              distanceKm: item.distanceKm,
            };
          }),

          preferences: {
            elevation: {
              min: minElevationInput === "" ? null : Number(minElevationInput),

              max: maxElevationInput === "" ? null : Number(maxElevationInput),
            },

            sceneries,

            signalPreference,
          },
        }),
      });

      const data = (await readJsonResponse(response)) as RouteApiResponse;

      if (!response.ok || !data.route) {
        alert(data.error ?? "경로를 생성하지 못했습니다.");

        return;
      }

      setGeneratedRoute(data.route);
      setNavigationSteps(data.navigationSteps ?? []);

      setActualDistance(data.summary?.distanceKm ?? null);

      setDistanceErrorPercent(data.summary?.distanceErrorPercent ?? null);

      console.log("Kakao route result:", data);
    } catch (error) {
      console.log("Route generation failed:", error);

      alert(error instanceof Error ? error.message : "경로 생성 중 오류가 발생했습니다.");
    } finally {
      setIsGenerating(false);
    }
  };

  const saveRoute = async () => {
    if (!generatedRoute || !routeType || actualDistance === null || isSavingRoute) return;
    setIsSavingRoute(true);
    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeType,
          start: locationA,
          destination: locationB,
          route: generatedRoute,
          navigationSteps,
          targetDistanceKm: routeType === "순환형" ? Number(distanceInput) : null,
          preferences: { sceneries, signalPreference, elevation: { min: minElevationInput === "" ? null : Number(minElevationInput), max: maxElevationInput === "" ? null : Number(maxElevationInput) } },
          requiredItems,
          summary: {
            distanceMeters: Math.round(actualDistance * 1_000),
            targetDistanceMeters: routeType === "순환형" && distanceInput ? Number(distanceInput) * 1_000 : null,
            distanceErrorPercent,
            durationSeconds: null,
            overlapRatio: null,
          },
        }),
      });
      const data = await readJsonResponse(response) as { route?: { id?: string }; error?: string };
      if (!response.ok || !data.route?.id) throw new Error(data.error ?? "경로를 저장하지 못했습니다.");
      setSavedRouteId(data.route.id);
    } catch (error) {
      alert(error instanceof Error ? error.message : "경로를 저장하지 못했습니다.");
    } finally {
      setIsSavingRoute(false);
    }
  };

  /*
   * ==================================================
   * 내비게이션 시작
   * ==================================================
   */

  const startNavigation = () => {
    if (!generatedRoute || generatedRoute.length < 2) {
      alert("먼저 경로를 생성해주세요.");
      return;
    }

    sessionStorage.setItem(
      "perog-navigation-route",
      JSON.stringify({
        route: generatedRoute,
        routeType,
        distanceKm: actualDistance,
        start: locationA,
        destination: locationB,
        navigationSteps,
        routeId: savedRouteId,
      })
    );

    router.push("/navigate");
  };

  /*
   * ==================================================
   * A / B selector
   * ==================================================
   */

  const renderLocationSelector = (target: "A" | "B", title: string, description: string) => {
    const location = target === "A" ? locationA : locationB;

    const targetData: LocationTarget = {
      kind: "base",
      target,
    };

    const searchActive = searchTarget?.kind === "base" && searchTarget.target === target;

    return (
      <div className="location-selector">
        <div className="location-selector__heading">
          <div>
            <strong>{target}</strong>

            <span>
              <b>{title}</b>
              <small>{description}</small>
            </span>
          </div>
        </div>

        {location ? (
          <div className="selected-location-card">
            <span className="selected-location-card__marker">{target}</span>

            <div>
              <strong>{location.name}</strong>
              <small>{location.address}</small>
            </div>

            <button
              type="button"
              onClick={() => {
                if (target === "A") {
                  setLocationA(null);
                } else {
                  setLocationB(null);
                }

                clearGeneratedRoute();
              }}
            >
              변경
            </button>
          </div>
        ) : (
          <>
            <div className="location-methods">
              <button type="button" onClick={() => openLocationPicker(targetData, "gps")}>
                <span>◎</span>
                현재 위치
              </button>

              <button type="button" onClick={() => openSearch(targetData)}>
                <span>⌕</span>
                장소 검색
              </button>

              <button type="button" onClick={() => openLocationPicker(targetData, "map")}>
                <span>⌖</span>
                지도에서 선택
              </button>
            </div>

            {searchActive && renderSearchPanel()}
          </>
        )}
      </div>
    );
  };

  /*
   * ==================================================
   * Search UI
   * ==================================================
   */

  const renderSearchPanel = () => (
    <div className="place-search">
      <div className="place-search__input">
        <input
          autoFocus
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="예: 신정동, 여의도한강공원"
        />

        <button type="button" onClick={closeSearch}>
          ×
        </button>
      </div>

      {isSearching && <div className="place-search__status">장소를 검색하고 있습니다...</div>}

      {!isSearching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
        <div className="place-search__status">검색 결과가 없습니다.</div>
      )}

      {searchResults.length > 0 && (
        <div className="place-search__results">
          {searchResults.map((result, index) => (
            <button
              key={`${result.id}-${index}`}
              type="button"
              onClick={() => selectSearchResult(result)}
            >
              <strong>{result.name}</strong>
              <small>{result.address}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  /*
   * ==================================================
   * 07 required items
   * ==================================================
   */

  const renderRequiredItems = () => {
    return (
      <div className="required-items">
        <div className="required-add-buttons">
          <button
            type="button"
            onClick={() =>
              openLocationPicker(
                {
                  kind: "waypoint-add",
                },
                "map"
              )
            }
          >
            <strong>＋ 경유지 추가</strong>
            <small>경로가 반드시 지나야 할 장소</small>
          </button>

          <button type="button" onClick={() => setSegmentPickerOpen(true)}>
            <strong>＋ 필수 구간 추가</strong>
            <small>반드시 포함해야 할 보행 구간</small>
          </button>
        </div>

        {requiredItems.length > 0 && (
          <div className="required-list">
            {requiredItems.map((item, index) => {
              if (item.type === "waypoint") {
                const searchActive =
                  searchTarget?.kind === "waypoint-edit" && searchTarget.id === item.id;

                return (
                  <div className="required-card" key={item.id}>
                    <div className="required-card__index">{index + 1}</div>

                    <div className="required-card__body">
                      <small>필수 경유지</small>

                      <strong>{item.location.name}</strong>

                      <p>{item.location.address}</p>

                      {searchActive && renderSearchPanel()}
                    </div>

                    <div className="required-card__actions">
                      <button
                        type="button"
                        onClick={() =>
                          openLocationPicker(
                            {
                              kind: "waypoint-edit",
                              id: item.id,
                            },
                            "map"
                          )
                        }
                      >
                        변경
                      </button>

                      <button type="button" onClick={() => removeRequiredItem(item.id)}>
                        삭제
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div className="required-card required-card--segment" key={item.id}>
                  <div className="required-card__index">{index + 1}</div>

                  <div className="required-card__body">
                    <small>필수 구간</small>

                    <strong>
                      {item.start.name} → {item.end.name}
                    </strong>

                    <p>{item.distanceKm.toFixed(2)} KM</p>
                  </div>

                  <div className="required-card__actions">
                    <button type="button" onClick={() => removeRequiredItem(item.id)}>
                      삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="builder-helper">
          추가한 순서대로 경로에 포함됩니다. 추가하지 않으면 PEROG가 자유롭게 경로를 생성합니다.
        </p>
      </div>
    );
  };

  /*
   * ==================================================
   * Modal label / center
   * ==================================================
   */

  let pickerLabel = "위치 선택";

  let pickerInitialLocation: SelectedLocation | null = locationA;

  if (locationTarget?.kind === "base") {
    if (locationTarget.target === "A") {
      pickerInitialLocation = locationA;

      pickerLabel =
        routeType === "순환형"
          ? "A · 출발·도착 위치"
          : routeType === "왕복형"
            ? "A · 시작·도착 위치"
            : "A · 출발 위치";
    } else {
      pickerInitialLocation = locationB ?? locationA;

      pickerLabel = routeType === "왕복형" ? "B · 반환 위치" : "B · 도착 위치";
    }
  }

  if (locationTarget?.kind === "waypoint-add") {
    pickerLabel = "필수 경유지 추가";
  }

  if (locationTarget?.kind === "waypoint-edit") {
    const waypoint = requiredItems.find(
      (item) => item.id === locationTarget.id && item.type === "waypoint"
    );

    if (waypoint?.type === "waypoint") {
      pickerInitialLocation = waypoint.location;
    }

    pickerLabel = "필수 경유지 변경";
  }

  const targetDistance =
    routeType === "순환형" && distanceInput !== "" ? Number(distanceInput) : null;

  return (
    <>
      <Header />

      <main className="create-page">
        <section className="route-builder">
          <div className="route-builder__panel">
            <div className="route-builder__heading">
              <div className="section-label">
                <span />
                PERSONALIZED ROUTE
              </div>

              <h1>나만의 경로 만들기</h1>

              <p>
                원하는 조건과 위치를 직접 설정하세요.
                <br />
                PEROG가 보행 가능한 러닝 경로를 생성합니다.
              </p>
            </div>

            {/* 01 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>01</span>
                <h2>운동</h2>
              </div>

              <div className="sport-options">
                <button className="option-button option-button--active" type="button">
                  <span>RUN</span>
                  <small>러닝</small>
                </button>

                <button className="option-button" disabled>
                  <span>RIDE</span>
                  <small>준비 중</small>
                </button>

                <button className="option-button" disabled>
                  <span>HIKE</span>
                  <small>준비 중</small>
                </button>
              </div>
            </div>

            {/* 02 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>02</span>
                <h2>경로 형태</h2>
              </div>

              <div className="route-type-options">
                {routeTypes.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      routeType === value
                        ? "segment-button segment-button--active"
                        : "segment-button"
                    }
                    onClick={() => handleRouteTypeChange(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>

              <p className="builder-helper">
                {!routeType && "원하는 경로 형태를 선택해주세요."}

                {routeType === "순환형" && "A에서 출발해 목표 거리를 달린 후 다시 A로 돌아옵니다."}

                {routeType === "왕복형" && "A에서 B까지 이동한 뒤 같은 길을 따라 A로 돌아옵니다."}

                {routeType === "편도형" && "A에서 출발해 B에서 종료합니다."}
              </p>
            </div>

            {/* 03 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>03</span>
                <h2>경로 설정</h2>
              </div>

              {!routeType ? (
                <div className="empty-setting">먼저 경로 형태를 선택해주세요.</div>
              ) : (
                <>
                  {routeType === "순환형" && (
                    <>
                      {renderLocationSelector(
                        "A",
                        "출발·도착 위치",
                        "이 위치에서 출발해 다시 돌아옵니다."
                      )}

                      <div className="route-setting-divider" />

                      <div className="distance-field">
                        <label>목표 거리</label>

                        <div className="number-input-card">
                          <input
                            type="number"
                            min="1"
                            max="50"
                            step="0.1"
                            value={distanceInput}
                            placeholder="10.0"
                            onChange={(event) => {
                              setDistanceInput(event.target.value);
                              clearGeneratedRoute();
                            }}
                          />

                          <span>KM</span>
                        </div>

                        <p className="builder-helper">
                          1 km부터 50 km까지 직접 입력할 수 있습니다.
                        </p>
                      </div>
                    </>
                  )}

                  {routeType === "왕복형" && (
                    <>
                      {renderLocationSelector(
                        "A",
                        "시작·도착 위치",
                        "왕복 경로의 시작점이자 최종 도착점입니다."
                      )}

                      <div className="route-setting-divider" />

                      {renderLocationSelector(
                        "B",
                        "반환 위치",
                        "이 위치까지 이동한 뒤 다시 A로 돌아옵니다."
                      )}
                    </>
                  )}

                  {routeType === "편도형" && (
                    <>
                      {renderLocationSelector("A", "출발 위치", "러닝을 시작할 위치입니다.")}

                      <div className="route-setting-divider" />

                      {renderLocationSelector("B", "도착 위치", "러닝을 종료할 위치입니다.")}
                    </>
                  )}
                </>
              )}
            </div>

            {/* 04 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>04</span>
                <h2>고도 변화</h2>
              </div>

              <p className="builder-section__description">
                출발점 기준으로 원하는 고도 변화 범위를 입력하세요.
              </p>

              <div className="elevation-inputs">
                <label className="elevation-input">
                  <span>최저 변화</span>

                  <div>
                    <input
                      type="number"
                      placeholder="-3"
                      value={minElevationInput}
                      onChange={(event) => setMinElevationInput(event.target.value)}
                    />

                    <small>m</small>
                  </div>
                </label>

                <label className="elevation-input">
                  <span>최고 변화</span>

                  <div>
                    <input
                      type="number"
                      placeholder="+5"
                      value={maxElevationInput}
                      onChange={(event) => setMaxElevationInput(event.target.value)}
                    />

                    <small>m</small>
                  </div>
                </label>
              </div>

              <p className="builder-helper">입력하지 않으면 고도 조건을 제한하지 않습니다.</p>
            </div>

            {/* 05 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>05</span>
                <h2>선호 경관</h2>
              </div>

              <div className="chip-options">
                {sceneryOptions.map((value) => {
                  const selected = sceneries.includes(value);

                  return (
                    <button
                      key={value}
                      type="button"
                      className={selected ? "chip-button chip-button--active" : "chip-button"}
                      onClick={() => toggleScenery(value)}
                    >
                      {selected && <span>✓</span>}
                      {value}
                    </button>
                  );
                })}
              </div>

              <p className="builder-helper">
                선택하지 않으면 주변 환경을 고려해 다양한 경로를 생성합니다.
              </p>
            </div>

            {/* 06 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>06</span>
                <h2>신호·횡단</h2>
              </div>

              <div className="signal-options">
                {signalOptions.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      signalPreference === value
                        ? "segment-button segment-button--active"
                        : "segment-button"
                    }
                    onClick={() => setSignalPreference(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>

              <p className="builder-helper">
                선택하지 않으면 PEROG의 기본 조건으로 경로를 생성합니다.
              </p>
            </div>

            {/* 07 */}

            <div className="builder-section">
              <div className="builder-section__header">
                <span>07</span>
                <h2>경로에 포함</h2>
              </div>

              <p className="builder-section__description">
                반드시 지나고 싶은 장소나 보행 구간을 추가하세요.
              </p>

              {renderRequiredItems()}
            </div>
            <button
              className="generate-route-button"
              type="button"
              disabled={isGenerating}
              onClick={generateRoute}
            >
              <span>{isGenerating ? "경로 생성 중..." : "경로 생성하기"}</span>

              <span>{isGenerating ? "•••" : "→"}</span>
            </button>
          </div>

          {/* Main Map */}

          <div className="route-builder__preview">
            <RouteMap
              route={generatedRoute}
              routeType={routeType}
              locationA={locationA}
              locationB={locationB}
              requiredItems={requiredItems}
            />

            {generatedRoute && generatedRoute.length > 1 && (
              <>
                <button className="start-navigation-button" type="button" onClick={startNavigation}>
                  <span className="start-navigation-button__icon">▶</span>
                  <span className="start-navigation-button__text"><strong>내비게이션 시작</strong><small>실시간 경로 안내</small></span>
                  <span className="start-navigation-button__arrow">→</span>
                </button>
                <div className="route-save-action">
                  {auth.status === "authenticated" ? savedRouteId ? <span>✓ 내 경로에 저장됨</span> : <button type="button" onClick={saveRoute} disabled={isSavingRoute}>{isSavingRoute ? "저장 중..." : "내 경로에 저장"}</button> : auth.status === "guest" ? <><span>로그인하면 이 경로를 저장할 수 있습니다.</span><a href="/api/auth/kakao?returnTo=/create">카카오로 로그인</a></> : null}
                </div>
              </>
            )}

            <div className="route-preview-summary">
              <div>
                <small>{routeType === "순환형" ? "TARGET" : "DISTANCE"}</small>

                <strong>
                  {routeType === "순환형" && targetDistance !== null
                    ? `${targetDistance.toFixed(1)} KM`
                    : actualDistance !== null
                      ? `${actualDistance.toFixed(2)} KM`
                      : "-"}
                </strong>
              </div>

              <div>
                <small>ACTUAL</small>

                <strong>{actualDistance !== null ? `${actualDistance.toFixed(2)} KM` : "-"}</strong>
              </div>

              <div>
                <small>TYPE</small>
                <strong>{routeType ?? "-"}</strong>
              </div>

              <div>
                <small>{routeType === "순환형" ? "ERROR" : "MODE"}</small>

                <strong>
                  {routeType === "순환형" && distanceErrorPercent !== null
                    ? `${distanceErrorPercent >= 0 ? "+" : ""}${distanceErrorPercent.toFixed(1)}%`
                    : routeType
                      ? "PEDESTRIAN"
                      : "-"}
                </strong>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* A / B / waypoint picker */}

      <LocationPickerModal
        open={pickerOpen}
        mode={pickerMode}
        targetLabel={pickerLabel}
        initialCenter={
          pickerInitialLocation
            ? {
                latitude: pickerInitialLocation.latitude,
                longitude: pickerInitialLocation.longitude,
              }
            : null
        }
        onClose={closeLocationPicker}
        onConfirm={confirmPickedLocation}
      />

      {/* Required segment picker */}

      <RequiredSegmentPickerModal
        open={segmentPickerOpen}
        initialCenter={
          locationA
            ? {
                latitude: locationA.latitude,
                longitude: locationA.longitude,
              }
            : null
        }
        onClose={() => setSegmentPickerOpen(false)}
        onConfirm={addRequiredSegment}
      />
    </>
  );
}
