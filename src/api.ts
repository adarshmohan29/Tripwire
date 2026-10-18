import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.ts';
import { applySchema, getEvent, insertEvent, listDead, replay, stats } from './db.ts';

const webhookBody = z.looseObject({ type: z.string().min(1) });
const eventParams = z.object({ id: z.uuid() });

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Keep the raw body so the dedup hash covers the exact bytes the sender sent.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/health', async () => ({ ok: true }));

  app.post<{ Params: { source: string }; Body: string }>('/webhooks/:source', async (req, reply) => {
    const body = webhookBody.safeParse(parseJson(req.body));
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const header = req.headers['x-event-id'];
    const idemKey =
      typeof header === 'string' ? header : createHash('sha256').update(req.body).digest('hex');
    const result = await insertEvent(req.params.source, idemKey, body.data.type, body.data);
    return reply.code(202).send(result);
  });

  app.get('/events/:id', async (req, reply) => {
    const params = eventParams.safeParse(req.params);
    const event = params.success ? await getEvent(params.data.id) : undefined;
    if (!event) return reply.code(404).send({ error: 'not found' });
    return event;
  });

  app.get('/dead', async () => listDead());

  app.post('/dead/:id/replay', async (req, reply) => {
    const params = eventParams.safeParse(req.params);
    if (!params.success || !(await replay(params.data.id))) {
      return reply.code(404).send({ error: 'no dead event with that id' });
    }
    return reply.code(202).send({ id: params.data.id });
  });

  app.get('/stats', async () => stats());

  return app;
}

// Tests import buildApp without starting a server.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await applySchema();
  await buildApp().listen({ host: '0.0.0.0', port: config.PORT });
}
