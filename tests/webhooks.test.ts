import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../src/api.ts';
import { applySchema, pool } from '../src/db.ts';

const app = buildApp();

beforeAll(applySchema);
afterAll(async () => {
  await app.close();
  await pool.end();
});

type Accepted = { id: string; duplicate: boolean };

async function post(body: string, eventId?: string): Promise<{ status: number; json: Accepted }> {
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/shop',
    headers: { 'content-type': 'application/json', ...(eventId && { 'x-event-id': eventId }) },
    payload: body,
  });
  return { status: res.statusCode, json: res.json<Accepted>() };
}

function orderBody(): string {
  return JSON.stringify({ type: 'order.created', order: randomUUID() });
}

async function countByIdemKey(idemKey: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM events WHERE idem_key = $1',
    [idemKey],
  );
  return rows[0].count;
}

test('first webhook returns 202 with duplicate false', async () => {
  const res = await post(orderBody(), randomUUID());
  expect(res.status).toBe(202);
  expect(res.json).toEqual({ id: expect.any(String), duplicate: false });
});

test('duplicate webhook with same X-Event-Id returns same id with duplicate true', async () => {
  const eventId = randomUUID();
  const first = await post(orderBody(), eventId);
  const second = await post(orderBody(), eventId);
  expect(second.status).toBe(202);
  expect(second.json).toEqual({ id: first.json.id, duplicate: true });
});

test('duplicate webhooks create one event', async () => {
  const eventId = randomUUID();
  await post(orderBody(), eventId);
  await post(orderBody(), eventId);
  expect(await countByIdemKey(eventId)).toBe(1);
});

test('same body without X-Event-Id is deduped by body hash', async () => {
  const body = orderBody();
  const first = await post(body);
  const second = await post(body);
  expect(second.json).toEqual({ id: first.json.id, duplicate: true });
});

test('different bodies without X-Event-Id create different events', async () => {
  const first = await post(orderBody());
  const second = await post(orderBody());
  expect(second.json.duplicate).toBe(false);
  expect(second.json.id).not.toBe(first.json.id);
});

test('20 concurrent duplicates via Promise.all create exactly one row', async () => {
  const eventId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 20 }, () => post(orderBody(), eventId)));
  expect(new Set(responses.map((r) => r.json.id)).size).toBe(1);
  expect(responses.filter((r) => !r.json.duplicate)).toHaveLength(1);
  expect(await countByIdemKey(eventId)).toBe(1);
});

test('GET /events/:id returns the event', async () => {
  const { id } = (await post(orderBody(), randomUUID())).json;
  const res = await app.inject({ method: 'GET', url: `/events/${id}` });
  expect(res.statusCode).toBe(200);
  expect(res.json<{ id: string }>()).toMatchObject({
    id,
    source: 'shop',
    type: 'order.created',
    steps: [],
  });
});

test('GET /events/:id returns 404 for unknown id', async () => {
  const res = await app.inject({ method: 'GET', url: `/events/${randomUUID()}` });
  expect(res.statusCode).toBe(404);
});

test('invalid body returns 400', async () => {
  const res = await post(JSON.stringify({ order: 1 }), randomUUID());
  expect(res.status).toBe(400);
});
