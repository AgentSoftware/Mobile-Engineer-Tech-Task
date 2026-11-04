import { networkInterfaces } from 'node:os';
import { buildApp } from './app.js';

const env = (name, fallback) => Number(process.env[name] ?? fallback);
const port = env('PORT', 3000);

const app = buildApp({
  latency: [env('LATENCY_MIN_MS', 200), env('LATENCY_MAX_MS', 900)],
  failureRate: env('FAILURE_RATE', 0),
  logRequests: process.env.LOG_REQUESTS !== '0',
});
await app.listen({ host: '0.0.0.0', port });

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i.family === 'IPv4' && !i.internal)?.address;
console.log(`
Doorstep API is running
  Local:    http://localhost:${port}
  Network:  ${lan ? `http://${lan}:${port}` : 'no network interface found'}
  Sign in:  alex.morgan@example.com / doorstep
`);
