import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const config = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3000),
    LEASE_MS: z.coerce.number().int().positive().default(30_000),
    POLL_MS: z.coerce.number().int().positive().default(500),
    MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0),
    MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),
    MOCK_DEDUPE: z.stringbool().default(true),
    WORKFLOWS_DIR: z.string().default(fileURLToPath(new URL('../workflows', import.meta.url))),
    CRASH_AFTER_STEP: z.string().optional(),
  })
  .parse(process.env);
