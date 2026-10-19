'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectConfidenceThreshold } = require('../server/prediction/confidenceThreshold');
const settingsService = require('../server/services/settingsService');

test('defaults: confidence mode is auto with a floor of 30', () => {
  const engine = settingsService.toEngineSettings(settingsService.defaults());
  assert.equal(engine.confidenceMode, 'auto');
  assert.equal(engine.minConfidence, 30);
});

test('auto: strong pool keeps the preferred 72 gate', () => {
  const pool = Array.from({ length: 20 }, (_, i) => 90 - i); // 90..71
  const r = detectConfidenceThreshold(pool, { minSelections: 2, candidatePoolSize: 16 });
  assert.equal(r.mode, 'auto');
  assert.equal(r.floor, 30);
  assert.equal(r.effective, 72);
  assert.equal(r.source, 'AUTO_TARGET_MET');
  assert.ok(r.passing >= 16);
});

test('auto: weak day lowers the gate to fill the pool, never below 30', () => {
  const pool = [58, 55, 52, 49, 46, 44, 41, 38, 35, 33];
  const r = detectConfidenceThreshold(pool, { minSelections: 2, candidatePoolSize: 16 });
  assert.equal(r.effective, 33); // weakest of the 10 available
  assert.ok(r.effective >= 30);
  assert.equal(r.enoughForTicket, true);
});

test('auto: floor is hard — sub-30 candidates never qualify', () => {
  const r = detectConfidenceThreshold([29, 25, 20], { minSelections: 2, candidatePoolSize: 16 });
  assert.equal(r.effective, 30);
  assert.equal(r.passing, 0);
  assert.equal(r.enoughForTicket, false);
  assert.equal(r.source, 'AUTO_FLOOR');
});

test('auto: at least the minimum selections are kept when the pool is thin at the top', () => {
  const r = detectConfidenceThreshold([80, 45, 20, 15], { minSelections: 2, candidatePoolSize: 16 });
  assert.equal(r.effective, 45);
  assert.equal(r.passing, 2);
});

test('auto: a raised floor is honoured', () => {
  const r = detectConfidenceThreshold([50, 48, 46], { minConfidence: 47, minSelections: 2, candidatePoolSize: 16 });
  assert.equal(r.floor, 47);
  assert.ok(r.effective >= 47);
  assert.equal(r.passing, 2); // only 50 and 48 clear 47
});

test('fixed: configured value is the exact gate (legacy behaviour)', () => {
  const r = detectConfidenceThreshold([90, 40, 35], { mode: 'fixed', minConfidence: 72 });
  assert.equal(r.effective, 72);
  assert.equal(r.source, 'FIXED_SETTING');
  assert.equal(r.passing, 1);
});

test('auto: no candidates detects to the floor', () => {
  const r = detectConfidenceThreshold([], {});
  assert.equal(r.effective, 30);
  assert.equal(r.source, 'AUTO_NO_CANDIDATES');
});
