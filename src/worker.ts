import { pool } from './db.ts';

await pool.query('SELECT 1');
console.log('worker ready');
// Keeps the process alive until the claim loop exists (Phase 2).
setInterval(() => {}, 60_000);
