import { NextRequest, NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_RETURN_TO_COOKIE_NAME,
  OAUTH_INTENT_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  isOAuthStateValid,
  mapKakaoUser,
  sanitizeReturnTo,
  createKakaoCallbackUrl,
  createAuthResultUrl,
  getKakaoLoginCredentials,
  normalizeAuthIntent,
  type AuthResultType,
} from "@/lib/auth";
import { createSession, findKakaoUser, upsertKakaoUser } from "@/lib/auth-server";
import { getPerogDb } from "@/lib/mongodb";

export const runtime = "nodejs";

type KakaoTokenResponse = { access_token?: unknown; error?: unknown; error_description?: unknown };

function developmentLog(stage: string, details: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV !== "development") return;
  // Deliberately excludes OAuth code, access tokens, API keys, profile payloads, and DB URI.
  console.warn("PEROG OAuth callback", { stage, ...details });
}

async function kakaoErrorDetails(response: Response): Promise<{ status: number; error: string | null; errorDescription: string | null; kakaoErrorCode: string | number | null }> {
  const body = await response.json().catch(() => null) as KakaoTokenResponse | null;
  const errorCode = (body as Record<string, unknown> | null)?.code;
  return {
    status: response.status,
    error: typeof body?.error === "string" ? body.error : null,
    errorDescription: typeof body?.error_description === "string" ? body.error_description : null,
    kakaoErrorCode: typeof errorCode === "string" || typeof errorCode === "number" ? errorCode : null,
  };
}

function clearOAuthCookies(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_RETURN_TO_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_INTENT_COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return response;
}

function resultRedirect(request: NextRequest, type: AuthResultType): NextResponse {
  return clearOAuthCookies(NextResponse.redirect(createAuthResultUrl(request.nextUrl.origin, type)));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;
  const returnTo = sanitizeReturnTo(request.cookies.get(OAUTH_RETURN_TO_COOKIE_NAME)?.value);
  const intent = normalizeAuthIntent(request.cookies.get(OAUTH_INTENT_COOKIE_NAME)?.value);
  const credentials = getKakaoLoginCredentials();

  if (!credentials) {
    developmentLog("OAUTH_CONFIGURATION_INVALID", { loginKeyConfigured: Boolean(process.env.KAKAO_LOGIN_REST_API_KEY), clientSecretConfigured: Boolean(process.env.KAKAO_LOGIN_CLIENT_SECRET) });
    return resultRedirect(request, "login_error");
  }

  if (!code || !isOAuthStateValid(expectedState, state)) {
    developmentLog("OAUTH_STATE_INVALID", {
      codePresent: Boolean(code),
      loginKeyConfigured: true,
      clientSecretConfigured: true,
      stateCookiePresent: Boolean(expectedState),
      stateReceived: Boolean(state),
    });
    return resultRedirect(request, "login_error");
  }

  const callbackUrl = createKakaoCallbackUrl(request.nextUrl.origin);
  developmentLog("KAKAO_CALLBACK_RECEIVED", { redirectUri: callbackUrl, stateValid: true });

  let accessToken: string;
  try {
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: callbackUrl,
      code,
    });
    const tokenResponse = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: tokenBody,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) {
      developmentLog("KAKAO_TOKEN_EXCHANGE_FAILED", await kakaoErrorDetails(tokenResponse));
      return resultRedirect(request, "login_error");
    }

    const tokenPayload = (await tokenResponse.json()) as KakaoTokenResponse;
    if (typeof tokenPayload.access_token !== "string") {
      developmentLog("KAKAO_TOKEN_EXCHANGE_FAILED", { status: tokenResponse.status, error: typeof tokenPayload.error === "string" ? tokenPayload.error : "MISSING_ACCESS_TOKEN", errorDescription: typeof tokenPayload.error_description === "string" ? tokenPayload.error_description : null, kakaoErrorCode: null });
      return resultRedirect(request, "login_error");
    }
    accessToken = tokenPayload.access_token;
  } catch (error) {
    developmentLog("KAKAO_TOKEN_EXCHANGE_FAILED", { status: null, error: error instanceof Error ? error.name : "REQUEST_ERROR", errorDescription: null, kakaoErrorCode: null });
    return resultRedirect(request, "login_error");
  }

  let identity;
  try {
    const userResponse = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) {
      developmentLog("KAKAO_USER_FETCH_FAILED", await kakaoErrorDetails(userResponse));
      return resultRedirect(request, "login_error");
    }

    identity = mapKakaoUser(await userResponse.json());
    if (!identity) {
      developmentLog("KAKAO_USER_FETCH_FAILED", { status: userResponse.status, errorCode: "INVALID_USER_PAYLOAD", errorDescription: null });
      return resultRedirect(request, "login_error");
    }
  } catch (error) {
    developmentLog("KAKAO_USER_FETCH_FAILED", { status: null, errorCode: error instanceof Error ? error.name : "REQUEST_ERROR", errorDescription: null });
    return resultRedirect(request, "login_error");
  }

  try {
    await getPerogDb();
  } catch (error) {
    developmentLog("MONGODB_CONNECTION_FAILED", { errorCode: error instanceof Error ? error.name : "DATABASE_ERROR" });
    return resultRedirect(request, "login_error");
  }

  let existingUser;
  try {
    existingUser = await findKakaoUser(identity);
  } catch (error) {
    developmentLog("USER_UPSERT_FAILED", { errorCode: error instanceof Error ? error.name : "DATABASE_ERROR" });
    return resultRedirect(request, "login_error");
  }

  if (intent === "login" && !existingUser) {
    developmentLog("ACCOUNT_NOT_FOUND", {});
    return resultRedirect(request, "account_not_found");
  }

  // A signup request must never silently become a login for an existing member.
  if (intent === "signup" && existingUser) {
    developmentLog("ACCOUNT_ALREADY_REGISTERED", {});
    return resultRedirect(request, "already_registered");
  }

  let user = existingUser;
  let createdAccount = false;
  try {
    if (!user) {
      const createdUser = await upsertKakaoUser(identity);
      // Another request can create the account after the earlier lookup. Treat
      // that case exactly like any existing-account signup: no silent login.
      if (!createdUser.created) return resultRedirect(request, "already_registered");
      user = createdUser.user;
      createdAccount = true;
    }
  } catch (error) {
    developmentLog("USER_UPSERT_FAILED", { errorCode: error instanceof Error ? error.name : "DATABASE_ERROR", mongoCode: error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code ?? null : null });
    return resultRedirect(request, "login_error");
  }

  let session;
  try {
    session = await createSession(user.id);
  } catch (error) {
    developmentLog("SESSION_CREATE_FAILED", { errorCode: error instanceof Error ? error.name : "DATABASE_ERROR", mongoCode: error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code ?? null : null });
    return resultRedirect(request, "login_error");
  }

  try {
    const destination = createdAccount
      ? new URL(createAuthResultUrl(request.nextUrl.origin, "signup_success"))
      : new URL(returnTo, request.nextUrl.origin);
    destination.searchParams.delete("authError");
    const response = clearOAuthCookies(NextResponse.redirect(destination));
    response.cookies.set(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
      expires: session.expiresAt,
    });
    return response;
  } catch (error) {
    developmentLog("SESSION_COOKIE_CREATE_FAILED", { errorCode: error instanceof Error ? error.name : "COOKIE_ERROR" });
    return resultRedirect(request, "login_error");
  }
}
