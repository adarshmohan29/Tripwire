import { afterAll, expect, test } from 'vitest';
import { applySchema, pool } from '../src/db.ts';

afterAll(() => pool.end());

test('schema creates events and step_effects tables', async () => {
  await applySchema();
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  expect(rows.map((r) => r.table_name)).toEqual(['events', 'step_effects']);
});
