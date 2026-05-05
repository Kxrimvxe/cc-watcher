#!/usr/bin/env node
// fetch-and-process.mjs
// Fetch Claude Code changelog, diff against state, write pending-review entries
// to each subscriber's repo. Invoked by .github/workflows/daily-fetch.yml.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO_ROOT, 'state');
const LAST_SEEN_FILE = path.join(STATE_DIR, 'last-seen-version.txt');
const VERSION_HISTORY_FILE = path.join(STATE_DIR, 'version-history.jsonl');
const SUBSCRIBERS_FILE = path.join(REPO_ROOT, 'subscribers.yml');

const CHANGELOG_URL = 'https://github.com/anthropics/claude-code/raw/refs/heads/main/CHANGELOG.md';

// --- semver ---
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

// --- changelog parser (matches Anthropic CHANGELOG.md format) ---
function parseChangelog(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(\d+\.\d+\.\d+)\s*$/);
    if (heading) {
      if (current) blocks.push(current);
      current = { version: heading[1], date: null, bullets: [] };
      continue;
    }
    if (!current) continue;
    if (!current.date) {
      const dateMatch = line.match(/^\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s*$/);
      if (dateMatch) {
        current.date = dateMatch[1];
        continue;
      }
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) current.bullets.push(bullet[1].trim());
  }
  if (current) blocks.push(current);
  return blocks;
}

// --- relevance scoring ---
function scoreRelevance(bulletText, keywords) {
  const matched = [];
  const lowerBullet = bulletText.toLowerCase();
  for (const kw of keywords) {
    if (lowerBullet.includes(kw.toLowerCase())) matched.push(kw);
  }
  return matched;
}

// --- GitHub API helpers ---
async function ghGetContent(repo, branch, filePath, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GET ${url} failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { sha: data.sha, content: Buffer.from(data.content, 'base64').toString('utf-8') };
}

