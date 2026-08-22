import { NextRequest, NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_RETURN_TO_COOKIE_NAME,
  OAUTH_INTENT_COOKIE_NAME,
  OAUTH_STATE_MAX_AGE_SECONDS,
  generateSecureToken,
  sanitizeReturnTo,
  createKakaoCallbackUrl,
  getKakaoLoginCredentials,
  normalizeAuthIntent,
} from "@/lib/auth";

export const runtime = "nodejs";

function failureRedirect(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/?authError=kakao", request.nextUrl.origin));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const credentials = getKakaoLoginCredentials();
  if (!credentials) {
    if (process.env.NODE_ENV === "development") console.warn("PEROG OAuth", { stage: "OAUTH_CONFIGURATION_INVALID", loginKeyConfigured: Boolean(process.env.KAKAO_LOGIN_REST_API_KEY), clientSecretConfigured: Boolean(process.env.KAKAO_LOGIN_CLIENT_SECRET) });
    return failureRedirect(request);
  }

  const state = generateSecureToken();
  const intent = normalizeAuthIntent(request.nextUrl.searchParams.get("intent"));
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const callbackUrl = createKakaoCallbackUrl(request.nextUrl.origin);
  const authorizationUrl = new URL("https://kauth.kakao.com/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", credentials.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", state);
  // Kakao owns the UI. This asks it to show its account-selection/easy-login
  // experience when available, while allowing Kakao's normal OAuth fallback.
  authorizationUrl.searchParams.set("prompt", "select_account");

  if (process.env.NODE_ENV === "development") {
    console.info("PEROG OAuth", { stage: "KAKAO_AUTHORIZATION_STARTED", redirectUri: callbackUrl });
  }

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  response.cookies.set(OAUTH_RETURN_TO_COOKIE_NAME, returnTo, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  response.cookies.set(OAUTH_INTENT_COOKIE_NAME, intent, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
