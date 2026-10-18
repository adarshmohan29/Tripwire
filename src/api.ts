import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { applySchema } from './db.ts';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ ok: true }));
  return app;
}

// Tests import buildApp without starting a server.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await applySchema();
  await buildApp().listen({ host: '0.0.0.0', port: config.PORT });
}
