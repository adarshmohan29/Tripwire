# Tripwire — Test Report

Every number below comes from a real run. Nothing is estimated or copied from a plan.

- **Date:** 2026-10-18 04:57 UTC
- **Commit under test:** Phase 6 working tree (Phases 0–5 committed, `7186c3d` and earlier)
- **Environment:** macOS 27.0 (arm64), Docker Desktop (engine 29.8.2, Compose v5.6.0), Node v22.23.3, Postgres 16

## Summary

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | **exit 0**, no errors |
| Unit + integration tests | `docker compose run --rm tests` | **41 / 41 passed** across 9 files (15.0s) |
| Chaos run | `npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10` | **PASS**, exit 0: lost 0, duplicate effects 0 |
| Chaos control run | same plus `--no-idempotency` | **FAIL as required**, exit 1: 394 duplicate effects caught |

The two guarantees hold under attack, and the control run shows the harness can detect a broken system.

---

## 1. Unit and integration tests

The tests run inside Docker against the real Postgres. The database is never mocked. Verbose output:

```
✓ tests/crash.test.ts > crash after call but before record does not duplicate the effect 1522ms
✓ tests/crash.test.ts > crash mid-workflow resumes at the next step 1389ms
✓ tests/crash.test.ts > event not lost when a worker is killed while running 3464ms
✓ tests/claim.test.ts > claim returns a queued due event and marks it running 16ms
✓ tests/claim.test.ts > claim skips events whose next_run_at is in the future 11ms
✓ tests/claim.test.ts > no double claim under concurrent claims 31ms
✓ tests/claim.test.ts > expired lease is reclaimed 9ms
✓ tests/claim.test.ts > unexpired lease is not reclaimed 7ms
✓ tests/claim.test.ts > claim increments attempts 9ms
✓ tests/claim.test.ts > claim returns nothing when no event is claimable 6ms
✓ tests/claim.test.ts > stale worker cannot complete after its lease is reclaimed 9ms
✓ tests/claim.test.ts > stats counts events by status and lists running ones 13ms
✓ tests/claim.test.ts > stats returns counts by status 71ms
✓ tests/claim.test.ts > status page is served at / 9ms
✓ tests/worker.test.ts > steps run in order 85ms
✓ tests/worker.test.ts > step already in step_effects is skipped 19ms
✓ tests/worker.test.ts > failed event is requeued with future next_run_at 14ms
✓ tests/worker.test.ts > event becomes dead after max_attempts 25ms
✓ tests/worker.test.ts > event is not succeeded until all steps finish 17ms
✓ tests/worker.test.ts > replay of dead event runs again and succeeds 26ms
✓ tests/webhooks.test.ts > first webhook returns 202 with duplicate false 20ms
✓ tests/webhooks.test.ts > duplicate webhook with same X-Event-Id returns same id with duplicate true 4ms
✓ tests/webhooks.test.ts > duplicate webhooks create one event 5ms
✓ tests/webhooks.test.ts > same body without X-Event-Id is deduped by body hash 3ms
✓ tests/webhooks.test.ts > different bodies without X-Event-Id create different events 5ms
✓ tests/webhooks.test.ts > 20 concurrent duplicates via Promise.all create exactly one row 39ms
✓ tests/webhooks.test.ts > GET /events/:id returns the event 5ms
✓ tests/webhooks.test.ts > GET /events/:id returns 404 for unknown id 2ms
✓ tests/webhooks.test.ts > invalid body returns 400 2ms
✓ tests/workflows.test.ts > valid workflow file loads 17ms
✓ tests/workflows.test.ts > invalid workflow file is rejected with a zod error 6ms
✓ tests/workflows.test.ts > http.post sends Idempotency-Key eventId:stepId 85ms
✓ tests/workflows.test.ts > http.post fails after 5s timeout 5021ms
✓ tests/workflows.test.ts > backoff delay grows with attempt and stays within jitter bounds 4ms
✓ tests/chaos.test.ts > checker passes a clean run 2ms
✓ tests/chaos.test.ts > checker detects a lost event 1ms
✓ tests/chaos.test.ts > checker detects a duplicate effect 0ms
✓ tests/chaos.test.ts > checker detects a poison event that is not dead 0ms
✓ tests/mock.test.ts > mock applies an effect once for repeated Idempotency-Key 66ms
✓ tests/schema.test.ts > schema creates events and step_effects tables 25ms
✓ tests/health.test.ts > health returns ok 61ms

 Test Files  9 passed (9)
      Tests  41 passed (41)
   Duration  15.03s
```

