import { Db, MongoClient } from "mongodb";

type MongoGlobal = typeof globalThis & {
  perogMongoClientPromise?: Promise<MongoClient>;
  perogMongoIndexesPromise?: Promise<void>;
};

const globalForMongo = globalThis as MongoGlobal;

function createClientPromise(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  return new MongoClient(uri).connect();
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("users").createIndex(
      { "auth.provider": 1, "auth.providerUserId": 1 },
      { unique: true, name: "users_auth_provider_identity_unique" },
    ),
    db.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true, name: "sessions_token_hash_unique" }),
    db.collection("sessions").createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "sessions_expiry_ttl" },
    ),
    db.collection("routes").createIndex({ userId: 1, createdAt: -1 }, { name: "routes_user_created" }),
    db.collection("routes").createIndex({ userId: 1, isFavorite: 1 }, { name: "routes_user_favorite" }),
    db.collection("activeWorkouts").createIndex({ userId: 1 }, { unique: true, name: "active_workouts_user_unique" }),
    db.collection("workouts").createIndex({ userId: 1, startedAt: -1 }, { name: "workouts_user_started" }),
    db.collection("workouts").createIndex({ userId: 1, sourceWorkoutId: 1 }, { unique: true, name: "workouts_user_source_unique" }),
    db.collection("workouts").createIndex({ routeId: 1 }, { name: "workouts_route" }),
    db.collection("workoutTrackChunks").createIndex({ workoutId: 1, chunkIndex: 1 }, { unique: true, name: "track_chunks_workout_chunk_unique" }),
    db.collection("routeFeedback").createIndex({ userId: 1, workoutId: 1 }, { unique: true, name: "feedback_user_workout_unique" }),
  ]);
}

export async function getPerogDb(): Promise<Db> {
  const clientPromise = globalForMongo.perogMongoClientPromise ?? createClientPromise();
  globalForMongo.perogMongoClientPromise = clientPromise;

  const client = await clientPromise;
  const db = client.db("perog");

  const indexesPromise = globalForMongo.perogMongoIndexesPromise ?? ensureIndexes(db);
  globalForMongo.perogMongoIndexesPromise = indexesPromise;
  await indexesPromise;

  return db;
}
