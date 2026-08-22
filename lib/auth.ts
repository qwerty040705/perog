import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "perog_session";
export const OAUTH_STATE_COOKIE_NAME = "perog_oauth_state";
export const OAUTH_RETURN_TO_COOKIE_NAME = "perog_oauth_return_to";
export const OAUTH_INTENT_COOKIE_NAME = "perog_oauth_intent";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

export type KakaoLoginCredentials = { clientId: string; clientSecret: string };
export type AuthIntent = "login" | "signup";
export type AuthResultType = "account_not_found" | "already_registered" | "signup_success" | "login_error";

export type KakaoIdentity = {
  providerUserId: string;
  nickname: string | null;
  profileImage: string | null;
};

export type UserDefaults = {
  preferences: {
    preferredRouteTypes: string[];
    preferredSceneries: string[];
    defaultDistanceKm: number | null;
  };
  navigationSettings: {
    voiceGuidance: boolean;
    vibration: boolean;
    displayMode: "camera" | "map" | "simple";
  };
  stats: {
    totalRuns: number;
    totalDistanceMeters: number;
    totalMovingSeconds: number;
  };
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function generateSecureToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionExpiry(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
}

export function isOAuthStateValid(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received || expected.length !== received.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const url = new URL(value, "https://perog.local");
    return url.origin === "https://perog.local" ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

/** Both OAuth legs must derive the exact same fixed callback URL. */
export function createKakaoCallbackUrl(origin: string): string {
  return new URL("/api/auth/kakao/callback", origin).toString();
}

/** Server-only OAuth configuration. Values are never returned to clients or logs. */
export function getKakaoLoginCredentials(): KakaoLoginCredentials | null {
  const clientId = process.env.KAKAO_LOGIN_REST_API_KEY;
  const clientSecret = process.env.KAKAO_LOGIN_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function normalizeAuthIntent(value: string | null | undefined): AuthIntent {
  return value === "signup" ? "signup" : "login";
}

/** Result page destinations are selected only by the server-side OAuth callback. */
export function createAuthResultUrl(origin: string, type: AuthResultType): string {
  const url = new URL("/auth/result", origin);
  url.searchParams.set("type", type);
  return url.toString();
}

export function mapKakaoUser(payload: unknown): KakaoIdentity | null {
  const root = asRecord(payload);
  if (!root) return null;

  const id = root.id;
  if ((typeof id !== "string" && typeof id !== "number") || String(id).trim().length === 0) {
    return null;
  }

  const properties = asRecord(root.properties);
  const kakaoAccount = asRecord(root.kakao_account);
  const accountProfile = kakaoAccount ? asRecord(kakaoAccount.profile) : null;

  return {
    providerUserId: String(id),
    nickname: optionalText(properties?.nickname) ?? optionalText(accountProfile?.nickname),
    profileImage:
      optionalText(properties?.profile_image) ??
      optionalText(properties?.thumbnail_image) ??
      optionalText(accountProfile?.profile_image_url) ??
      optionalText(accountProfile?.thumbnail_image_url),
  };
}

export function createUserDefaults(): UserDefaults {
  return {
    preferences: {
      preferredRouteTypes: [],
      preferredSceneries: [],
      defaultDistanceKm: null,
    },
    navigationSettings: {
      voiceGuidance: true,
      vibration: true,
      displayMode: "camera",
    },
    stats: {
      totalRuns: 0,
      totalDistanceMeters: 0,
      totalMovingSeconds: 0,
    },
  };
}
