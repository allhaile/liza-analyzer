# Liza Analyzer

A Slack agent built on Claude with the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview). It uses the agent view, assistant panel, code channels, and the [Slack MCP Server](https://github.com/slackapi/slack-mcp-server). Built from the [Bolt JS starter agent](https://github.com/slack-samples/bolt-js-starter-agent).

I add a new agent pattern or Slack platform feature every week. Star or watch the repo to follow along.

## Build log

| Week of | Added |
|---------|-------|
| 2026-10-12 | slack.dev analytics Q&A in DMs, @mentions, and passive channel listening. Code channels with context bar, HTML dashboard, and session status. Slack MCP Server. Bedrock and Anthropic API setup. |

Want to see something built? Open an issue.

## What it does

| Surface | Behavior |
|---------|----------|
| DMs and assistant panel | Replies in a thread and keeps context across follow-ups |
| @mentions | Replies in a thread in any channel it's in |
| Passive listening | Answers analytics questions in channels it's in, no @mention needed |
| Code channels | For bigger asks ("build me a dashboard"), creates a code channel with a context bar, HTML dashboard, and summary |
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
listeners/actions/      Feedback buttons
listeners/views/        Block Kit builders
thread-context/         Thread → session ID store
logging/                Logger and activity feed
data/page-metrics.csv   Sample analytics data (fabricated)
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
