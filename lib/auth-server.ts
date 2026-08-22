import { ObjectId } from "mongodb";
import {
  createSessionExpiry,
  createUserDefaults,
  generateSecureToken,
  hashSessionToken,
  type KakaoIdentity,
} from "./auth";
import { getPerogDb } from "./mongodb";

type PerogUser = {
  _id: ObjectId;
  auth: { provider: "kakao"; providerUserId: string };
  profile: { nickname: string | null; profileImage: string | null };
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
  createdAt: Date;
  updatedAt: Date;
};

type PerogSession = {
  userId: ObjectId;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
};

export type PublicUser = {
  id: string;
  nickname: string | null;
  profileImage: string | null;
};

export type KakaoUserUpsertResult = {
  user: PublicUser;
  created: boolean;
};

export type SessionIdentity = {
  userId: ObjectId;
  user: PublicUser;
};

function toPublicUser(user: PerogUser): PublicUser {
  return {
    id: user._id.toHexString(),
    nickname: user.profile.nickname,
    profileImage: user.profile.profileImage,
  };
}

export async function upsertKakaoUser(identity: KakaoIdentity): Promise<KakaoUserUpsertResult> {
  const db = await getPerogDb();
  const users = db.collection<PerogUser>("users");
  const now = new Date();
  const defaults = createUserDefaults();
  const filter = { "auth.provider": "kakao" as const, "auth.providerUserId": identity.providerUserId };

  const update = await users.updateOne(filter, {
    $set: {
      profile: { nickname: identity.nickname, profileImage: identity.profileImage },
      updatedAt: now,
    },
    $setOnInsert: {
      auth: { provider: "kakao" as const, providerUserId: identity.providerUserId },
      ...defaults,
      createdAt: now,
    },
  }, { upsert: true });

  const user = await users.findOne(filter);
  if (!user) {
    throw new Error("User upsert did not return a user.");
  }

  return { user: toPublicUser(user), created: update.upsertedCount === 1 };
}

export async function findKakaoUser(identity: KakaoIdentity): Promise<PublicUser | null> {
  const db = await getPerogDb();
  const user = await db.collection<PerogUser>("users").findOne({
    "auth.provider": "kakao",
    "auth.providerUserId": identity.providerUserId,
  });
  return user ? toPublicUser(user) : null;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const db = await getPerogDb();
  const token = generateSecureToken();
  const now = new Date();
  const expiresAt = createSessionExpiry(now);
  const session: PerogSession = {
    userId: new ObjectId(userId),
    tokenHash: hashSessionToken(token),
    createdAt: now,
    expiresAt,
  };

  await db.collection<PerogSession>("sessions").insertOne(session);
  return { token, expiresAt };
}

export async function getSessionUser(token: string | undefined): Promise<PublicUser | null> {
  const identity = await getSessionIdentity(token);
  return identity?.user ?? null;
}

export async function getSessionIdentity(token: string | undefined): Promise<SessionIdentity | null> {
  if (!token || token.length < 20) return null;

  const db = await getPerogDb();
  const session = await db.collection<PerogSession>("sessions").findOne({
    tokenHash: hashSessionToken(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;

  const user = await db.collection<PerogUser>("users").findOne({ _id: session.userId });
  return user ? { userId: user._id, user: toPublicUser(user) } : null;
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token || token.length < 20) return;
  const db = await getPerogDb();
  await db.collection<PerogSession>("sessions").deleteOne({ tokenHash: hashSessionToken(token) });
}
