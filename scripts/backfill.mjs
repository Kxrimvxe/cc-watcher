#!/usr/bin/env node
// backfill.mjs
// One-shot helper to retroactively process versions missed by the old broken
// Windows Task Scheduler cron. Sets FORCE_BASELINE and invokes the same
// fetch-and-process logic.
//
// Usage:
//   node scripts/backfill.mjs <baseline-version>
//   e.g. node scripts/backfill.mjs 2.1.126
//   This will treat 2.1.126 as the last-seen version and process everything
//   newer than that on the canonical changelog (e.g. 2.1.127, 2.1.128, ...).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , baseline] = process.argv;
if (!baseline || !/^\d+\.\d+\.\d+$/.test(baseline)) {
  console.error('Usage: node scripts/backfill.mjs <baseline-version>  (e.g. 2.1.126)');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fetchScript = path.join(__dirname, 'fetch-and-process.mjs');

console.log(`Running backfill with FORCE_BASELINE=${baseline}`);
const result = spawnSync('node', [fetchScript], {
  stdio: 'inherit',
  env: { ...process.env, FORCE_BASELINE: baseline },
});

process.exit(result.status ?? 1);
