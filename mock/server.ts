import Fastify from 'fastify';
import { config } from '../src/config.ts';

const app = Fastify({ logger: true });
app.get('/health', async () => ({ ok: true }));
await app.listen({ host: '0.0.0.0', port: config.PORT });
