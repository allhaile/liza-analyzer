import 'dotenv/config';

import { App } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';
import { logger } from './logging/logger.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // Set LOG_LEVEL=debug to see every Slack API request and socket frame
  logger,
  logLevel: logger.getLevel(),
  ignoreSelf: false,
});

registerListeners(app);

(async () => {
  await app.start();
  app.logger.info('Liza Analyzer is running!');
})();
