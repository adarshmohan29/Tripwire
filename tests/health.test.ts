import { expect, test } from 'vitest';
import { buildApp } from '../src/api.ts';

test('health returns ok', async () => {
  const res = await buildApp().inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
