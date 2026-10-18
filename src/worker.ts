import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.ts';
import { applySchema, claim, complete } from './db.ts';

await applySchema();

for (;;) {
  const event = await claim(config.LEASE_MS);
  if (event) await complete(event.id);
  else await sleep(config.POLL_MS);
}
