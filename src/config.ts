import { z } from 'zod';

export const config = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3000),
    LEASE_MS: z.coerce.number().int().positive().default(30_000),
    POLL_MS: z.coerce.number().int().positive().default(500),
  })
  .parse(process.env);
