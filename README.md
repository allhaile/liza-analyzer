# Liza Analyzer

A Slack agent built on Claude with the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). It uses the agent view, assistant panel, code channels, and the [Slack MCP Server](https://github.com/slackapi/slack-mcp-server). Built from the [Bolt JS starter agent](https://github.com/slack-samples/bolt-js-starter-agent).

I add a new agent pattern or Slack platform feature every week. Star or watch the repo to follow along.

## Build log

| Week of | Added |
|---------|-------|
| 2026-10-19 | [Proactive mode](#proactive-mode): a weekly digest and anomaly alerts posted on a schedule (node-cron, in-process). Same-weekday baseline anomaly detection. Native Block Kit charts (`data_visualization`) and a sortable `data_table`. Investigate / Snooze / Not an issue buttons, where Investigate opens a code channel. `/liza-run-digest` slash command. JSON state store. |
| 2026-10-12 | slack.dev analytics Q&A in DMs, @mentions, and passive channel listening. Code channels with context bar, HTML dashboard, and session status. Slack MCP Server. Bedrock and Anthropic API setup. |

Want to see something built? Open an issue.

## What it does

| Surface | Behavior |
|---------|----------|
| DMs and assistant panel | Replies in a thread and keeps context across follow-ups |
| @mentions | Replies in a thread in any channel it's in |
| Passive listening | Answers analytics questions in channels it's in, no @mention needed |
| Code channels | For bigger asks ("build me a dashboard"), creates a code channel with a context bar, HTML dashboard, and summary |
| Proactive alerts | Posts a weekly digest with charts, plus anomaly alerts, to one alerts channel on a schedule. See [Proactive mode](#proactive-mode) |
| App Home | Welcome view |
| Slack MCP Server | Searches messages, reads channels, sends messages, and manages canvases (OAuth mode) |

## How Claude is wired in

All in `runAgent()` in [`agent/agent.js`](./agent/agent.js):

1. Custom tools are defined with `tool()` and bundled into an MCP server with `createSdkMcpServer()`.
2. The Slack MCP Server is added when a user token is available.
3. `query()` runs the agent with the system prompt and channel context.
4. The session ID is saved per thread and passed back as `resume` for follow-ups.

### Tools

| Tool | File |
|------|------|
| `add_emoji_reaction` | `agent/agent.js` |
| `describe_page_metrics`, `query_page_metrics` | `agent/page-metrics.js` |
| `create_code_channel`, `post_message`, `set_context_bar`, `set_html_view`, `set_summary_message`, `set_session_status`, `rename_session` | `agent/code-channel-tools.js` |

### Layout

```
app.js                  Socket Mode entry point
app-oauth.js            HTTP + OAuth entry point
manifest.json           Slack app config
agent/                  Claude setup, system prompt, tools
listeners/events/       DMs, mentions, App Home, passive listener, code channels
listeners/actions/      Feedback buttons, alert buttons (Investigate, Snooze, Not an issue)
listeners/commands/     /liza-run-digest
listeners/views/        Block Kit builders, including the digest and alert messages
thread-context/         Thread → session ID store
proactive/              Config, anomaly detection, weekly digest, scheduler, state store
logging/                Logger and activity feed
data/page-metrics.csv   Sample analytics data (fabricated)
data/known-events.json  Launches and events, used for "Possible cause" in alerts
```

## Setup

### Prerequisites

- Node.js 20+
- [Slack CLI](https://docs.slack.dev/tools/slack-cli/), logged in with `slack login`
- A [developer sandbox](https://api.slack.com/developer-program) workspace
- Claude access through Amazon Bedrock or an Anthropic API key

### 1. Clone and install

```sh
git clone git@github.com:allhaile/liza-analyzer.git
cd liza-analyzer
npm install
cp .env.sample .env
```

### 2. Connect Claude

Use one option in `.env`.

**Amazon Bedrock**

```sh
CLAUDE_CODE_USE_BEDROCK=1
AWS_PROFILE=YOUR_AWS_PROFILE
AWS_REGION=us-east-1
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-5
```

Then run `aws sso login --profile YOUR_AWS_PROFILE`.

**Anthropic API key**

```sh
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
```

### 3. Run it

```sh
slack run
```

The CLI creates a dev app from [`manifest.json`](./manifest.json) on first run. To rename the bot, edit `display_information.name` and `bot_user.display_name` first.

### 4. Turn on Slack MCP (optional)

1. Run `slack app settings`.
2. Open **Agents & AI Apps**.
3. Toggle **Slack Model Context Protocol** on.

MCP needs a user token, so run in [OAuth mode](#oauth-mode).

### 5. Try it

- DM: "What were the top 3 pages by sessions last week?"
- DM: "Build me a dashboard of how the /go pages are doing."
- Invite the bot to a channel and post: "Which landing page has the best CTA click rate?"
- Set `ALERTS_CHANNEL_ID`, then run `/liza-run-digest` to post the weekly digest and alerts to that channel.

The terminal shows each message, tool call, and reply.

## Make it your own

- **Data:** swap `data/page-metrics.csv`, or replace `agent/page-metrics.js` with your own data source.
- **Tools:** add them to `createSdkMcpServer()` and `ALLOWED_TOOLS` in `agent/agent.js`.
- **Prompt:** edit `SYSTEM_PROMPT` in `agent/agent.js`.
- **Passive listening:** edit `ANALYTICS_PATTERN` in `listeners/events/analytics-listener.js` and `PASSIVE_PROMPT` in `agent/agent.js`.

## Development

```sh
npm start          # run without the CLI (needs SLACK_BOT_TOKEN and SLACK_APP_TOKEN)
npm test
npm run lint
npm run lint:fix
npm run check      # type check
```

`LOG_LEVEL=debug` for verbose logs. `NO_COLOR=1` for plain output.

### OAuth mode

1. Run `ngrok http 3000` and copy the URL.
2. In `manifest.json`, set `socket_mode_enabled` to `false` and replace `ngrok-free.app` with your ngrok domain.
3. Run `slack install -E local`, then copy Client ID, Client Secret, and Signing Secret from `slack app settings` into `.env`:

   ```sh
   SLACK_CLIENT_ID=YOUR_CLIENT_ID
   SLACK_CLIENT_SECRET=YOUR_CLIENT_SECRET
   SLACK_SIGNING_SECRET=YOUR_SIGNING_SECRET
   SLACK_REDIRECT_URI=https://YOUR_NGROK_SUBDOMAIN.ngrok-free.app/slack/oauth_redirect
   ```

4. Run `slack run app-oauth.js` and open the install URL.

When ngrok restarts, update the URL in `manifest.json` and `.env`, then reinstall.

## Troubleshooting

**`App is not enabled for Slack MCP server access`:** turn on Slack MCP (step 4).

**No reply in a channel:** invite the bot. Passive replies only fire on analytics questions; @mention it for anything else.

**Code channel tools fail:** confirm the app has the `code_channels:manage` scope and reinstall.

**No digest posts:** check the startup log. `Proactive mode off` means `ALERTS_CHANNEL_ID` isn't set. `not_in_channel` means the bot needs an invite to the alerts channel.

**`/liza-run-digest` doesn't appear:** the manifest adds the slash command and the `commands` scope, so accept the app update when `slack run` prompts, or reinstall.

## Proactive mode

Liza posts a weekly digest and anomaly alerts to one dedicated channel, unprompted. A node-cron job runs inside the app process (Socket Mode has no inbound HTTP, so nothing external triggers it). The code lives in [`proactive/`](./proactive).

### Config

Set these in `.env`. Only `ALERTS_CHANNEL_ID` is required. If it's unset, the app runs normally, logs `Proactive mode off`, and skips the job.

| Variable | Default | What it does |
|----------|---------|--------------|
| `ALERTS_CHANNEL_ID` | unset | The only channel proactive posts go to. Invite the bot to it. |
| `DIGEST_CRON` | `0 9 * * 1` | When the digest runs (Mondays 9:00) |
| `DIGEST_TZ` | `America/New_York` | Timezone for `DIGEST_CRON` |
| `Z_THRESHOLD` | `2` | Minimum \|z\| vs. baseline to flag a day |
| `MIN_SESSIONS` | `50` | Days with less traffic are ignored |
| `MIN_PERSISTENCE_DAYS` | `2` | Consecutive flagged days needed... |
| `BIG_MOVE_MULTIPLIER` | `1.5` | ...unless one day hits \|z\| ≥ `Z_THRESHOLD × BIG_MOVE_MULTIPLIER` |
| `STEADY_BAND_PCT` | `10` | Overall week-over-week change under this counts as steady |
| `KNOWN_EVENTS_ENABLED` | `true` | Add "Possible cause" from [`data/known-events.json`](./data/known-events.json) |

State (last run, snoozes, dismissals) is kept in `data/proactive-state.json`, which is gitignored. Override the path with `PROACTIVE_STATE_FILE`.

### What it posts

The digest covers the latest complete Monday–Sunday week in the data and compares it to the week before. It reports overall and by page type (go, learn, events, open-source), then runs anomaly detection.

- **Anomalies found:** a short digest message with a native bar chart of sessions by page type (last week vs. this week) and a sortable data table of every anomaly, each row with an **Investigate** button. One alert per anomaly goes in its thread (max 5, ranked by |z|). Each alert shows sessions, CTA rate, avg engaged time, and the date range, plus a native line chart of the report week against its same-weekday 4-week average (the exact comparison the detector makes) and three buttons:
  - **Investigate** opens a code channel with a dashboard, built by the existing code channel tools.
  - **Snooze 7d** mutes that page and metric for a week.
  - **Not an issue** dismisses this move. A later, separate move still alerts.
- **No anomalies, but overall WoW is outside the band:** the digest message alone.
- **Nothing dramatic:** one 2–3 line "all steady" note.

If the job fails, it logs the error and posts one line to the alerts channel.

### Run it on demand

Run `/liza-run-digest` from any channel. It posts to the alerts channel only and replies to you ephemerally. Manual runs don't count as the week's scheduled run. Scheduled runs record the ISO week, so restarting the app doesn't post twice.

### How the thresholds work

For each page, every day in the report week is compared with the **same weekday** over the previous 4 weeks, using the mean and standard deviation. Monday is compared with the four prior Mondays, so the normal weekend dip is never flagged. Sessions and CTA click rate are checked separately.

A day is flagged when |z| ≥ `Z_THRESHOLD` and it has at least `MIN_SESSIONS` (for a sessions dip, the baseline's traffic also counts). Consecutive flagged days in the same direction form one move. A move is reported if it lasts `MIN_PERSISTENCE_DAYS`, or if its peak |z| reaches `Z_THRESHOLD × BIG_MOVE_MULTIPLIER`. `detectAnomalies()` in [`proactive/anomalies.js`](./proactive/anomalies.js) is a pure function; tests are in `tests/proactive/`.

Four baseline points give a noisy standard deviation, so z-scores run high on smooth data. If alerts are chatty, raise `Z_THRESHOLD` (3 is a reasonable next step) before touching the other knobs.
