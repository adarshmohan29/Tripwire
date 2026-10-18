import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.ts';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

export async function applySchema(): Promise<void> {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
