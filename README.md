# cc-watcher

Daily Claude Code changelog watcher. Replaces the broken Windows Task Scheduler
entries `ClaudeCodeOps-Update` + `ClaudeCodeOps-Changelog` with a cloud-hosted
GitHub Actions cron that never sleeps and never drifts.

## What it does

Every day at 03:30 UTC (05:30 CEST):

1. Fetches `https://github.com/anthropics/claude-code/raw/refs/heads/main/CHANGELOG.md`
   (canonical source — never cached stale).
2. Parses version blocks newer than `state/last-seen-version.txt`.
3. For every subscriber in `subscribers.yml`, fetches that subscriber's
   `.cc-watcher.yml` from its repo, scores each new bullet against the declared
   keywords, and commits per-project pending-review entries to the subscriber's
   repo at the path the subscriber declares.
4. Updates `state/last-seen-version.txt` and `state/version-history.jsonl` in
   this repo.
5. Posts a Slack DM summarizing the run (success or failure).

## Why this replaces what we had

| Failure mode in old setup | Why GHA fixes it |
|---|---|
| PC asleep during 03:30 CEST → cron skipped | GHA runners never sleep |
| Trigger time drifted (PC catch-up runs late) | YAML cron is exact, no drift |
| Mintlify served stale changelog (cached 2.1.126) | Raw GitHub URL never caches |
| Silent miss — no alert when fetch fails | Slack DM every run + GHA UI history |
| Per-project changelog parse logic duplicated | One workflow serves all projects |

## Subscribing a new project

1. In the project's repo, author `.cc-watcher.yml` at root (see
   `tcg-portal/.cc-watcher.yml` for the working example).
2. In `cc-watcher/subscribers.yml`, append a `{ slug, repo, config_path }` entry.
3. Generate a fine-grained PAT with `contents: write` on the subscriber repo and
   add it as a cc-watcher secret named `SUBSCRIBER_PAT_<SLUG_UPPER_SNAKE>`.
4. Done. Next daily fire picks it up.

## Architecture

- Source of truth: `github.com/anthropics/claude-code/raw/refs/heads/main/CHANGELOG.md`
- Workflow: `.github/workflows/daily-fetch.yml`
- Parser: `scripts/fetch-and-process.mjs` (Node.js, single dep: js-yaml)
- State: `state/last-seen-version.txt` + `state/version-history.jsonl` (committed)
- Subscribers: `subscribers.yml` + per-subscriber `.cc-watcher.yml` in their repo
- Notifications: Slack webhook (`SLACK_WEBHOOK_URL` secret)

## Migration runbook

See `MIGRATION.md`.
