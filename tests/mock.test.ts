import { expect, test } from 'vitest';
import { buildMock } from '../mock/server.ts';

test('mock applies an effect once for repeated Idempotency-Key', async () => {
  const mock = buildMock();
  const send = () =>
    mock.inject({
      method: 'POST',
      url: '/charge',
      headers: { 'idempotency-key': 'evt-1:charge' },
      payload: {},
    });
  const first = await send();
  const second = await send();
  const stats = (await mock.inject({ method: 'GET', url: '/stats' })).json<{
    calls: unknown[];
    applied: Record<string, number>;
  }>();
  expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
  expect(second.body).toBe(first.body);
  expect(stats).toMatchObject({ applied: { 'evt-1:charge': 1 } });
  expect(stats.calls).toHaveLength(2);
});
