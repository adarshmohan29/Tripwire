import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../src/config.ts';

const effectBody = z.looseObject({ poison: z.boolean().optional() });

export function buildMock(): FastifyInstance {
  const app = Fastify({ logger: true });
  const calls: { name: string; key: string }[] = [];
  const applied = new Map<string, number>();

  app.get('/health', async () => ({ ok: true }));

  app.post<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') return reply.code(400).send({ error: 'Idempotency-Key required' });
    calls.push({ name: req.params.name, key });
    if (config.MOCK_LATENCY_MS > 0) await sleep(config.MOCK_LATENCY_MS);
    if (effectBody.safeParse(req.body).data?.poison) {
      return reply.code(500).send({ error: 'poison' });
    }
    if (config.MOCK_DEDUPE && applied.has(key)) return { ok: true, key };
    applied.set(key, (applied.get(key) ?? 0) + 1);
    // The effect is applied but the caller never hears so: the lost response that
    // idempotency keys exist for.
    if (Math.random() < config.MOCK_FAIL_RATE) {
      return reply.code(500).send({ error: 'lost response' });
    }
    return { ok: true, key };
  });

  app.get('/stats', async () => ({ calls, applied: Object.fromEntries(applied) }));

  app.post('/reset', async () => {
    calls.length = 0;
    applied.clear();
    return { ok: true };
  });

  return app;
}

// Tests import buildMock without starting a server.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildMock().listen({ host: '0.0.0.0', port: config.PORT });
}
