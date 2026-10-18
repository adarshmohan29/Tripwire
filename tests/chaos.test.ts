import { expect, test } from 'vitest';
import { type EventState, type Run, check } from '../chaos/check.ts';

const workflow = { max_attempts: 5, steps: ['charge', 'notify'] };

function succeeded(): EventState {
  return {
    status: 'succeeded',
    attempts: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    steps: [
      { step_id: 'charge', done_at: '2026-01-01T00:00:00.100Z' },
      { step_id: 'notify', done_at: '2026-01-01T00:00:00.200Z' },
    ],
  };
}

function cleanRun(): { run: Run; events: Map<string, EventState>; applied: Record<string, number> } {
  return {
    run: {
      flags: {},
      sent: [
        { key: 'order', poison: false, deliveries: 2, ids: ['e1'] },
        { key: 'poison', poison: true, deliveries: 1, ids: ['e2'] },
      ],
      kills: [],
    },
    events: new Map([
      ['e1', succeeded()],
      ['e2', { status: 'dead', attempts: 5, created_at: '2026-01-01T00:00:00.000Z', steps: [] }],
    ]),
    applied: { 'e1:charge': 1, 'e1:notify': 1 },
  };
}

test('checker passes a clean run', () => {
  const { run, events, applied } = cleanRun();
  const { report, violations } = check(run, events, applied, workflow);
  expect(violations).toEqual([]);
  expect(report).toMatchObject({ events: 2, deliveries: 3, succeeded: 1, dead: 1, lost: 0 });
});

test('checker detects a lost event', () => {
  const { run, events, applied } = cleanRun();
  events.delete('e1');
  const { report, violations } = check(run, events, applied, workflow);
  expect(report.lost).toBe(1);
  expect(violations).toContain('lost: order is missing');
});

test('checker detects a duplicate effect', () => {
  const { run, events, applied } = cleanRun();
  applied['e1:charge'] = 2;
  const { report, violations } = check(run, events, applied, workflow);
  expect(report['duplicate effects']).toBe(1);
  expect(violations).toContain('duplicate effect: order:charge applied 2 times');
});

test('checker detects a poison event that is not dead', () => {
  const { run, events, applied } = cleanRun();
  events.set('e2', { ...succeeded(), attempts: 1 });
  const { violations } = check(run, events, applied, workflow);
  expect(violations).toContain('poison poison is succeeded, not dead');
});