async function ghPutContent(repo, branch, filePath, content, sha, message, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch
  };
  if (sha) body.sha = sha;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`PUT ${url} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

function slugToEnvVar(slug) {
  return `SUBSCRIBER_PAT_${slug.replace(/-/g, '_').toUpperCase()}`;
}

// --- subscriber processing ---
async function processSubscriber(sub, newBlocks, runTimestamp) {
  const envVar = slugToEnvVar(sub.slug);
  const pat = process.env[envVar];
  if (!pat) {
    return { slug: sub.slug, status: 'skipped', reason: `missing ${envVar} secret`, entries_added: 0 };
  }

  // 1. Fetch subscriber's .cc-watcher.yml
  const configFile = await ghGetContent(sub.repo, sub.branch, sub.config_path, pat);
  if (!configFile) {
    return { slug: sub.slug, status: 'skipped', reason: `${sub.config_path} not found in ${sub.repo}@${sub.branch}`, entries_added: 0 };
  }
  const config = yaml.load(configFile.content);
  if (!config?.keywords || !config?.pending_review_path || !config?.last_reviewed_path) {
    return { slug: sub.slug, status: 'skipped', reason: 'config missing required fields', entries_added: 0 };
  }

  // 2. Build pending-review entries
  const entries = [];
  for (const blk of newBlocks) {
    for (const bullet of blk.bullets) {
      const matched = scoreRelevance(bullet, config.keywords);
      const status = matched.length > 0 ? 'pending' : 'acknowledged';
      entries.push({
        discovered_at: runTimestamp,
        version: blk.version,
        release_date: blk.date,
        text: bullet,
        status,
        matched_keywords: matched,
        note: matched.length > 0
          ? `cc-watcher: matched ${matched.length} keyword(s); flagged for review`
          : 'cc-watcher: no keyword match; logged for audit'
      });
    }
  }

  if (entries.length === 0) {
    return { slug: sub.slug, status: 'no-op', reason: 'no new bullets', entries_added: 0 };
  }

  // 3. Append to pending-review JSONL
  const existing = await ghGetContent(sub.repo, sub.branch, config.pending_review_path, pat);
  const existingContent = existing?.content || '';
  const newJsonlLines = entries.map(e => JSON.stringify(e)).join('\n');
  const updatedContent = existingContent === '' || existingContent.endsWith('\n')
    ? existingContent + newJsonlLines + '\n'
    : existingContent + '\n' + newJsonlLines + '\n';

  const versionsLabel = newBlocks.map(b => b.version).join(', ');
  await ghPutContent(
    sub.repo,
    sub.branch,
    config.pending_review_path,
    updatedContent,
    existing?.sha || null,
    `cc-watcher: append ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${versionsLabel}`,
    pat
  );

  // 4. Update last-reviewed JSON
  const lastReviewedFile = await ghGetContent(sub.repo, sub.branch, config.last_reviewed_path, pat);
  let lastReviewed = lastReviewedFile
    ? JSON.parse(lastReviewedFile.content)
    : { schema_version: 'v1.0', review_history: [] };
  const latestVersion = newBlocks[newBlocks.length - 1].version;
  lastReviewed.tcg_changelog_review = runTimestamp;
  lastReviewed.tcg_pending_review_last_processed = runTimestamp;
  lastReviewed.last_seen_version_at_review = latestVersion;
  lastReviewed.review_history = lastReviewed.review_history || [];
  lastReviewed.review_history.push({
    reviewed_at: runTimestamp,
    last_seen_version_at_review: latestVersion,
    session: 'cc-watcher-automated',
    entries_added: entries.length,
    trigger: `daily-fetch picked up ${newBlocks.length} new version(s): ${versionsLabel}`
  });

  await ghPutContent(
    sub.repo,
    sub.branch,
    config.last_reviewed_path,
    JSON.stringify(lastReviewed, null, 2) + '\n',
    lastReviewedFile?.sha || null,
    `cc-watcher: update last-reviewed for ${latestVersion}`,
    pat
  );

  return {
    slug: sub.slug,
    status: 'updated',
    entries_added: entries.length,
    pending: entries.filter(e => e.status === 'pending').length,
    acknowledged: entries.filter(e => e.status === 'acknowledged').length,
    versions: newBlocks.map(b => b.version)
  };
}

// --- main orchestrator ---
async function main() {
  const runTimestamp = new Date().toISOString();
  const startMs = Date.now();

  // 1. Read baseline (or override via FORCE_BASELINE for backfill)
  let lastSeen;
  if (process.env.FORCE_BASELINE) {
    lastSeen = process.env.FORCE_BASELINE.trim();
    console.log(`Override baseline: ${lastSeen}`);
  } else {
    try {
      lastSeen = (await readFile(LAST_SEEN_FILE, 'utf-8')).trim();
    } catch {
      lastSeen = null;
    }
  }
  console.log(`Baseline: ${lastSeen ?? '(first run — no baseline)'}`);

  // 2. Fetch canonical changelog
  const resp = await fetch(CHANGELOG_URL);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
  const markdown = await resp.text();
  console.log(`Fetched changelog: ${markdown.length} bytes`);

  // 3. Parse versions
  const blocks = parseChangelog(markdown);
  if (blocks.length === 0) {
    throw new Error('Parser found zero versions — likely format change. Investigate.');
  }
  const latest = blocks[0].version;
  console.log(`Latest version on canonical: ${latest}`);

  // 4. Determine new versions (chronological order: oldest first)
  const newBlocks = lastSeen
    ? blocks.filter(b => compareSemver(b.version, lastSeen) > 0).reverse()
    : []; // First run: establish baseline only, no entries
  console.log(`New versions vs baseline: ${newBlocks.length} (${newBlocks.map(b => b.version).join(', ') || '(none)'})`);

  // 5. Process subscribers (only if there are new bullets to distribute)
  const subscribersConfig = yaml.load(await readFile(SUBSCRIBERS_FILE, 'utf-8'));
  const subscriberResults = [];
  if (newBlocks.length > 0) {
    for (const sub of subscribersConfig.subscribers || []) {
      try {
        const result = await processSubscriber(sub, newBlocks, runTimestamp);
        subscriberResults.push(result);
        console.log(`Subscriber ${sub.slug}: ${JSON.stringify(result)}`);
      } catch (err) {
        const result = { slug: sub.slug, status: 'error', error: err.message };
        subscriberResults.push(result);
        console.error(`Subscriber ${sub.slug} ERROR: ${err.message}`);
      }
    }
  }

  // 6. Update cc-watcher state files
  const durationMs = Date.now() - startMs;
  const historyEntry = {
    ts: runTimestamp,
    baseline_before: lastSeen,
    latest_after: latest,
    new_versions: newBlocks.map(b => b.version),
    subscribers: subscriberResults,
    duration_ms: durationMs
  };
  await appendFile(VERSION_HISTORY_FILE, JSON.stringify(historyEntry) + '\n', 'utf-8');
  if (newBlocks.length > 0 || !lastSeen) {
    await writeFile(LAST_SEEN_FILE, latest, 'utf-8');
  }

  // 7. Emit GHA outputs
  const summary = newBlocks.length === 0
    ? `no-op (baseline ${latest})`
    : `${newBlocks.length} new version(s): ${newBlocks.map(b => b.version).join(', ')} → ${subscriberResults.length} subscriber(s) processed`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `run_summary=${summary}\n`, 'utf-8');
  }
  console.log(`SUMMARY: ${summary}`);

  // Fail loud if any subscriber errored
  const errored = subscriberResults.filter(r => r.status === 'error');
  if (errored.length > 0) {
    console.error(`${errored.length} subscriber(s) errored — failing run`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run_summary=ERROR: ${err.message}\n`, 'utf-8');
  }
  process.exit(1);
});
