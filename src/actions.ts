import type { Step } from './workflows.ts';

type Action<A extends Step['action']> = (
  event: { id: string; payload: unknown },
  step: Extract<Step, { action: A }>,
) => Promise<void>;

export const actions: { [A in Step['action']]: Action<A> } = {
  'http.post': async (event, step) => {
    const res = await fetch(step.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `${event.id}:${step.id}`,
      },
      body: JSON.stringify(event.payload),
      signal: AbortSignal.timeout(5000),
    });
    // Release the connection now; an unread body holds it until garbage collection.
    await res.body?.cancel();
    if (!res.ok) throw new Error(`step ${step.id}: ${step.url} returned ${res.status}`);
  },
  log: async (event, step) => {
    console.log(JSON.stringify({ event: event.id, step: step.id, payload: event.payload }));
  },
};
