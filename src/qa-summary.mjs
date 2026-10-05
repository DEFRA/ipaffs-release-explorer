// Only aggregate counts leave the server; test names, error messages and
// attachments remain in ADO. Never infer test success from the build outcome.
export function normalizeTestSummary(data) {
  const analysis = data?.aggregatedResultsAnalysis;
  const total = analysis?.totalTests;
  const outcomes = analysis?.resultsByOutcome;
  const unavailable = { availability: 'unavailable' };
  if (!Number.isSafeInteger(total) || total < 0 || !outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) return unavailable;
  let passed = 0, failed = 0, skipped = 0, counted = 0;
  for (const [outcome, result] of Object.entries(outcomes)) {
    const count = result?.count;
    if (!Number.isSafeInteger(count) || count < 0) return unavailable;
    counted += count;
    switch (outcome.toLowerCase()) {
      case 'passed': passed += count; break;
      case 'failed': failed += count; break;
      case 'notexecuted': case 'notapplicable': skipped += count; break;
    }
  }
  // Partial or inconsistent summaries must not produce a reassuring percentage.
  if (counted !== total) return unavailable;
  const executed = total - skipped;
  const passPercentage = executed === 0 ? null : passed === executed ? 100
    : Math.min(99.9, Math.round(passed / executed * 1000) / 10);
  return { availability: 'available', total, passed, failed, skipped,
    other: total - passed - failed - skipped, executed, passPercentage };
}
