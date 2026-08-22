import assert from "node:assert/strict";
import test from "node:test";
import { circularEma, createRouteIndex, findUpcomingNavigationStep, findUpcomingTurn, matchRoute, pointAtDistance, projectPointToRouteProgress, routeWindow, selectMovementHeading, updateArrivalSampleCount } from "./navigation.ts";
import { validateRequiredSegmentGeometry } from "./required-segment.ts";

test("uses physical distance rather than polyline point density", () => {
  const index = createRouteIndex([
    { latitude: 0, longitude: 0 },
    { latitude: 0.0001, longitude: 0 },
    { latitude: 0.0101, longitude: 0 },
  ]);
  const point = pointAtDistance(index, 500);
  assert.ok(Math.abs(point.latitude - 0.0045) < 0.0005);
});

test("returns a local route window with exact start and end points", () => {
  const index = createRouteIndex([
    { latitude: 37, longitude: 127 },
    { latitude: 37.001, longitude: 127 },
    { latitude: 37.002, longitude: 127 },
  ]);
  const points = routeWindow(index, 30, 150);
  assert.ok(points.length >= 2);
  assert.ok(Math.abs(points[0].latitude - pointAtDistance(index, 30).latitude) < 0.000001);
  assert.ok(Math.abs(points.at(-1)!.latitude - pointAtDistance(index, 150).latitude) < 0.000001);
});

test("does not jump from a circular route start to its final segment", () => {
  const index = createRouteIndex([
    { latitude: 37, longitude: 127 },
    { latitude: 37.001, longitude: 127 },
    { latitude: 37.001, longitude: 127.001 },
    { latitude: 37, longitude: 127 },
  ]);
  const result = matchRoute(index, { latitude: 37, longitude: 127 }, { previousProgressMeters: 0, accuracyMeters: 5 });
  assert.equal(result.matched, true);
  if (result.matched) assert.equal(result.segmentIndex, 0);
});

test("uses heading and continuity to distinguish an out-and-back return", () => {
  const index = createRouteIndex([
    { latitude: 37, longitude: 127 },
    { latitude: 37.001, longitude: 127 },
    { latitude: 37, longitude: 127 },
  ]);
  const result = matchRoute(index, { latitude: 37.0005, longitude: 127 }, { previousProgressMeters: 130, accuracyMeters: 5, movementHeading: 180, speedMetersPerSecond: 2 });
  assert.equal(result.matched, true);
  if (result.matched) assert.equal(result.segmentIndex, 1);
});

test("detects a sharp turn with meter-based samples and ignores a gentle curve", () => {
  const rightAngle = createRouteIndex([
    { latitude: 37, longitude: 127 }, { latitude: 37.0003, longitude: 127 },
    { latitude: 37.0003, longitude: 127.0003 }, { latitude: 37.0003, longitude: 127.0005 },
  ]);
  assert.equal(findUpcomingTurn(rightAngle, 15, 30).type, "right");
  const gentleCurve = createRouteIndex([
    { latitude: 37, longitude: 127 }, { latitude: 37.0002, longitude: 127 },
    { latitude: 37.00035, longitude: 127.00008 }, { latitude: 37.00045, longitude: 127.00023 },
    { latitude: 37.0005, longitude: 127.00042 },
  ]);
  assert.equal(findUpcomingTurn(gentleCurve, 0, 60).type, "straight");
});

test("smooths across the 359°/1° boundary", () => {
  const value = circularEma(359, 1, 0.5);
  assert.ok(value < 2 || value > 358);
});

test("resets arrival confirmation whenever a sample is unmatched or unreliable", () => {
  assert.equal(updateArrivalSampleCount(2, false), 0);
  assert.equal(updateArrivalSampleCount(2, true), 3);
});

test("does not feed stale orientation heading into matcher input", () => {
  assert.equal(selectMovementHeading({ gpsHeading: null, speedMetersPerSecond: null, orientationHeading: 130, orientationUpdatedAt: 1_000, now: 5_000, maxOrientationAgeMs: 3_500 }), null);
  assert.equal(selectMovementHeading({ gpsHeading: 80, speedMetersPerSecond: 1.3, orientationHeading: 130, orientationUpdatedAt: 1_000, now: 5_000, maxOrientationAgeMs: 3_500 }), 80);
});

test("projects navigation step anchors onto route geometry progress and finds the next step", () => {
  const index = createRouteIndex([{ latitude: 37, longitude: 127 }, { latitude: 37.001, longitude: 127 }]);
  const projection = projectPointToRouteProgress(index, { latitude: 37.0005, longitude: 127 });
  assert.ok(projection && projection.progressMeters > 50 && projection.progressMeters < 65);
  const step = findUpcomingNavigationStep([{ progressMeters: 20, distanceMeters: 10, guidance: "첫 안내" }, { progressMeters: 70, distanceMeters: 10, guidance: "다음 안내" }], 50);
  assert.equal(step?.guidance, "다음 안내");
});

test("returns explicit unmatched state when no spatial candidate is nearby", () => {
  const index = createRouteIndex([{ latitude: 37, longitude: 127 }, { latitude: 37.001, longitude: 127 }]);
  const result = matchRoute(index, { latitude: 37.1, longitude: 127.1 }, { previousProgressMeters: 0, accuracyMeters: 5 });
  assert.equal(result.matched, false);
});

test("recomputes required segment distance and rejects a forged client distance", () => {
  const result = validateRequiredSegmentGeometry({
    start: { latitude: 37, longitude: 127 }, end: { latitude: 37.001, longitude: 127 },
    route: [{ latitude: 37, longitude: 127 }, { latitude: 37.0005, longitude: 127 }, { latitude: 37.001, longitude: 127 }], distanceKm: 1,
  });
  assert.equal(result.valid, false);
});
