# Tripwire — Build Plan

**Event-driven Automation with Proven Reliability**

Rules in `CLAUDE.md` apply to every phase. Work one phase at a time; a phase ends only when its Done-when check holds and the Definition of Done in `CLAUDE.md` is met.

**Prerequisite**: Docker Desktop installed and running (it provides the Docker engine, CLI and Compose). No other container runtime is used.

---

## 1. Design Decisions

| Decision | Why |
|---|---|
| Postgres is both the event log and the queue (`FOR UPDATE SKIP LOCKED`) | One datastore means the event insert and the job state live in one transaction, so there is no dual-write gap between log and queue. `SKIP LOCKED` lets many workers claim concurrently without blocking or double-claiming. Fewer moving parts to reason about under chaos. |
| Lease via `locked_until` instead of heartbeats | A crashed worker needs no cleanup: its lease simply expires and the claim query picks the job up again. Recovery is one `WHERE` clause, not a separate liveness protocol. The cost is that recovery waits up to one lease length. |
| Step-level idempotency key `Idempotency-Key: {eventId}:{stepId}` sent downstream | `step_effects` alone cannot close the gap between "downstream call succeeded" and "we recorded it": a crash there causes a retry. The key lets the downstream recognise the retry. **Exactly-once effect requires the downstream to dedupe by this key.** Tripwire delivers at-least-once; the mock honours `Idempotency-Key` the way Stripe does, which turns that into exactly-once effect. |
| One worker process per container, scaled by running more containers | Killing a container is then exactly killing a worker, which is what the chaos harness does with `docker kill`. No in-process concurrency to reason about; scaling is `--scale worker=N`. |

---

## 2. Data Model

```sql
CREATE TABLE IF NOT EXISTS events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,
  idem_key     text NOT NULL UNIQUE,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts     int NOT NULL DEFAULT 0,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_status_next_run_at ON events (status, next_run_at);

CREATE TABLE IF NOT EXISTS step_effects (
  event_id uuid NOT NULL REFERENCES events (id),
  step_id  text NOT NULL,
  done_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, step_id)
);
```

`IF NOT EXISTS` makes the schema safe to apply on every start.

---

## 3. Workflow File Format

```yaml
# workflows/order-created.yaml
on: order.created
max_attempts: 5
steps:
  - id: charge
    action: http.post
    url: http://mock:4000/charge
  - id: notify
    action: http.post
    url: http://mock:4000/notify
```

- `on`: the event type this workflow handles. One workflow per event type.
- `max_attempts`: attempts before the event becomes `dead`.
- `steps`: run in order. `id` is unique within the workflow and forms part of the idempotency key.
- The event payload is the request body of each `http.post`.
- Version 1 has no branching and no parallel steps.

---

## 4. Phases

### Phase 0 — Skeleton

**Build**
- `package.json` (ESM, scripts for api, worker, mock, test), `tsconfig.json` (strict)
- `Dockerfile` shared by api, worker, mock, tests
- `docker-compose.yml` with services `db`, `api`, `worker`, `mock`, `tests`; `db` has a healthcheck and the others wait on it
- `schema.sql` applied on api start by the schema loader in `src/db.ts`
- `GET /health` returns `{ ok: true }`

**Tests**
- `health returns ok`
- `schema creates events and step_effects tables`

**Done-when**: `docker compose up -d --build` starts all services, `curl localhost:3000/health` returns `{"ok":true}`, and `docker compose run --rm tests` passes.

---

### Phase 1 — Ingress with Dedup

**Build**
- `POST /webhooks/:source`: event `type` from the body; `idem_key` = `X-Event-Id` header if present, else SHA-256 of the raw body
- Insert with `ON CONFLICT (idem_key) DO NOTHING RETURNING id`; on conflict, look up the existing id
- Respond `202 { id, duplicate }`
- `GET /events/:id` returns the event row and its recorded steps; `404` if unknown
- zod validation of the request body; `400` on invalid input

