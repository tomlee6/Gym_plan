/**
 * Container health check (D-11): exits 0 when this container's process
 * answers its /health. The API listens on PORT; the worker on
 * WORKER_HEALTH_PORT. Which one is set by HEALTH_PORT, else PORT.
 */
import http from 'node:http';

const port = Number(process.env.HEALTH_PORT ?? process.env.PORT ?? 8080);
const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
