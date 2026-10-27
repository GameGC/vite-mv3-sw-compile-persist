/**
 * Master E2E Test Suite Runner
 *
 * Executes all 4 tiers of E2E test suites:
 * - Tier 1: Feature Coverage (75 tests across 15 areas)
 * - Tier 2: Boundary & Corner Cases (40 tests across 8 areas)
 * - Tier 3: Cross-Feature Combinations (22 tests across 10 areas)
 * - Tier 4: Real-World Application Scenarios (20 tests across 4 areas)
 *
 * Total: 157 automated test cases
 */

import { TestHarness } from './harness.js';
import { runTier1 } from './tier1-feature-coverage.test.js';
import { runTier2 } from './tier2-boundary-corner.test.js';
import { runTier3 } from './tier3-cross-feature.test.js';
import { runTier4 } from './tier4-application-scenarios.test.js';
import { runTier5 as runTier5Compiler } from './tier5-compiler-adversarial.test.js';
import { runTier5 as runTier5Runtime } from './tier5-runtime-adversarial.test.js';

async function main() {
  console.log('================================================================');
  console.log('    VITE-MV3-PERSISTENT MASTER E2E TEST RUNNER');
  console.log('    Requirement-Driven & Opaque-Box Acceptance Testing');
  console.log('================================================================');

  const harness = new TestHarness();
  const startTime = Date.now();

  try {
    console.log('\n>>> Executing Tier 1: Feature Coverage Tests <<<');
    await runTier1(harness);

    console.log('\n>>> Executing Tier 2: Boundary & Corner Case Tests <<<');
    await runTier2(harness);

    console.log('\n>>> Executing Tier 3: Cross-Feature Combination Tests <<<');
    await runTier3(harness);

    console.log('\n>>> Executing Tier 4: Real-World Application Scenarios <<<');
    await runTier4(harness);

    console.log('\n>>> Executing Tier 5A: Compiler Adversarial Hardening <<<');
    await runTier5Compiler(harness);

    console.log('\n>>> Executing Tier 5B: Runtime & Simulator Adversarial Hardening <<<');
    await runTier5Runtime(harness);
  } catch (err) {
    console.error('Fatal test runner error:', err);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const summary = harness.getSummary();

  console.log('\n================================================================');
  console.log(`E2E TEST EXECUTION SUMMARY (${durationSec}s)`);
  console.log('================================================================');
  console.log(`Total Test Cases Executed : ${summary.total}`);
  console.log(`Passed                    : ${summary.passed}`);
  console.log(`Failed                    : ${summary.failed}`);
  console.log(`Pass Rate                 : ${((summary.passed / summary.total) * 100).toFixed(1)}%`);

  if (summary.failed > 0) {
    console.log('\nDiscovered Failures / Compiler Defects:');
    summary.results
      .filter((r) => !r.passed)
      .forEach((r, idx) => {
        console.log(`  ${idx + 1}. [${r.suite}] ${r.name}`);
        if (r.error) {
          const msg = typeof r.error === 'string' ? r.error : r.error.message;
          console.log(`     Reason: ${msg}`);
        }
      });
  }

  console.log('================================================================\n');

  // Exit code: 0 if all passed, 1 if any failed
  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Unhandled runner error:', err);
  process.exit(1);
});
