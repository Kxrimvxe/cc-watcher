#!/usr/bin/env node
// notify-slack.mjs
// Posts a Slack message via the configured webhook. Called by daily-fetch.yml
// on success and on failure.
//
// Usage: node scripts/notify-slack.mjs <success|failure> "<message>"

const [, , status, message] = process.argv;

if (!status || !message) {
  console.error('Usage: notify-slack.mjs <success|failure> "<message>"');
  process.exit(1);
}

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.warn('SLACK_WEBHOOK_URL not set — skipping notification.');
  process.exit(0);
}

const emoji = status === 'success' ? ':white_check_mark:' : ':x:';
const heading = status === 'success' ? 'cc-watcher OK' : 'cc-watcher FAILED';
const payload = { text: `${emoji} *${heading}* — ${message}` };

const resp = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

if (!resp.ok) {
  console.error(`Slack webhook failed: ${resp.status} ${await resp.text()}`);
  process.exit(1);
}

console.log(`Slack notified (${status}).`);
