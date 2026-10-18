import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildMock } from '../mock/server.ts';
import { applySchema, getEvent, insertEvent, pool } from '../src/db.ts';

const mock = buildMock();
let mockUrl: string;
const workers: ChildProcess[] = [];

beforeAll(async () => {
  await applySchema();
  mockUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
});
// Workers claim any claimable row, so each test needs a table it controls.
beforeEach(async () => {
  await pool.query('TRUNCATE events CASCADE');
  await mock.inject({ method: 'POST', url: '/reset' });
});
afterEach(() => {
  for (const w of workers.splice(0)) w.kill('SIGKILL');
});
afterAll(async () => {
  await mock.close();
  await pool.end();
});

async function workflowDir(chargeUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-'));
  await writeFile(
    join(dir, 'order.yaml'),
    `on: order.created
max_attempts: 5
steps:
  - id: charge
    action: http.post
    url: ${chargeUrl}
  - id: notify
    action: http.post
    url: ${mockUrl}/notify
`,
  );
  return dir;
}

// A real process, so a crash or kill is a real exit rather than a thrown error.
function startWorker(dir: string, crashAfterStep?: string): ChildProcess {
  const worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    env: {
      ...process.env,
      WORKFLOWS_DIR: dir,
      LEASE_MS: '1000',
      POLL_MS: '50',
      ...(crashAfterStep && { CRASH_AFTER_STEP: crashAfterStep }),
    },
    stdio: 'inherit',
  });
  workers.push(worker);
  return worker;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  while (!(await check())) await sleep(50);
}

async function queue(): Promise<string> {
  return (await insertEvent('test', randomUUID(), 'order.created', {})).id;
}

type MockStats = { calls: { name: string }[]; applied: Record<string, number> };

async function mockStats(): Promise<MockStats> {
  return (await mock.inject({ method: 'GET', url: '/stats' })).json<MockStats>();
}

async function succeeded(id: string): Promise<boolean> {
  return (await getEvent(id))?.status === 'succeeded';
}

test(
  'crash after call but before record does not duplicate the effect',
  { timeout: 20_000 },
  async () => {
    const id = await queue();
    const dir = await workflowDir(`${mockUrl}/charge`);
    const [code] = await once(startWorker(dir, 'charge'), 'exit');
    expect(code).toBe(1);
    startWorker(dir);
    await until(() => succeeded(id));
    const stats = await mockStats();
    expect(stats.calls.filter((c) => c.name === 'charge')).toHaveLength(2);
    expect(stats.applied[`${id}:charge`]).toBe(1);
  },
);

test('crash mid-workflow resumes at the next step', { timeout: 20_000 }, async () => {
  const id = await queue();
  const dir = await workflowDir(`${mockUrl}/charge`);
  await once(startWorker(dir, 'notify'), 'exit');
  expect((await getEvent(id))?.steps.map((s) => s.step_id)).toEqual(['charge']);
  startWorker(dir);
  await until(() => succeeded(id));
  const stats = await mockStats();
  expect(stats.calls.map((c) => c.name)).toEqual(['charge', 'notify', 'notify']);
  expect(stats.applied).toEqual({ [`${id}:charge`]: 1, [`${id}:notify`]: 1 });
});

test('event not lost when a worker is killed while running', { timeout: 20_000 }, async () => {
  // forceCloseConnections lets close() drop the request the killed worker left open.
  const slow = Fastify({ forceCloseConnections: true });
  slow.post('/', async () => {
    await sleep(2000);
    return { ok: true };
  });
  const slowUrl = await slow.listen({ host: '127.0.0.1', port: 0 });
  const id = await queue();
  const dir = await workflowDir(slowUrl);
  const first = startWorker(dir);
  await until(async () => (await getEvent(id))?.status === 'running');
  first.kill('SIGKILL');
  await once(first, 'exit');
  startWorker(dir);
  await until(() => succeeded(id));
  expect(await getEvent(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  await slow.close();
});
