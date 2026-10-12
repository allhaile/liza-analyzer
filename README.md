# Liza Analyzer: a Slack agent built on Claude

A reference Slack agent that shows how to connect Claude (via the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)) to Slack's agent building experience: the agent view, the assistant panel, code channels, and the [Slack MCP Server](https://github.com/slackapi/slack-mcp-server).

It started from the [Bolt JS starter agent](https://github.com/slack-samples/bolt-js-starter-agent) template and adds a real use case: answering questions about slack.dev landing page analytics, and building HTML dashboards in a dedicated code channel when a question needs deeper analysis.

Clone it, point it at your own Claude access (Amazon Bedrock or an Anthropic API key), and use it as a pattern for your own agent.

## What's in this repo

### What the agent can do

| Surface | Behavior |
|---------|----------|
| **DMs and assistant panel** | Chat with the agent directly. It replies in a thread and remembers context across follow-ups. |
| **@mentions** | Mention the agent in any channel it's in, and it replies in a thread. |
| **Passive listening** | In channels it's been invited to, the agent watches for analytics questions ("how are the /go pages doing?") and replies in a thread without being @mentioned. It stays quiet on false positives (e.g. "sessions" meaning meetings). |
| **Code channels** | For multi-step requests ("build me a dashboard"), the agent creates a code channel. It then sets a context bar, renders an HTML dashboard view, posts a summary, and updates its session status as it works. |
| **App Home** | Welcome view with instructions. |
| **Slack MCP Server** | When a user token is available (OAuth mode), the agent can search messages, read channels and threads, send messages, and manage canvases. |

### How Claude is wired in

Everything runs through `runAgent()` in [`agent/agent.js`](./agent/agent.js):

1. Custom tools are defined with `tool()` and Zod schemas, then bundled into an in-process MCP server with `createSdkMcpServer()`.
2. If the user has a token, the hosted Slack MCP Server (`https://mcp.slack.com/mcp`) is added as a second MCP server.
3. `query()` runs the agent with a system prompt plus per-request context (channel ID, whether this is a code channel or an overheard message).
4. The SDK's `session_id` is saved per Slack thread in [`thread-context/store.js`](./thread-context/store.js) and passed back as `resume`, so follow-ups keep their context.

### Tools

| Tool | File | Purpose |
|------|------|---------|
| `add_emoji_reaction` | `agent/agent.js` | Reacts to the user's message with a fitting emoji |
| `describe_page_metrics`, `query_page_metrics` | `agent/page-metrics.js` | Describe and query the analytics dataset. The math happens in code, not in the model. |
| `create_code_channel`, `post_message`, `set_context_bar`, `set_html_view`, `set_summary_message`, `set_session_status`, `rename_session` | `agent/code-channel-tools.js` | Create and drive a code channel |

### Project layout

```
app.js                    Socket Mode entry point
app-oauth.js              HTTP + OAuth entry point (enables Slack MCP via user tokens)
manifest.json             Slack app config: agent view, code channels, scopes, events
agent/                    Claude Agent SDK setup, system prompt, and tools
listeners/events/         DMs, mentions, App Home, passive analytics listener, code channel handler
listeners/actions/        Feedback buttons
listeners/views/          Block Kit builders
thread-context/           In-memory thread → session ID store (24h TTL)
logging/                  Pretty Bolt logger and a readable "what is the agent doing" activity feed
data/page-metrics.csv     Fabricated sample analytics data used by the page-metrics tools
```

## Set it up for yourself

### Prerequisites

- Node.js 20+
- The [Slack CLI](https://docs.slack.dev/tools/slack-cli/), logged in with `slack login`
- A Slack workspace where you can install apps. Use a [developer sandbox](https://api.slack.com/developer-program) rather than a workspace with real users. Code channels must be enabled in the workspace for the code channel features to work.
- Access to Claude, either through **Amazon Bedrock** (an AWS profile with Bedrock access) or through an **Anthropic API key**

### 1. Clone and install

```sh
git clone git@github.com:allhaile/liza-analyzer.git
cd liza-analyzer
npm install
cp .env.sample .env
```

### 2. Connect Claude

Pick **one** option and fill it in `.env`.

**Option A: Amazon Bedrock.** Use this if your team gets Claude through AWS, e.g. the same profile you use for Claude Code.

```sh
CLAUDE_CODE_USE_BEDROCK=1
AWS_PROFILE=YOUR_AWS_PROFILE
AWS_REGION=us-east-1
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-5
# Only if the profile lives outside ~/.aws/config:
# AWS_CONFIG_FILE=~/.aws/YOUR_CONFIG_FILE
```

Sign in before running the app, and again whenever the session expires:

```sh
aws sso login --profile YOUR_AWS_PROFILE
```

**Option B: Anthropic API key.** Remove the Bedrock variables and set:

```sh
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
```

### 3. Create the Slack app and run it

```sh
slack run
```

The first time you run this, the Slack CLI asks which workspace to use and creates a dev app from [`manifest.json`](./manifest.json). You don't need any Slack tokens in `.env` for this mode.

Want your own name? Change `display_information.name` and `bot_user.display_name` in `manifest.json` before your first `slack run`.

### 4. Enable the Slack MCP Server (optional)

There's no manifest property for this yet, so turn it on by hand:

1. Run `slack app settings`.
2. Open **Agents & AI Apps**.
3. Toggle **Slack Model Context Protocol** on.

The agent only connects to the Slack MCP Server when it has a user token, which means running in OAuth mode (see [OAuth HTTP mode](#oauth-http-mode-optional)).

### 5. Try it

- **DM the agent:** "What were the top 3 pages by sessions last week?"
- **Ask for a deeper analysis:** "Build me a dashboard of how the /go pages are doing." The agent creates a code channel and links you to it.
- **Test passive listening:** `/invite @Liza Analyzer` to a channel, then post "anyone know which landing page has the best CTA click rate?" without mentioning the agent.

Watch the terminal for the activity feed, which shows each incoming message, tool call, and reply.

## Make it your own

- **Swap the data:** replace `data/page-metrics.csv` with your own export (same columns), or replace `agent/page-metrics.js` with tools that hit your real data source.
- **Add tools:** define them with `tool()` the same way as in `agent/page-metrics.js`, add them to the `tools` array in `createSdkMcpServer()`, and add their names to `ALLOWED_TOOLS` in `agent/agent.js`.
- **Change the personality or the rules:** edit `SYSTEM_PROMPT` in `agent/agent.js`.
- **Tune passive listening:** adjust `ANALYTICS_PATTERN` in `listeners/events/analytics-listener.js` (a cheap keyword prefilter) and `PASSIVE_PROMPT` in `agent/agent.js` (where the model decides whether to reply or return `NO_REPLY`).

## Development

```sh
npm start          # run without the Slack CLI (requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env)
npm test           # unit tests (node --test)
npm run lint       # Biome lint + format check
npm run lint:fix   # auto-fix
npm run check      # JSDoc type check
```

Set `LOG_LEVEL=debug` for verbose logs, or `NO_COLOR=1` to turn off colored output.

### OAuth HTTP mode (optional)

OAuth mode is required for the Slack MCP Server, because the agent needs each user's token.

1. Start a tunnel with `ngrok http 3000` and copy the `https://*.ngrok-free.app` URL.
2. In `manifest.json`, set `socket_mode_enabled` to `false` and replace `ngrok-free.app` with your ngrok domain.
3. Create the app with `slack install -E local`, then run `slack app settings` and copy the **Client ID**, **Client Secret**, and **Signing Secret** into `.env`:

   ```sh
   SLACK_CLIENT_ID=YOUR_CLIENT_ID
   SLACK_CLIENT_SECRET=YOUR_CLIENT_SECRET
   SLACK_SIGNING_SECRET=YOUR_SIGNING_SECRET
   SLACK_REDIRECT_URI=https://YOUR_NGROK_SUBDOMAIN.ngrok-free.app/slack/oauth_redirect
   ```

4. Run `slack run app-oauth.js` and open the install URL printed in the terminal.

Each ngrok restart gives you a new URL. When that happens, update `manifest.json` and `SLACK_REDIRECT_URI`, then reinstall the app.

## Troubleshooting

**`App is not enabled for Slack MCP server access`:** toggle on **Slack Model Context Protocol** under **Agents & AI Apps** in `slack app settings` (see step 4).

**Bedrock auth errors (`ExpiredToken`, `Could not load credentials`):** run `aws sso login --profile YOUR_AWS_PROFILE` again, and check that `AWS_PROFILE`, `AWS_REGION`, and (if you use it) `AWS_CONFIG_FILE` in `.env` are correct.

**The agent doesn't reply in a channel:** invite it with `/invite @Liza Analyzer`. Passive replies only fire on analytics-sounding messages. For anything else, @mention the agent.

**Code channel tools fail:** check that code channels are enabled in your workspace and that the app has the `code_channels:manage` scope (reinstall after manifest changes).
