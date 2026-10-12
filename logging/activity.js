import { color, logger } from './logger.js';

/** @type {Map<string, string>} */
const nameCache = new Map();

/**
 * Pad a tag to a fixed width before coloring so columns line up.
 * @param {string} label
 * @param {(s: string) => string} paint
 */
const tag = (label, paint) => paint(label.padEnd(10));

/**
 * @param {string} text
 * @param {number} max
 */
export function truncate(text, max = 80) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Resolve a user or channel ID to a readable name, cached; falls back to the ID.
 * @param {string} key
 * @param {() => Promise<string | undefined>} lookup
 */
async function cachedName(key, lookup) {
  const cached = nameCache.get(key);
  if (cached) return cached;
  const name = (await lookup().catch(() => undefined)) || key;
  nameCache.set(key, name);
  return name;
}

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} userId
 */
function userName(client, userId) {
  return cachedName(userId, async () => {
    const res = await client.users.info({ user: userId });
    return `@${res.user?.profile?.display_name || res.user?.name}`;
  });
}

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 */
function channelName(client, channelId) {
  if (channelId.startsWith('D')) return Promise.resolve('');
  return cachedName(channelId, async () => {
    const res = await client.conversations.info({ channel: channelId });
    return res.channel?.name ? `#${res.channel.name}` : undefined;
  });
}

/**
 * Summarize tool input, collapsing long strings (like HTML dashboards) to their length.
 * @param {Record<string, unknown>} input
 */
function summarizeInput(input) {
  const parts = Object.entries(input ?? {}).map(([k, v]) => {
    if (typeof v === 'string') return `${k}: ${v.length > 60 ? `<${v.length} chars>` : v}`;
    if (Array.isArray(v)) return `${k}: [${v.length}]`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return parts.length ? color.dim(`{${parts.join(', ')}}`) : '';
}

/**
 * @param {import('../agent/agent.js').AgentDeps | undefined} deps
 */
function sourceLabel(deps) {
  if (!deps) return 'local';
  if (deps.isCodeChannel) return 'code ch';
  if (deps.isPassive) return 'listen';
  if (deps.channelId.startsWith('D')) return 'DM';
  return 'mention';
}

export const activity = {
  /**
   * @param {import('../agent/agent.js').AgentDeps | undefined} deps
   * @param {string} text
   */
  async incoming(deps, text) {
    const where = deps
      ? [await channelName(deps.client, deps.channelId), await userName(deps.client, deps.userId)]
          .filter(Boolean)
          .join(' ')
      : '';
    logger.activity(tag(`← ${sourceLabel(deps)}`, color.cyan), `${color.bold(where)} "${truncate(text)}"`);
  },

  /**
   * @param {string} name - Tool name, possibly MCP-prefixed.
   * @param {Record<string, unknown>} input
   */
  tool(name, input) {
    const shortName = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '');
    logger.activity(tag('⚙ tool', color.magenta), `${shortName} ${summarizeInput(input)}`);
  },

  /**
   * @param {string} message
   */
  toolError(message) {
    logger.activity(tag('✗ error', color.red), truncate(message, 160));
  },

  /**
   * @param {{chars: number, ms: number, tools: number}} stats
   */
  reply({ chars, ms, tools }) {
    logger.activity(
      tag('→ reply', color.green),
      color.dim(`${chars} chars · ${(ms / 1000).toFixed(1)}s · ${tools} tools`),
    );
  },

  /**
   * @param {number} ms
   */
  skip(ms) {
    logger.activity(
      tag('· skip', color.dim),
      color.dim(`not an analytics question (NO_REPLY) · ${(ms / 1000).toFixed(1)}s`),
    );
  },
};
