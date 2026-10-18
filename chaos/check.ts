import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const API = 'http://localhost:3000';
export const MOCK = 'http://localhost:4000';
export const RUN_FILE = fileURLToPath(new URL('last-run.json', import.meta.url));

const runSchema = z.object({
  flags: z.record(z.string(), z.union([z.number(), z.boolean()])),
  sent: z.array(
    z.object({ key: z.string(), poison: z.boolean(), deliveries: z.number(), ids: z.array(z.string()) }),
  ),
  kills: z.array(z.object({ at: z.number(), container: z.string(), recoveryMs: z.number() })),
});
const eventSchema = z.object({
  status: z.string(),
  attempts: z.number(),
  created_at: z.string(),
  steps: z.array(z.object({ step_id: z.string(), done_at: z.string() })),
});
const workflowSchema = z.object({
  max_attempts: z.number(),
  steps: z.array(z.object({ id: z.string() })),
});

export type Run = z.infer<typeof runSchema>;
export type EventState = z.infer<typeof eventSchema>;

function percentile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

// Pure, so the rules that decide pass or fail are unit-tested without Docker.
export function check(
  run: Run,
  events: Map<string, EventState>,
  applied: Record<string, number>,
  workflow: { max_attempts: number; steps: string[] },
): { report: Record<string, number>; violations: string[] } {
  const violations: string[] = [];
  const latencies: number[] = [];
  const tally = { lost: 0, duplicates: 0, succeeded: 0, dead: 0 };
  for (const sent of run.sent) {
    if (sent.ids.length !== 1) violations.push(`${sent.key}: ingress created ${sent.ids.length} events`);
    const event = events.get(sent.ids[0]);
    if (event?.status !== 'succeeded' && event?.status !== 'dead') {
      tally.lost++;
      violations.push(`lost: ${sent.key} is ${event?.status ?? 'missing'}`);
      continue;
    }
    tally[event.status]++;
    if (event.attempts > workflow.max_attempts) {
      violations.push(`${sent.key}: ${event.attempts} attempts > max ${workflow.max_attempts}`);
    }
    if (sent.poison && event.status !== 'dead') {
      violations.push(`poison ${sent.key} is ${event.status}, not dead`);
    }
    const recorded = new Set(event.steps.map((s) => s.step_id));
    for (const step of workflow.steps) {
      const count = applied[`${sent.ids[0]}:${step}`] ?? 0;
      if (count > 1) {
        tally.duplicates++;
        violations.push(`duplicate effect: ${sent.key}:${step} applied ${count} times`);
      }
      if (sent.poison && count > 0) violations.push(`poison effect applied: ${sent.key}:${step}`);
      if (event.status === 'succeeded' && (count === 0 || !recorded.has(step))) {
        violations.push(`missing effect: ${sent.key}:${step} on a succeeded event`);
      }
    }
    if (event.status === 'succeeded') {
      const last = Math.max(...event.steps.map((s) => Date.parse(s.done_at)));
      latencies.push(last - Date.parse(event.created_at));
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    report: {
      events: run.sent.length,
      deliveries: run.sent.reduce((n, s) => n + s.deliveries, 0),
      kills: run.kills.length,
      succeeded: tally.succeeded,
      dead: tally.dead,
      lost: tally.lost,
      'duplicate effects': tally.duplicates,
      'p50 ms (created → last step recorded)': percentile(latencies, 0.5),
      'p99 ms (created → last step recorded)': percentile(latencies, 0.99),
      'max recovery ms (kill → its events reclaimed)': Math.max(0, ...run.kills.map((k) => k.recoveryMs)),
    },
    violations,
  };
}

export async function fetchEvents(ids: string[]): Promise<Map<string, EventState>> {
  const events = new Map<string, EventState>();
  for (let i = 0; i < ids.length; i += 50) {
    await Promise.all(
      ids.slice(i, i + 50).map(async (id) => {
        const res = await fetch(`${API}/events/${id}`);
        if (res.ok) events.set(id, eventSchema.parse(await res.json()));
      }),
    );
  }
  return events;
}

// Reads the run file and live state, prints the report, and returns whether the run is clean.
export async function verify(): Promise<boolean> {
  const run = runSchema.parse(JSON.parse(await readFile(RUN_FILE, 'utf8')));
  const workflowFile = new URL('../workflows/order-created.yaml', import.meta.url);
  const workflow = workflowSchema.parse(parse(await readFile(workflowFile, 'utf8')));
  const mock = z
    .object({ applied: z.record(z.string(), z.number()) })
    .parse(await (await fetch(`${MOCK}/stats`)).json());
  const { report, violations } = check(
    run,
    await fetchEvents(run.sent.flatMap((s) => s.ids)),
    mock.applied,
    { max_attempts: workflow.max_attempts, steps: workflow.steps.map((s) => s.id) },
  );
  console.log(JSON.stringify(run.flags));
  console.table(report);
  for (const v of violations.slice(0, 20)) console.log(`VIOLATION ${v}`);
  if (violations.length > 20) console.log(`... and ${violations.length - 20} more`);
  console.log(violations.length ? `FAIL: ${violations.length} violations` : 'PASS');
  return violations.length === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await verify()) ? 0 : 1;
}
