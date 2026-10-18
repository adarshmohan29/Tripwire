import { z } from 'zod';

export const config = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3000),
  })
  .parse(process.env);
