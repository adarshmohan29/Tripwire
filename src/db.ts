import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.ts';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

export type EventRow = {
  id: string;
  source: string;
  idem_key: string;
  type: string;
  payload: unknown;
  status: 'queued' | 'running' | 'succeeded' | 'dead';
  attempts: number;
  next_run_at: Date;
  locked_until: Date | null;
  last_error: string | null;
  created_at: Date;
};

export async function applySchema(): Promise<void> {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function insertEvent(
  source: string,
  idemKey: string,
  type: string,
  payload: unknown,
): Promise<{ id: string; duplicate: boolean }> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO events (source, idem_key, type, payload) VALUES ($1, $2, $3, $4)
     ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    [source, idemKey, type, payload],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, duplicate: false };
  const existing = await pool.query<{ id: string }>('SELECT id FROM events WHERE idem_key = $1', [
    idemKey,
  ]);
  return { id: existing.rows[0].id, duplicate: true };
}

export async function getEvent(
  id: string,
): Promise<(EventRow & { steps: { step_id: string; done_at: Date }[] }) | undefined> {
  const event = await pool.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
  if (!event.rows[0]) return undefined;
  const steps = await pool.query<{ step_id: string; done_at: Date }>(
    'SELECT step_id, done_at FROM step_effects WHERE event_id = $1 ORDER BY done_at',
    [id],
  );
  return { ...event.rows[0], steps: steps.rows };
}
