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

## Subscriber onboarding

Single canonical onboarding entry point. Read this section in full before
adding a project — it covers the design assumptions plus the per-project
steps.

### Prerequisite: ASD bootstrap

cc-watcher is operational scaffolding, not session discipline. Subscribing a
project to cc-watcher does NOT install session-open / session-close protocol
adherence. If the target project has not yet run
`Adapters/cross-project-asd-bootstrap.md` (which locks the four cross-project
ASD memory entries), do that first in a Desktop session for that project.
cc-watcher subscription is a follow-up to ASD installation, not a substitute.

### What you do NOT need

These are common assumptions that are wrong:

- **No per-project Slack webhook.** A single `SLACK_WEBHOOK_URL` secret in
  this cc-watcher repo handles all alerts to the operator's DM channel. Every
  subscriber's HIGH-severity events (workflow failures, parse errors, missed
  fetches) route through the same webhook. Subscribers do NOT add their own
  Slack credentials.
- **No new subscriber repo.** Subscribers use their existing project repos.
  cc-watcher is the only new repo introduced by this system.
- **No required adapter amendment.** TCG amended its ASD adapter to v2.6 to
  surface pending entries inline at session-open — that decision was driven by
  TCG's daily cron cadence and high-frequency Product-briefing surface. Other
  projects may decide differently based on their own session cadence. The
  amendment is optional, not a subscription requirement.

### Per-project steps

Three steps, each one-time, all small:

1. **Author `.cc-watcher.yml` at the subscriber repo's root.**
   Project-specific relevance keywords. Tune to what the project actually
   cares about — `tcg-portal/.cc-watcher.yml` is the working reference, but
   keywords should be derived from the subscribing project's adapter, not
   copied verbatim. TCG cares about MCP / auth / cron / skill / sub-agent /
   headless; a research project might care about context window / prompt
   caching / reasoning budget / model deprecation. Different projects, different
   keyword sets. YAML pitfall: bare `key: value` lines parse as mappings (e.g.
   `context: fork` becomes a sub-mapping) — quote them as strings:
   `'context: fork'`.

2. **Operator generates a fine-grained PAT** with `contents: write` scope on
   the subscriber repo only, then adds it as a cc-watcher secret named
   `SUBSCRIBER_PAT_<SLUG_UPPER_SNAKE>`. PAT scope is one repo, never broader.

3. **Operator appends the subscriber to `subscribers.yml`** in this repo:
   `{ slug, repo, config_path }`. The slug must match the secret name's
   `<SLUG_UPPER_SNAKE>` after case conversion.

### Verification

After onboarding, trigger workflow_dispatch manually in the cc-watcher repo
Actions tab. Verify within ~2 minutes:

- A commit lands in the subscriber repo at `config_path` (or wherever the
  subscriber's `.cc-watcher.yml` declared its pending-review log path).
- `state/version-history.jsonl` in this repo gets a new entry.
- The Slack DM summarizes the run (success or, if there's a problem,
  failure with traceback).

If no commit lands, the most common cause is a YAML keyword pitfall in the
subscriber's `.cc-watcher.yml` — see step 1.

### HARD RULE — operator-explicit, cross-project

cc-watcher subscriber projects NEVER use `--dangerously-skip-permissions` in
any CC dispatch. The 2.1.126 widening of that flag (bypass extended to
`.claude/`, `.git/`, `.vscode/`, shell RCs) is incompatible with the
credential-leak threat model — even partial use risks cascading credential
rotation. This rule applies to TCG already (TCG memory entry #25); the same
reasoning extends to every subscriber. If a subscriber's CC instruction
prompts include this flag, halt onboarding and remove it before proceeding.

## Architecture

- Source of truth: `github.com/anthropics/claude-code/raw/refs/heads/main/CHANGELOG.md`
- Workflow: `.github/workflows/daily-fetch.yml`
- Parser: `scripts/fetch-and-process.mjs` (Node.js, single dep: js-yaml)
- State: `state/last-seen-version.txt` + `state/version-history.jsonl` (committed)
- Subscribers: `subscribers.yml` + per-subscriber `.cc-watcher.yml` in their repo
- Notifications: Slack webhook (`SLACK_WEBHOOK_URL` secret)

## Migration runbook

See `MIGRATION.md`.