### What each file proves

| File | Tests | Proves |
|---|---|---|
| `tests/webhooks.test.ts` | 9 | **Ingress dedup.** The same `X-Event-Id`, or the same raw body when there is no header, yields one event. 20 concurrent duplicates create exactly one row, enforced by the `UNIQUE` constraint with `ON CONFLICT DO NOTHING`. Invalid input returns 400; an unknown id returns 404. |
| `tests/claim.test.ts` | 11 | **The queue.** The atomic `FOR UPDATE SKIP LOCKED` claim never double-claims under 20 concurrent claimers. Expired leases are reclaimed and live ones are not. `attempts` increments on every claim. A stale worker whose lease was reclaimed cannot complete the event (the `attempts` fencing token). `/stats` and the status page are served. |
| `tests/worker.test.ts` | 6 | **Workflow execution.** Steps run in order, and already-recorded steps are skipped. A failure is requeued with backoff, and the event becomes `dead` after `max_attempts`. An event is never `succeeded` before every step finishes. Replaying a dead event runs it to success. |
| `tests/workflows.test.ts` | 5 | **Workflow files and actions.** Valid YAML loads, and invalid YAML is rejected with a zod error. `http.post` sends `Idempotency-Key: {eventId}:{stepId}` and times out after 5s. Backoff stays within the bounds of exponential backoff with full jitter. |
| `tests/crash.test.ts` | 3 | **Crash safety, with real worker processes.** A crash between the downstream call and its record causes no duplicate effect (2 raw calls, 1 applied). A crash mid-workflow resumes at the right step. A `SIGKILL`ed worker's event is reclaimed after the lease and succeeds. |
| `tests/chaos.test.ts` | 4 | **The checker.** It passes a clean run and catches a lost event, a duplicate effect, and a poison event that isn't dead. |
| `tests/mock.test.ts` | 1 | **The downstream mock.** It applies an effect once per `Idempotency-Key`. |
| `tests/schema.test.ts`, `tests/health.test.ts` | 2 | The skeleton: the tables exist and `/health` responds. |

---

## 2. Chaos harness

The chaos run starts the full stack with **3 workers**. It then:
- sends **1000 events plus 10 poison events**, each delivered 1–3 times, shuffled, with 20 requests in flight at once;
- makes **20% of downstream responses get lost** after the effect is applied, including responses to replayed calls;
- **`docker kill`s a random worker 5 times** at random intervals, restarting it each time;
- waits for its own events to finish, with a 3-minute deadline.

The checker then compares three independent sources: what was sent, the database state through the API, and the mock's own count of applied effects.

### Main run: guarantees hold

```
$ npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10
{"events":1000,"duplicates":3,"kills":5,"fail-rate":0.2,"poison":10,"no-idempotency":false,"seed":1298083143}
┌───────────────────────────────────────────────┬────────┐
│ (index)                                       │ Values │
├───────────────────────────────────────────────┼────────┤
│ events                                        │ 1010   │
│ deliveries                                    │ 2016   │
│ kills                                         │ 5      │
│ succeeded                                     │ 1000   │
│ dead                                          │ 10     │
│ lost                                          │ 0      │
│ duplicate effects                             │ 0      │
│ p50 ms (created → last step recorded)         │ 14105  │
│ p99 ms (created → last step recorded)         │ 31067  │
│ max recovery ms (kill → its events reclaimed) │ 28903  │
└───────────────────────────────────────────────┴────────┘
PASS
exit code: 0 (50s)
```

