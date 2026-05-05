# Migration — retiring Windows Task Scheduler entries

This document covers the one-shot migration from the local Windows Task
Scheduler entries to `cc-watcher` GitHub Actions.

## Tasks being retired

| Task | Function | Replacement |
|---|---|---|
| `ClaudeCodeOps-Update` | Daily `npm install -g @anthropic-ai/claude-code@latest` + log to `version-history.jsonl` | **Retired with no replacement.** Claude Code auto-updates on launch — the local update task is redundant. The audit trail moves to cc-watcher's own `state/version-history.jsonl` (which logs Anthropic's published version, not the operator's local install). |
| `ClaudeCodeOps-Changelog` | Daily fetch + parse changelog + write `pending-review.jsonl` | **Replaced by cc-watcher.** GHA workflow `daily-fetch.yml` does the same work, hosted in the cloud, with Slack alerting and a per-subscriber relevance config. |
| `TCGPortal-DriftAudit` | Daily `npx tsx scripts/agents/matching-drift.ts` (logs only, no commit) | **Retired with no replacement.** Redundant with the Vercel cron `/api/cron/matching-drift` which already runs the audit cloud-side and writes findings to Supabase. The local task only created a log file. |

## Pre-flight (before retiring)

1. `cc-watcher` repo created on GitHub.
2. Secrets configured in cc-watcher repo:
   - `CCWATCHER_PUSH_TOKEN` — fine-grained PAT, contents:write on cc-watcher repo only (used to commit state updates back).
   - `SUBSCRIBER_PAT_TCG_PORTAL` — fine-grained PAT, contents:write on `Kxrimvxe/tcg-portal` only (used to write pending-review entries).
   - `SLACK_WEBHOOK_URL` — incoming webhook URL for the channel/DM you want notifications in.
3. `tcg-portal/.cc-watcher.yml` committed (relevance keywords).
4. First manual workflow run via `workflow_dispatch`:
   - With `force_baseline=2.1.126` to backfill 2.1.127 + 2.1.128.
   - Confirm Slack notification arrived.
   - Confirm `tcg-portal/docs/06-control/cc-ops-pending-review-tcg.jsonl` got new entries.
5. Verify next scheduled fire timestamp in GHA UI.

## Retirement (run after pre-flight green)

PowerShell, elevated:

```powershell
Unregister-ScheduledTask -TaskName 'ClaudeCodeOps-Update' -Confirm:$false
Unregister-ScheduledTask -TaskName 'ClaudeCodeOps-Changelog' -Confirm:$false
Unregister-ScheduledTask -TaskName 'TCGPortal-DriftAudit' -Confirm:$false
```

Verify removal:

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -match 'ClaudeCodeOps|TCGPortal' }
# Should return nothing.
```

## Rollback (if needed)

The original PowerShell scripts remain at:
- `~/Desktop/Adapters\claude-code-ops\bin\update-claude-code.ps1`
- `~/Desktop/Adapters\claude-code-ops\bin\fetch-changelog-delta.ps1`
- `~/Desktop/tcg-portal\scripts\ops\drift-audit-scheduled.ps1`

Re-register via:
- `~/Desktop/Adapters\claude-code-ops\bin\register-scheduled-tasks.ps1`

## State migration — last-seen baseline

Seed `cc-watcher/state/last-seen-version.txt` with `2.1.126` (committed in repo).
First scheduled run will discover 2.1.127 + 2.1.128 + anything newer and dispatch
to subscribers. Equivalent to the operator's prior `last-seen-version.txt` value
in `Adapters/claude-code-ops/state/`.

The shared `Adapters/claude-code-ops/state/` directory can stay on disk as
historical reference; nothing reads it after retirement.
