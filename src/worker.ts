import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { delay } from './backoff.ts';
import { config } from './config.ts';
import { applySchema, claim, complete, fail } from './db.ts';
import { loadWorkflows, runWorkflow, type Workflow } from './workflows.ts';

// Returns whether an event was claimed, so the loop knows when to idle.
export async function work(workflows: Map<string, Workflow>): Promise<boolean> {
  const event = await claim(config.LEASE_MS);
  if (!event) return false;
  const workflow = workflows.get(event.type);
  if (!workflow) {
    // Retrying cannot help an event no workflow handles, so it goes straight to dead.
    await fail(event, `no workflow for type ${event.type}`, 0, 0);
    return true;
  }
  try {
    await runWorkflow(event, workflow);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    await fail(event, err.message, delay(event.attempts), workflow.max_attempts);
    return true;
  }
  await complete(event);
  return true;
}

// Tests import work without starting the loop.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await applySchema();
  const workflows = await loadWorkflows(config.WORKFLOWS_DIR);
  for (;;) if (!(await work(workflows))) await sleep(config.POLL_MS);
}