- **No lost events:** all 1010 unique events ended `succeeded` or `dead`.
- **No duplicate side effects:** 2016 deliveries, retries after lost responses and 5 worker kills produced 0 duplicate effects.
- **Poison handled:** the 10 dead events are exactly the 10 poison events.
- **Recovery:** about 29s after a kill, the killed worker's events were reclaimed. That matches the default 30s lease.
- **Latency** is mostly queue wait: about 2000 deliveries feed 3 workers, and every downstream call is slowed by 20ms on purpose. The p99 includes retry backoff.

### Control run: the harness detects the bug it guards against

This run makes the downstream ignore `Idempotency-Key` (`MOCK_DEDUPE=false`):

```
$ npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10 --no-idempotency
{"events":1000,"duplicates":3,"kills":5,"fail-rate":0.2,"poison":10,"no-idempotency":true,"seed":1298133921}
┌───────────────────────────────────────────────┬────────┐
│ (index)                                       │ Values │
├───────────────────────────────────────────────┼────────┤
│ events                                        │ 1010   │
│ deliveries                                    │ 2063   │
│ kills                                         │ 5      │
│ succeeded                                     │ 998    │
│ dead                                          │ 12     │
│ lost                                          │ 0      │
│ duplicate effects                             │ 394    │
│ p50 ms (created → last step recorded)         │ 13689  │
│ p99 ms (created → last step recorded)         │ 33164  │
│ max recovery ms (kill → its events reclaimed) │ 30501  │
└───────────────────────────────────────────────┴────────┘
VIOLATION duplicate effect: chaos-mvdcujat-0:notify applied 2 times
VIOLATION duplicate effect: chaos-mvdcujat-1:notify applied 3 times
VIOLATION duplicate effect: chaos-mvdcujat-4:notify applied 2 times
... and 374 more
FAIL: 394 violations
exit code: 1 (57s)
```

Without downstream deduplication, the same faults produce 394 duplicate effects, and the harness fails the run. This is the evidence that the main run's `duplicate effects: 0` means something. The 12 dead events here are the 10 poison events plus 2 ordinary events that ran out of attempts because retried responses can be lost too. `dead` is an allowed final state, so this is not a lost event.

---

## 3. Earlier manual checks (per phase, during the build)

Each phase's Done-when was also checked by hand on a fresh database:

| Phase | Check | Result |
|---|---|---|
| 1 | Same webhook sent twice | Same id, `duplicate: true` the second time; `count(*) = 1` |
| 2 | 3 workers and 100 events, repeated 3 times | `succeeded | 1 | 100` each time, every worker still running |
| 3 | `MOCK_FAIL_RATE=0.3`, 50 events plus 1 poison | 50 succeeded, every key applied exactly once; poison in `/dead` with `attempts = 5` |
| 4 | `docker kill` of a worker mid-load (50 events, 300ms latency) | 49 events with attempts 1 and 1 with attempts 2 (the reclaimed one), none stuck in `running`, 100 keys each applied once |
| 6 | A fresh copy of the repo, following only `README.md` | `npm ci`, `up`, `/health`, webhook and lookup, and the status page all worked. The demo script took 65s on a warm build (dedup, poison event to `/dead` with 5 attempts, then a chaos run of 205 events with 2 kills: PASS, lost 0, duplicates 0). 41/41 tests, tsc exit 0. |

---

## How to reproduce

```sh
docker compose run --rm tests           # uses the separate testdb; safe while the stack is up
npx tsc --noEmit
npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10
npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10 --no-idempotency
npx tsx chaos/check.ts                  # re-check the last run from chaos/last-run.json
```

Pass `--seed <n>` to repeat a run's delivery order and kill schedule. Timing, and therefore which events are in flight at each kill, will still differ between runs.

## Known caveats

- **Test isolation (fixed after this report's run).** At the time of this run, tests shared the stack's database, so the stack was stopped first. Tests now use a separate `testdb`. A re-check with the stack up and 3 workers running gave 41/41 twice, with the stack's `db` unchanged (3 events and 6 step records before and after).
- **Tripwire's side is at-least-once.** Exactly-once effects depend on the downstream deduplicating by `Idempotency-Key`. The control run shows what happens when it doesn't.
