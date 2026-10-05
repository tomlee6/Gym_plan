import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const server = createApp().listen(config.port, () => {
  console.log(`Gym Plan API on :${config.port} (${config.env}, storage: ${config.storage.driver})`);
});

// Part uploads can be large and slow on mobile signal.
server.requestTimeout = 15 * 60 * 1000;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}
