import { inspect } from 'node:util';

import { LogLevel } from '@slack/bolt';

// The Slack CLI pipes output, so don't gate colors on isTTY; opt out with NO_COLOR
const useColor = !process.env.NO_COLOR;

/**
 * @param {string} code
 */
const ansi = (code) => (/** @type {string} */ text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

export const color = {
  dim: ansi('2'),
  bold: ansi('1'),
  red: ansi('31'),
  green: ansi('32'),
  yellow: ansi('33'),
  blue: ansi('34'),
  magenta: ansi('35'),
  cyan: ansi('36'),
};

/** @type {Record<string, number>} */
const SEVERITY = { [LogLevel.ERROR]: 400, [LogLevel.WARN]: 300, [LogLevel.INFO]: 200, [LogLevel.DEBUG]: 100 };

const LEVEL_LABELS = {
  [LogLevel.ERROR]: color.red('ERROR'),
  [LogLevel.WARN]: color.yellow('WARN '),
  [LogLevel.INFO]: color.blue('INFO '),
  [LogLevel.DEBUG]: color.dim('DEBUG'),
};

function timestamp() {
  return color.dim(new Date().toTimeString().slice(0, 8));
}

/**
 * @param {any[]} msg
 */
function formatArgs(msg) {
  return msg.map((m) => (typeof m === 'string' ? m : inspect(m, { colors: useColor, depth: 4 }))).join(' ');
}

/**
 * A Bolt-compatible logger with timestamps and colors. Level defaults to LOG_LEVEL or info.
 */
class PrettyLogger {
  /** @type {LogLevel} */
  level = /** @type {LogLevel} */ (process.env.LOG_LEVEL?.toLowerCase() || LogLevel.INFO);
  name = '';

  getLevel() {
    return this.level;
  }

  /**
   * @param {LogLevel} level
   */
  setLevel(level) {
    this.level = level;
  }

  /**
   * @param {string} name
   */
  setName(name) {
    this.name = name;
  }

  /**
   * @param {LogLevel} level
   */
  isEnabled(level) {
    return SEVERITY[level] >= (SEVERITY[this.level] ?? SEVERITY[LogLevel.INFO]);
  }

  /**
   * @param {LogLevel} level
   * @param {any[]} msg
   */
  write(level, msg) {
    if (!this.isEnabled(level)) return;
    const name = this.name ? `${color.dim(this.name)} ` : '';
    const text = formatArgs(msg);
    const line = `${timestamp()}  ${LEVEL_LABELS[level]} ${name}${level === LogLevel.DEBUG ? color.dim(text) : text}`;
    (level === LogLevel.ERROR || level === LogLevel.WARN ? console.error : console.log)(line);
  }

  /** @param {any[]} msg */
  debug(...msg) {
    this.write(LogLevel.DEBUG, msg);
  }

  /** @param {any[]} msg */
  info(...msg) {
    this.write(LogLevel.INFO, msg);
  }

  /** @param {any[]} msg */
  warn(...msg) {
    this.write(LogLevel.WARN, msg);
  }

  /** @param {any[]} msg */
  error(...msg) {
    this.write(LogLevel.ERROR, msg);
  }

  /**
   * Activity lines: the readable "what is the agent doing" feed, shown at info and below.
   * @param {string} tag - Short pre-colored label, e.g. "← DM".
   * @param {string} text
   */
  activity(tag, text) {
    if (!this.isEnabled(LogLevel.INFO)) return;
    console.log(`${timestamp()}  ${tag} ${text}`);
  }
}

export const logger = new PrettyLogger();
