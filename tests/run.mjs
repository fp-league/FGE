/**
 * Run every suite and fail if any of them does.
 *
 * Each suite is a standalone script that prints its own results and exits
 * non-zero on a failure — no framework, no config, no watch mode. They can
 * each be run on their own (`node tests/econ.test.mjs`) while working on
 * the thing they cover; this is what CI calls.
 *
 *   node tests/run.mjs            all of them, quietly
 *   node tests/run.mjs -v         with each suite's own output
 *   node tests/run.mjs econ book  only suites whose name contains these
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const filters = args.filter(a => !a.startsWith('-'));

const suites = readdirSync(here)
  .filter(f => /\.test\.(mjs|js)$/.test(f))
  .filter(f => !filters.length || filters.some(q => f.includes(q)))
  .sort();

if (!suites.length) {
  console.error(filters.length ? `No suite matches ${filters.join(', ')}` : 'No suites found.');
  process.exit(1);
}

// Suites print their own totals in a few different shapes; this reads the
// count back out so the summary can add them up.
function countsIn(text) {
  const slash = text.match(/(\d+)\s*\/\s*(\d+)\s+passed/);
  if (slash) return { passed: +slash[1], total: +slash[2] };
  const words = text.match(/(\d+)\s+passed,\s*(\d+)\s+failed/);
  if (words) return { passed: +words[1], total: +words[1] + +words[2] };
  return null;
}

let failed = 0, passed = 0, total = 0;
const started = Date.now();

for (const suite of suites) {
  const run = spawnSync(process.execPath, [path.join(here, suite)], {
    encoding: 'utf8',
    cwd: here,
  });
  const out = (run.stdout || '') + (run.stderr || '');
  const n = countsIn(out);
  const ok = run.status === 0;

  if (n) { passed += n.passed; total += n.total; }
  if (!ok) failed++;

  const tally = n ? `${n.passed}/${n.total}` : (ok ? 'ok' : 'crashed');
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${suite.padEnd(20)} ${tally}`);

  // A failing suite's output is always shown, whatever the flags: a CI log
  // that says only "FAIL" is a log you have to reproduce locally to read.
  if (verbose || !ok) {
    console.log(out.split('\n').map(l => '      ' + l).join('\n'));
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${suites.length} suites, ${passed}/${total} checks, ${secs}s`);
if (failed) {
  console.log(`${failed} suite${failed === 1 ? '' : 's'} failed`);
  process.exit(1);
}
