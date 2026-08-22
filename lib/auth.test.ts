import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_MAX_AGE_SECONDS,
  createSessionExpiry,
  createUserDefaults,
  generateSecureToken,
  hashSessionToken,
  isOAuthStateValid,
  mapKakaoUser,
  sanitizeReturnTo,
  createKakaoCallbackUrl,
  createAuthResultUrl,
  getKakaoLoginCredentials,
  normalizeAuthIntent,
} from "./auth.ts";

test("session token is random-looking and only its SHA-256 hash is deterministic", () => {
  const token = generateSecureToken();
  assert.ok(token.length >= 40);
  assert.match(hashSessionToken(token), /^[a-f0-9]{64}$/);
  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(hashSessionToken(token), token);
});

test("session expiry uses the configured lifetime", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  assert.equal(createSessionExpiry(now).getTime() - now.getTime(), SESSION_MAX_AGE_SECONDS * 1000);
});

test("maps only supported optional Kakao profile fields", () => {
  assert.deepEqual(
    mapKakaoUser({ id: 123, properties: { nickname: "  페로그  ", profile_image: "https://example.test/a.png" } }),
    { providerUserId: "123", nickname: "페로그", profileImage: "https://example.test/a.png" },
  );
  assert.deepEqual(mapKakaoUser({ id: "abc", kakao_account: { profile: { nickname: "러너" } } }), {
    providerUserId: "abc",
    nickname: "러너",
    profileImage: null,
  });
  assert.equal(mapKakaoUser({ properties: { nickname: "missing identity" } }), null);
  assert.equal(mapKakaoUser(null), null);
});

test("new user defaults preserve the requested safe settings", () => {
  assert.deepEqual(createUserDefaults(), {
    preferences: { preferredRouteTypes: [], preferredSceneries: [], defaultDistanceKm: null },
    navigationSettings: { voiceGuidance: true, vibration: true, displayMode: "camera" },
    stats: { totalRuns: 0, totalDistanceMeters: 0, totalMovingSeconds: 0 },
  });
});

test("OAuth state rejects missing, malformed, and mismatched values", () => {
  assert.equal(isOAuthStateValid("a-secure-state", "a-secure-state"), true);
  assert.equal(isOAuthStateValid("a-secure-state", "different"), false);
  assert.equal(isOAuthStateValid("a-secure-state", null), false);
  assert.equal(isOAuthStateValid(undefined, "a-secure-state"), false);
});

test("returnTo only accepts same-origin internal paths", () => {
  assert.equal(sanitizeReturnTo("/my/routes?tab=favorite"), "/my/routes?tab=favorite");
  assert.equal(sanitizeReturnTo("//evil.example"), "/");
  assert.equal(sanitizeReturnTo("https://evil.example"), "/");
  assert.equal(sanitizeReturnTo("javascript:alert(1)"), "/");
});

test("authorization and callback share the exact fixed callback URL", () => {
  assert.equal(createKakaoCallbackUrl("http://localhost:3000"), "http://localhost:3000/api/auth/kakao/callback");
  assert.equal(createKakaoCallbackUrl("https://perog.vercel.app"), "https://perog.vercel.app/api/auth/kakao/callback");
});

test("auth result URLs only use the internal result page and declared type", () => {
  assert.equal(
    createAuthResultUrl("http://localhost:3000", "already_registered"),
    "http://localhost:3000/auth/result?type=already_registered",
  );
});

test("Kakao credential helper requires both server-only OAuth values", () => {
  const previousKey = process.env.KAKAO_LOGIN_REST_API_KEY;
  const previousSecret = process.env.KAKAO_LOGIN_CLIENT_SECRET;
  delete process.env.KAKAO_LOGIN_REST_API_KEY;
  delete process.env.KAKAO_LOGIN_CLIENT_SECRET;
  assert.equal(getKakaoLoginCredentials(), null);
  process.env.KAKAO_LOGIN_REST_API_KEY = "client";
  assert.equal(getKakaoLoginCredentials(), null);
  process.env.KAKAO_LOGIN_CLIENT_SECRET = "secret";
  assert.deepEqual(getKakaoLoginCredentials(), { clientId: "client", clientSecret: "secret" });
  if (previousKey === undefined) delete process.env.KAKAO_LOGIN_REST_API_KEY;
  else process.env.KAKAO_LOGIN_REST_API_KEY = previousKey;
  if (previousSecret === undefined) delete process.env.KAKAO_LOGIN_CLIENT_SECRET;
  else process.env.KAKAO_LOGIN_CLIENT_SECRET = previousSecret;
});

test("auth intent only allows the two server-recognized flows", () => {
  assert.equal(normalizeAuthIntent("login"), "login");
  assert.equal(normalizeAuthIntent("signup"), "signup");
  assert.equal(normalizeAuthIntent("unexpected"), "login");
  assert.equal(normalizeAuthIntent(null), "login");
});
