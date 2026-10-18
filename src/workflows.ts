import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { actions } from './actions.ts';
import { getEvent, recordStep } from './db.ts';

const stepSchema = z.discriminatedUnion('action', [
  z.object({ id: z.string().min(1), action: z.literal('http.post'), url: z.url() }),
  z.object({ id: z.string().min(1), action: z.literal('log') }),
]);

const workflowSchema = z
  .object({
    on: z.string().min(1),
    max_attempts: z.number().int().positive(),
    steps: z.array(stepSchema).min(1),
  })
  // Step ids form the idempotency key, so a repeated id would merge two effects into one.
  .refine((w) => new Set(w.steps.map((s) => s.id)).size === w.steps.length, {
    message: 'step ids must be unique',
  });

export type Step = z.infer<typeof stepSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

export async function loadWorkflows(dir: string): Promise<Map<string, Workflow>> {
  const workflows = new Map<string, Workflow>();
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.yaml'))) {
    const parsed = workflowSchema.safeParse(parse(await readFile(join(dir, file), 'utf8')));
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.message}`, { cause: parsed.error });
    workflows.set(parsed.data.on, parsed.data);
  }
  return workflows;
}

function runStep<A extends Step['action']>(
  event: { id: string; payload: unknown },
  step: Extract<Step, { action: A }> & { action: A },
): Promise<void> {
  return actions[step.action](event, step);
}

export async function runWorkflow(
  event: { id: string; payload: unknown },
  workflow: Workflow,
): Promise<void> {
  const done = new Set((await getEvent(event.id))?.steps.map((s) => s.step_id));
  for (const step of workflow.steps) {
    if (done.has(step.id)) continue;
    await runStep(event, step);
    await recordStep(event.id, step.id);
  }
}
