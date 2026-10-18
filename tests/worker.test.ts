import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { buildMock } from '../mock/server.ts';
import { buildApp } from '../src/api.ts';
import { applySchema, getEvent, insertEvent, pool, recordStep } from '../src/db.ts';
import { work } from '../src/worker.ts';
import type { Workflow } from '../src/workflows.ts';

const mock = buildMock();
const app = buildApp();
let mockUrl: string;

beforeAll(async () => {
  await applySchema();
  mockUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
});
// work() claims any claimable row, so each test needs a table it controls.
beforeEach(async () => {
  await pool.query('TRUNCATE events CASCADE');
  await mock.inject({ method: 'POST', url: '/reset' });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mock.close();
  await app.close();
  await pool.end();
});

function workflows(maxAttempts = 3, notifyPath = '/notify'): Map<string, Workflow> {
  return new Map([
    [
      'order.created',
      {
        on: 'order.created',
        max_attempts: maxAttempts,
        steps: [
          { id: 'charge', action: 'http.post', url: `${mockUrl}/charge` },
          { id: 'notify', action: 'http.post', url: `${mockUrl}${notifyPath}` },
        ],
      },
    ],
  ]);
}

async function queue(payload: object = {}): Promise<string> {
  return (await insertEvent('test', randomUUID(), 'order.created', payload)).id;
}

async function calledSteps(): Promise<string[]> {
  const res = await mock.inject({ method: 'GET', url: '/stats' });
  return res.json<{ calls: { name: string }[] }>().calls.map((c) => c.name);
}

test('steps run in order', async () => {
  const id = await queue();
  await work(workflows());
  expect(await calledSteps()).toEqual(['charge', 'notify']);
  expect(await getEvent(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
});

test('step already in step_effects is skipped', async () => {
  const id = await queue();
  await recordStep(id, 'charge');
  await work(workflows());
  expect(await calledSteps()).toEqual(['notify']);
});

test('failed event is requeued with future next_run_at', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const id = await queue({ poison: true });
  await work(workflows());
  const event = await getEvent(id);
  expect(event).toMatchObject({ status: 'queued', last_error: expect.stringContaining('500') });
  expect(event?.next_run_at.getTime()).toBeGreaterThan(Date.now());
});

test('event becomes dead after max_attempts', async () => {
  // Zero jitter makes each retry due at once, so the test needs no waiting.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const id = await queue({ poison: true });
  for (let i = 0; i < 3; i++) await work(workflows(2));
  expect(await getEvent(id)).toMatchObject({ status: 'dead', attempts: 2 });
});

test('event is not succeeded until all steps finish', async () => {
  const id = await queue();
  // A route the mock does not serve, so notify fails with 404 after charge succeeds.
  await work(workflows(3, '/missing/route'));
  const event = await getEvent(id);
  expect(event?.status).toBe('queued');
  expect(event?.steps.map((s) => s.step_id)).toEqual(['charge']);
});

test('replay of dead event runs again and succeeds', async () => {
  const id = await queue();
  await work(new Map());
  const dead = (await app.inject({ method: 'GET', url: '/dead' })).json<{ id: string }[]>();
  expect(dead.map((e) => e.id)).toEqual([id]);
  const replayed = await app.inject({ method: 'POST', url: `/dead/${id}/replay` });
  expect(replayed.statusCode).toBe(202);
  await work(workflows());
  expect(await getEvent(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
});
