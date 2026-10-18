import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { API, MOCK, RUN_FILE, type Run, fetchEvents, verify } from './check.ts';

// Slows each downstream call so kills land while events are in flight.
const LATENCY_MS = 20;
const SEND_CONCURRENCY = 20;
// Longer than a lease expiry plus five capped backoffs; past it, unfinished events count as lost.
const DRAIN_TIMEOUT_MS = 180_000;

const { values } = parseArgs({
  options: {
    events: { type: 'string', default: '100' },
    duplicates: { type: 'string', default: '1' },
    kills: { type: 'string', default: '0' },
    'fail-rate': { type: 'string', default: '0' },
    poison: { type: 'string', default: '0' },
    'no-idempotency': { type: 'boolean', default: false },
    seed: { type: 'string', default: String(Date.now() % 2 ** 31) },
  },
});
const flags = z
  .object({
    events: z.coerce.number().int().positive(),
    duplicates: z.coerce.number().int().positive(),
    kills: z.coerce.number().int().nonnegative(),
    'fail-rate': z.coerce.number().min(0).max(1),
    poison: z.coerce.number().int().nonnegative(),
    'no-idempotency': z.boolean(),
    seed: z.coerce.number().int(),
  })
  .parse(values);

// Seeded (mulberry32) so a failing run's delivery order and kill schedule can be replayed.
let state = flags.seed;
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}

const exec = promisify(execFile);
const docker = async (...args: string[]): Promise<string> =>
  (
    await exec('docker', args, {
      env: {
        ...process.env,
        MOCK_FAIL_RATE: String(flags['fail-rate']),
        MOCK_LATENCY_MS: String(LATENCY_MS),
        MOCK_DEDUPE: String(!flags['no-idempotency']),
      },
    })
  ).stdout;

const statsSchema = z.object({
  running: z.array(z.object({ id: z.string(), attempts: z.number() })),
});
async function apiStats(): Promise<z.infer<typeof statsSchema>> {
  return statsSchema.parse(await (await fetch(`${API}/stats`)).json());
}

async function waitHealthy(url: string): Promise<void> {
  for (;;) {
    const ok = await fetch(`${url}/health`).then(
      (r) => r.ok,
      (err: unknown) => {
        // Connection refused while the container boots; anything else is a real failure.
        if (err instanceof TypeError) return false;
        throw err;
      },
    );
    if (ok) return;
    await sleep(250);
  }
}

async function send(events: Run['sent']): Promise<void> {
  const order = events.flatMap((s) => Array.from({ length: s.deliveries }, () => s));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i < order.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      order.slice(i, i + SEND_CONCURRENCY).map(async (sent) => {
        const res = await fetch(`${API}/webhooks/chaos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-event-id': sent.key },
          body: JSON.stringify({ type: 'order.created', key: sent.key, poison: sent.poison }),
        });
        if (res.status !== 202) throw new Error(`webhook ${sent.key} returned ${res.status}`);
        const { id } = z.object({ id: z.string() }).parse(await res.json());
        if (!sent.ids.includes(id)) sent.ids.push(id);
      }),
    );
  }
}

// Recovered once every event running at the kill has been reclaimed or finished.
async function recovery(before: { id: string; attempts: number }[], at: number): Promise<number> {
  for (;;) {
    const { running } = await apiStats();
    if (!before.some((b) => running.some((r) => r.id === b.id && r.attempts === b.attempts))) {
      return Date.now() - at;
    }
    await sleep(100);
  }
}

async function kill(): Promise<Run['kills']> {
  const kills: Promise<Run['kills'][number]>[] = [];
  for (let m = 0; m < flags.kills; m++) {
    await sleep(500 + random() * 2000);
    const workers = (await docker('compose', 'ps', '-q', 'worker')).trim().split('\n');
    const container = workers[Math.floor(random() * workers.length)];
    const { running } = await apiStats();
    const at = Date.now();
    await docker('kill', container);
    await docker('start', container);
    kills.push(recovery(running, at).then((recoveryMs) => ({ at, container, recoveryMs })));
  }
  return Promise.all(kills);
}

await docker('compose', 'up', '-d', '--build', '--scale', 'worker=3');
await Promise.all([waitHealthy(API), waitHealthy(MOCK)]);
await fetch(`${MOCK}/reset`, { method: 'POST' });

const runId = Date.now().toString(36);
const sent: Run['sent'] = [
  ...Array.from({ length: flags.events }, (_, i) => ({ key: `chaos-${runId}-${i}`, poison: false })),
  ...Array.from({ length: flags.poison }, (_, i) => ({ key: `chaos-${runId}-p${i}`, poison: true })),
].map((s) => ({ ...s, deliveries: 1 + Math.floor(random() * flags.duplicates), ids: [] }));

const [, kills] = await Promise.all([send(sent), kill()]);
// Waits on this run's events only: other rows, such as ones tests park in the future, are not ours.
const ids = sent.flatMap((s) => s.ids);
for (const deadline = Date.now() + DRAIN_TIMEOUT_MS; Date.now() < deadline; await sleep(1000)) {
  const events = [...(await fetchEvents(ids)).values()];
  if (events.length === ids.length && events.every((e) => ['succeeded', 'dead'].includes(e.status))) {
    break;
  }
}

const run: Run = { flags, sent, kills };
await writeFile(RUN_FILE, JSON.stringify(run, null, 2));
process.exitCode = (await verify()) ? 0 : 1;
