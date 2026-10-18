import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../src/api.ts';
import { applySchema, claim, complete, getEvent, insertEvent, pool, stats } from '../src/db.ts';

const LEASE_MS = 30_000;

beforeAll(applySchema);
// Claim picks any claimable row, so each test needs a table it controls.
beforeEach(() => pool.query('TRUNCATE events CASCADE'));
afterAll(() => pool.end());

async function queue(): Promise<string> {
  const { id } = await insertEvent('test', randomUUID(), 'order.created', {});
  return id;
}

test('claim returns a queued due event and marks it running', async () => {
  const id = await queue();
  const event = await claim(LEASE_MS);
  expect(event).toMatchObject({ id, status: 'running' });
  expect(event?.locked_until?.getTime()).toBeGreaterThan(Date.now());
});

test('claim skips events whose next_run_at is in the future', async () => {
  const id = await queue();
  await pool.query("UPDATE events SET next_run_at = now() + interval '1 hour' WHERE id = $1", [id]);
  expect(await claim(LEASE_MS)).toBeUndefined();
});

test('no double claim under concurrent claims', async () => {
  for (let i = 0; i < 10; i++) await queue();
  const claimed = await Promise.all(Array.from({ length: 20 }, () => claim(LEASE_MS)));
  const ids = claimed.flatMap((e) => (e ? [e.id] : []));
  expect(ids).toHaveLength(10);
  expect(new Set(ids).size).toBe(10);
});

test('expired lease is reclaimed', async () => {
  const id = await queue();
  await claim(LEASE_MS);
  await pool.query("UPDATE events SET locked_until = now() - interval '1 second' WHERE id = $1", [
    id,
  ]);
  expect(await claim(LEASE_MS)).toMatchObject({ id, status: 'running' });
});

test('unexpired lease is not reclaimed', async () => {
  await queue();
  await claim(LEASE_MS);
  expect(await claim(LEASE_MS)).toBeUndefined();
});

test('claim increments attempts', async () => {
  const id = await queue();
  await claim(LEASE_MS);
  await pool.query("UPDATE events SET locked_until = now() - interval '1 second' WHERE id = $1", [
    id,
  ]);
  expect(await claim(LEASE_MS)).toMatchObject({ attempts: 2 });
});

test('claim returns nothing when no event is claimable', async () => {
  expect(await claim(LEASE_MS)).toBeUndefined();
});

test('stale worker cannot complete after its lease is reclaimed', async () => {
  const id = await queue();
  const stale = await claim(LEASE_MS);
  if (!stale) throw new Error('expected a claimable event');
  await pool.query("UPDATE events SET locked_until = now() - interval '1 second' WHERE id = $1", [
    id,
  ]);
  await claim(LEASE_MS);
  await complete(stale);
  expect(await getEvent(id)).toMatchObject({ status: 'running', attempts: 2 });
});

test('stats counts events by status and lists running ones', async () => {
  await queue();
  const id = await queue();
  await pool.query("UPDATE events SET next_run_at = now() + interval '1 hour' WHERE id <> $1", [id]);
  await claim(LEASE_MS);
  expect(await stats()).toEqual({
    counts: { queued: 1, running: 1 },
    attempts: { '0': 1, '1': 1 },
    oldestQueuedMs: expect.any(Number),
    running: [{ id, attempts: 1 }],
  });
});

test('stats returns counts by status', async () => {
  const app = buildApp();
  await queue();
  await queue();
  await claim(LEASE_MS);
  const res = await app.inject({ method: 'GET', url: '/stats' });
  await app.close();
  expect(res.statusCode).toBe(200);
  expect(res.json<{ counts: Record<string, number> }>().counts).toEqual({ queued: 1, running: 1 });
});

test('status page is served at /', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/' });
  await app.close();
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).toContain('/stats');
});
