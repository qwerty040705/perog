import assert from "node:assert/strict";
import test from "node:test";
import { appendWorkoutTrackPoint, averagePaceSecondsPerKm, createWorkoutSession, createWorkoutSummary, elapsedWorkoutSeconds, pauseWorkout, recordOffRouteTransition, resumeWorkout, selectRecoveryTarget } from "./workout.ts";
import { createRouteIndex } from "./navigation.ts";

test("excludes paused time from elapsed workout time", () => {
  let workout = createWorkoutSession(0);
  workout = pauseWorkout(workout, 10_000);
  workout = resumeWorkout(workout, 20_000);
  assert.equal(elapsedWorkoutSeconds(workout, 30_000), 20);
});

test("does not add the paused gap to workout distance", () => {
  let workout = createWorkoutSession(0);
  appendWorkoutTrackPoint(workout, { latitude: 37, longitude: 127, timestamp: 1_000, accuracy: 5 }, 2);
  workout = pauseWorkout(workout, 2_000);
  workout = resumeWorkout(workout, 60_000);
  const result = appendWorkoutTrackPoint(workout, { latitude: 37.001, longitude: 127, timestamp: 61_000, accuracy: 5 }, 2);
  assert.equal(result.distanceMeters, 0);
  assert.equal(workout.distanceMeters, 0);
});

test("rejects GPS teleport samples from workout distance", () => {
  const workout = createWorkoutSession(0);
  appendWorkoutTrackPoint(workout, { latitude: 37, longitude: 127, timestamp: 1_000, accuracy: 5 }, 2);
  const result = appendWorkoutTrackPoint(workout, { latitude: 37.01, longitude: 127, timestamp: 2_000, accuracy: 5 }, 2);
  assert.equal(result.accepted, false);
  assert.equal(workout.distanceMeters, 0);
});

test("counts off-route entries only at false to true transitions", () => {
  const workout = createWorkoutSession(0);
  recordOffRouteTransition(workout, false, true);
  recordOffRouteTransition(workout, true, true);
  recordOffRouteTransition(workout, true, false);
  recordOffRouteTransition(workout, false, true);
  assert.equal(workout.offRouteCount, 2);
});

test("calculates average pace from moving time and distance", () => {
  assert.equal(averagePaceSecondsPerKm(1_000, 300), 300);
  assert.equal(averagePaceSecondsPerKm(10, 3), null);
});

test("selects a recovery target ahead of confirmed progress", () => {
  const index = createRouteIndex([{ latitude: 37, longitude: 127 }, { latitude: 37.002, longitude: 127 }]);
  const target = selectRecoveryTarget(index, 80, 60);
  assert.ok(target.progressMeters >= 140);
});

test("samples a movement point after minimum distance or interval", () => {
  const workout = createWorkoutSession(0);
  appendWorkoutTrackPoint(workout, { latitude: 37, longitude: 127, timestamp: 1_000, accuracy: 5 }, 2);
  const rejected = appendWorkoutTrackPoint(workout, { latitude: 37.000005, longitude: 127, timestamp: 2_000, accuracy: 5 }, 2);
  const accepted = appendWorkoutTrackPoint(workout, { latitude: 37.000005, longitude: 127, timestamp: 14_000, accuracy: 5 }, 2);
  assert.equal(rejected.accepted, false);
  assert.equal(accepted.accepted, true);
});

test("builds a workout summary with completion and average pace", () => {
  const workout = createWorkoutSession(0);
  workout.distanceMeters = 1_000;
  workout.movingSeconds = 300;
  const summary = createWorkoutSummary(workout, 400_000, 2_000, "편도형", [{ latitude: 37, longitude: 127 }, { latitude: 37.001, longitude: 127 }], 0.5);
  assert.equal(summary.averagePaceSecondsPerKm, 300);
  assert.equal(summary.completionRatio, 0.5);
});
