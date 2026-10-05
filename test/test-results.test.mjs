import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTestSummary } from '../src/qa-summary.mjs';

const summary = (totalTests, counts) => ({ aggregatedResultsAnalysis: {
  totalTests, resultsByOutcome: Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, { count }])),
} });

test('pass percentage excludes skipped tests but retains their count', () => {
  assert.deepEqual(normalizeTestSummary(summary(100, { Passed: 81, Failed: 9, NotExecuted: 10 })), {
    availability: 'available', total: 100, passed: 81, failed: 9, skipped: 10, other: 0, executed: 90, passPercentage: 90,
  });
  assert.equal(normalizeTestSummary(summary(100, { Passed: 90, NotExecuted: 10 })).passPercentage, 100);
});

test('other outcomes count against pass percentage and near-perfect results do not round to 100', () => {
  assert.equal(normalizeTestSummary(summary(100, { Passed: 90, Inconclusive: 10 })).passPercentage, 90);
  assert.equal(normalizeTestSummary(summary(10000, { Passed: 9999, Failed: 1 })).passPercentage, 99.9);
});

test('empty or all-skipped suites do not claim a pass percentage', () => {
  assert.equal(normalizeTestSummary(summary(0, {})).passPercentage, null);
  assert.equal(normalizeTestSummary(summary(5, { NotExecuted: 5 })).passPercentage, null);
});

test('missing, partial and inconsistent results are unavailable rather than inferred', () => {
  for (const data of [null, {}, summary(100, { Passed: 99 }), summary(1, { Passed: 2 }),
    summary(1, { Passed: '1' }), summary(1, { Passed: -1 }), summary('1', { Passed: 1 })]) {
    assert.deepEqual(normalizeTestSummary(data), { availability: 'unavailable' });
  }
});
