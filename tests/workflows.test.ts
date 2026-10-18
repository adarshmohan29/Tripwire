import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { ZodError } from 'zod';
import { buildMock } from '../mock/server.ts';
import { actions } from '../src/actions.ts';
import { delay } from '../src/backoff.ts';
import { loadWorkflows } from '../src/workflows.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('valid workflow file loads', async () => {
  const workflows = await loadWorkflows(fileURLToPath(new URL('../workflows', import.meta.url)));
  expect(workflows.get('order.created')).toEqual({
    on: 'order.created',
    max_attempts: 5,
    steps: [
      { id: 'charge', action: 'http.post', url: 'http://mock:4000/charge' },
      { id: 'notify', action: 'http.post', url: 'http://mock:4000/notify' },
    ],
  });
});

test('invalid workflow file is rejected with a zod error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-'));
  await writeFile(
    join(dir, 'bad.yaml'),
    'on: order.created\nmax_attempts: 3\nsteps:\n  - id: charge\n    action: http.post\n',
  );
  await expect(loadWorkflows(dir)).rejects.toMatchObject({
    message: expect.stringContaining('bad.yaml'),
    cause: expect.any(ZodError),
  });
});

test('http.post sends Idempotency-Key eventId:stepId', async () => {
  const mock = buildMock();
  const url = await mock.listen({ host: '127.0.0.1', port: 0 });
  await actions['http.post'](
    { id: 'evt-1', payload: {} },
    { id: 'charge', action: 'http.post', url: `${url}/charge` },
  );
  const stats = (await mock.inject({ method: 'GET', url: '/stats' })).json<{
    calls: { name: string; key: string }[];
  }>();
  await mock.close();
  expect(stats.calls).toEqual([{ name: 'charge', key: 'evt-1:charge' }]);
});

test('http.post fails after 5s timeout', { timeout: 10_000 }, async () => {
  // forceCloseConnections lets close() drop the request this server never answers.
  const hang = Fastify({ forceCloseConnections: true });
  hang.post('/', () => new Promise(() => {}));
  const url = await hang.listen({ host: '127.0.0.1', port: 0 });
  const started = Date.now();
  await expect(
    actions['http.post']({ id: 'evt-1', payload: {} }, { id: 'charge', action: 'http.post', url }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  await hang.close();
});

test('backoff delay grows with attempt and stays within jitter bounds', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  expect([1, 2, 3, 10].map(delay)).toEqual([1000, 2000, 4000, 15_000]);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  expect(delay(3)).toBe(0);
  vi.spyOn(Math, 'random').mockReturnValue(0.999);
  expect(delay(20)).toBeLessThan(30_000);
});