**Tests**
- `first webhook returns 202 with duplicate false`
- `duplicate webhook with same X-Event-Id returns same id with duplicate true`
- `duplicate webhooks create one event`
- `same body without X-Event-Id is deduped by body hash`
- `different bodies without X-Event-Id create different events`
- `20 concurrent duplicates via Promise.all create exactly one row`
- `GET /events/:id returns the event`
- `GET /events/:id returns 404 for unknown id`
- `invalid body returns 400`

**Done-when**: sending the same webhook twice with `curl` returns the same `id` with `duplicate: true` the second time, and `SELECT count(*) FROM events` is 1.

---

### Phase 2 — Worker, Claim and Lease

**Build**
- Claim query in `src/db.ts`: one atomic `UPDATE events SET status = 'running', attempts = attempts + 1, locked_until = now() + lease WHERE id = (SELECT id FROM events WHERE (status = 'queued' AND next_run_at <= now()) OR (status = 'running' AND locked_until < now()) ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
- `complete(id)` sets `succeeded` and clears the lease, only if the row is still `running`
- `src/worker.ts` loop: claim → (no workflow yet: complete) → sleep for the poll interval when nothing is claimable
- Lease length and poll interval from environment variables

**Tests**
- `claim returns a queued due event and marks it running`
- `claim skips events whose next_run_at is in the future`
- `no double claim under concurrent claims`
- `expired lease is reclaimed`
- `unexpired lease is not reclaimed`
- `claim increments attempts`
- `claim returns nothing when no event is claimable`

**Done-when**: with `--scale worker=3` and 100 queued events, every event is `succeeded` with `attempts = 1`.

---

### Phase 3 — Workflows, Retries, Dead Letter

**Build**
- `src/workflows.ts`: load `workflows/*.yaml`, validate with zod, fail fast on invalid files; run steps in order, skipping any step already in `step_effects`; record each step in `step_effects` after it succeeds
- `src/actions.ts`: registry `{ 'http.post': ..., log: ... }`; `http.post` sends the payload as JSON with `Idempotency-Key: {eventId}:{stepId}` and `AbortSignal.timeout(5000)`; non-2xx is a failure
- `src/backoff.ts`: `delay(attempt)` = exponential base with full jitter, capped
- `fail(id, error, delay)` in `src/db.ts`: if `attempts >= max_attempts` set `dead`, else set `queued` with `next_run_at = now() + delay`; store `last_error`
- Event with no matching workflow becomes `dead` with a clear `last_error`
- `GET /dead` lists dead events; `POST /dead/:id/replay` resets to `queued`, `attempts = 0`, `next_run_at = now()` (completed steps stay recorded, so replay resumes)
- `mock/server.ts`: records every raw call; applies an effect only for a new `Idempotency-Key` (seen keys return the stored response); `MOCK_FAIL_RATE` makes that fraction of requests return 500 after applying the effect (a lost response, the case idempotency keys exist for); `MOCK_LATENCY_MS` adds delay; a body with `"poison": true` always returns 500 without applying; `MOCK_DEDUPE=false` disables dedup (used by the chaos control run); `GET /stats` returns raw calls and applied counts per key; `POST /reset` clears them

**Tests**
- `valid workflow file loads`
- `invalid workflow file is rejected with a zod error`
- `steps run in order`
- `step already in step_effects is skipped`
- `http.post sends Idempotency-Key eventId:stepId`
- `http.post fails after 5s timeout`
- `backoff delay grows with attempt and stays within jitter bounds`
- `failed event is requeued with future next_run_at`
- `event becomes dead after max_attempts`
- `event is not succeeded until all steps finish`
- `replay of dead event runs again and succeeds`
- `mock applies an effect once for repeated Idempotency-Key`

**Done-when**: with `MOCK_FAIL_RATE=0.3`, 50 events all end `succeeded` and mock `/stats` shows applied = 1 for every key; a poison event ends in `GET /dead` with `attempts = max_attempts`.

---

### Phase 4 — Crash Safety

**Build**
- `CRASH_AFTER_STEP` env test hook in the step runner: when the step id matches, `process.exit(1)` after the downstream call returns and before the step is recorded. At most 2 lines.
- Tests start the worker as a child process to observe real exits

**Tests**
- `crash after call but before record does not duplicate the effect` (mock applied == 1, raw_calls == 2)
- `crash mid-workflow resumes at the next step`
- `event not lost when a worker is killed while running`

**Done-when**: the three tests pass against real worker processes, and a manual `docker kill` of a worker mid-load leaves no event stuck in `running` once the lease expires.

---

### Phase 5 — Chaos Harness

**Build**
- `chaos/run.ts` flags: `--events N`, `--duplicates K`, `--kills M`, `--fail-rate F`, `--poison P`, `--no-idempotency`
  - Resets mock stats, then sends N unique events, each delivered 1..K times; some deliveries concurrent, all shuffled
  - Injects P poison events
  - Kills random worker containers with `docker kill` M times during the load and restarts them
  - Waits until no event is `queued` or `running`
  - Writes what it sent and when it killed for the checker
- `chaos/check.ts` compares three sources: what was sent, DB state, mock `/stats`
  - No lost events: every sent unique event exists and is `succeeded` or `dead`
  - applied == 1 per (event, step) for succeeded events; applied == 0 for poison
  - Poison events are `dead`
  - `attempts` never exceeds `max_attempts`
  - Report: events, deliveries, kills, succeeded, dead, lost, duplicate effects, p50/p99 latency (created → succeeded), max recovery time (kill → next claim of an event the killed worker held)
  - Exits non-zero on any violation
- `--no-idempotency` control run sets `MOCK_DEDUPE=false`; with failures and kills it must report duplicate effects > 0, proving the harness can see the bug it guards against
- Checker logic is a pure function over the three sources, so it is testable without Docker

**Tests**
- `checker passes a clean run`
- `checker detects a lost event`
- `checker detects a duplicate effect`
- `checker detects a poison event that is not dead`

**Done-when**: `npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10` exits 0 with lost = 0 and duplicate effects = 0, and the same run with `--no-idempotency` exits non-zero with duplicate effects > 0.

---

### Phase 6 — Polish

**Build**
- `GET /stats` on the API: counts by status, attempts histogram, oldest queued age
- Tiny static HTML status page, no framework, polling `/stats`
- `README.md`:
  - Title "Tripwire", tagline "Event-driven Automation with Proven Reliability"
  - Architecture diagram (webhook → api → events table → workers → downstream)
  - Failure-scenarios table: fault, behaviour, covering test
  - Latest chaos report output
  - Deployment notes
  - 2-minute demo script

**Tests**
- `stats returns counts by status`

**Done-when**: a fresh clone runs end to end by following only the README, and the demo script completes in about 2 minutes.

---

## 5. Optional Extras (only after Phase 6)

- Dry-run replay of past events: run a workflow against a stored event without calling downstream
- LLM step: output validated against a zod schema, with a per-event cost cap
- Per-source rate limiting on ingress

---

## 6. Checkpoints

| After phase | You can demonstrate |
|---|---|
| 0 | `docker compose up` starts all five services; `/health` returns ok; tables exist |
| 1 | Duplicate and concurrent duplicate webhooks produce one event |
| 2 | Three workers drain a queue with no double claims; an expired lease is picked up again |
| 3 | Workflows run from YAML; flaky downstream is retried with backoff; poison events land in the dead letter list and can be replayed |
| 4 | A worker killed between downstream call and record causes no duplicate effect and loses no event |
| 5 | 1000 events under duplicates, failures, poison and worker kills: zero lost, zero duplicate effects; the control run shows the harness catches duplicates |
| 6 | README with diagram, failure table and chaos report; live status page; 2-minute demo |
