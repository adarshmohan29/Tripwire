# Tripwire

**Event-driven Automation with Proven Reliability**

These are the working rules for this project. Read them at the start of every session and follow them exactly. If a rule conflicts with a request, stop and ask.

---

## Project

Tripwire is an event-triggered automation engine. It receives webhooks and runs multi-step YAML workflows in response.

It makes two guarantees:

1. **No lost events.** Every unique event ends in `succeeded` or `dead`.
2. **No duplicate side effects.** Each (event, step) effect happens once downstream, even with duplicate deliveries, worker crashes and retries.

A chaos harness attacks the running system and verifies both guarantees. **The harness is the main differentiator of the project.** Treat it as a first-class part of the codebase, not an afterthought.

---

## ⚠️ Code Rules (most important)

1. **Smallest code that works.** No speculative features, no unused parameters or helpers.
2. **No dead code.** No commented-out code, no unused imports, no TODO placeholders.
3. **No abstraction until needed twice.** Use plain functions, not classes.
4. **Never use the type `any`.** No type assertions (`as`) unless unavoidable, and then explain why in a comment. No `@ts-ignore`.
5. **No empty catch blocks** and no catching errors only to hide them. Catch specific errors.
6. **Comments explain why, never what.**
7. **Configuration comes from a few environment variables, read in one place only.**
8. **SQL lives only in `src/db.ts`.**
9. **Size targets:** `src/` under about 400 lines in total, `chaos/` under about 300. If a file grows beyond its share, tell me why before continuing.

---

## Correctness Rules (never weaken)

- The idempotency key is enforced by a `UNIQUE` constraint with `ON CONFLICT DO NOTHING`. Never "check then insert".
- A job is claimed by one atomic `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
- A running job holds a lease (`locked_until`). An expired lease makes it claimable again.
- `complete` and `fail` are fenced by the claim's `attempts` (`WHERE ... AND attempts = $n`), so a worker whose lease was reclaimed cannot change the event.
- Each step's effect is recorded in `step_effects(event_id, step_id)` and sent downstream with header `Idempotency-Key: {eventId}:{stepId}`.
- Retries use exponential backoff with jitter. After `max_attempts` the event becomes `dead`.
- Never mark an event `succeeded` until all steps have finished.

---

## Stack (fixed — ask before adding any dependency)

- TypeScript in strict mode, Node 22, ESM
- Fastify for the API
- `pg` (node-postgres) with raw SQL
- `zod` for validation
- `yaml` package for workflow files
- `vitest` for tests
- `tsx` to run TypeScript in development
- Node's built-in `fetch` with `AbortSignal.timeout` for HTTP calls
- Docker Compose runs everything: `db`, `api`, `worker`, `mock`, `tests`, plus `testdb`, a separate in-memory Postgres used only by `tests` (profile `test`)
- Docker runtime on the dev machine is **Docker Desktop**. It is installed in user mode, so its CLI lives in `/Applications/Docker.app/Contents/Resources/bin` (on `PATH` via `~/.zprofile`). Docker Desktop must be running before any `docker` command.

**Postgres is the ONLY datastore and also the queue**, using `SELECT ... FOR UPDATE SKIP LOCKED`.

Not allowed: Redis, BullMQ, any ORM, NestJS, Express.

---

## Layout

| Path | Purpose |
|---|---|
| `src/api.ts` | Fastify routes: `POST /webhooks/:source`, `GET /events/:id`, `GET /dead`, `POST /dead/:id/replay`, `GET /stats`, `GET /health`, `GET /` (status page) |
| `src/config.ts` | The only place environment variables are read, validated with zod |
| `src/db.ts` | Pool, schema loader, and ALL SQL: insert, claim, complete, fail, record step, dead list, replay, stats |
| `src/worker.ts` | Loop: claim → run workflow → mark result |
| `src/workflows.ts` | Load YAML, validate with zod, run steps in order, skip steps already done |
| `src/actions.ts` | `http.post` and `log`, in a plain object registry |
| `src/backoff.ts` | `delay(attempt)` with exponential backoff and jitter |
| `mock/server.ts` | Fake downstream API |
| `chaos/run.ts`, `chaos/check.ts` | Chaos harness: attack the system, then verify both guarantees. `chaos/last-run.json` is the generated run record (gitignored) |
| `workflows/*.yaml` | Workflow definitions |
| `schema.sql` | Database schema |
| `status.html` | Live status page served at `GET /`, polls `/stats`, no framework |
| `tests/` | Unit and integration tests |
| `README.md` | Project documentation: architecture, API, config, failure table, chaos results, demo |
| `TEST_REPORT.md` | Latest real test and chaos output. Regenerate from real runs only |
| `PLAN.md` | Build plan, phase status, decisions made during the build |
| `docker-compose.yml`, `Dockerfile`, `.dockerignore` | Runtime |
| `package.json`, `tsconfig.json`, `.gitignore` | Project config |

Do not create files outside this layout without asking.

---

## Testing Rules

- Write tests together with the code in each phase, not after.
- Integration tests use the real Postgres from Docker Compose. **Never mock the database.**
- One behavior per test, named for the behavior.
- **Never delete or weaken a failing test to make it pass.** Fix the code, or tell me why the test is wrong.
- **Never say tests pass unless you ran them and saw the output.** Run them with `docker compose run --rm tests`.
- Run `npx tsc --noEmit` before declaring a phase done.
- Tests run against `testdb`, never the stack's `db`, so they can run while the stack is up. Keep it that way: never point `tests` at `db`.

---

## How to Work With Me

- Work one phase at a time, as named in `PLAN.md`. Never start the next phase.
- Before coding, show a short plan (files to touch, tests to write) and wait for my OK.
- After coding, report: files changed, real test output, and anything you were unsure about.
- If requirements are unclear, ask instead of guessing.
- Do not refactor earlier phases unless the current phase requires it.
- Commit at the end of each green phase with the message `phase N: <summary>`.

---

## Commands

```sh
npm ci                                # host deps (chaos harness, tsc)
docker compose up -d --build          # build and start everything
docker compose down                   # stop the stack (add --profile test to also stop testdb)
docker compose run --rm tests         # run the test suite
docker compose logs -f worker         # follow worker logs
docker compose up -d --scale worker=3 # run three workers
npx tsc --noEmit                      # type check
npx tsx chaos/run.ts --events 1000 --duplicates 3 --kills 5 --fail-rate 0.2 --poison 10
npx tsx chaos/run.ts ... --no-idempotency   # control run: must exit non-zero
npx tsx chaos/check.ts                # re-check chaos/last-run.json
```

Environment variables (all read in `src/config.ts`): `DATABASE_URL`, `PORT`, `LEASE_MS`, `POLL_MS`, `WORKFLOWS_DIR`, `MOCK_FAIL_RATE`, `MOCK_LATENCY_MS`, `MOCK_DEDUPE`, `CRASH_AFTER_STEP` (test hook).

---

## Definition of Done

A phase is done only when all of these hold:

- [ ] Phase tests pass (real output seen)
- [ ] Earlier tests still pass
- [ ] `npx tsc --noEmit` reports no errors
- [ ] No unused code or imports
- [ ] Size targets respected
- [ ] Committed as `phase N: <summary>`
