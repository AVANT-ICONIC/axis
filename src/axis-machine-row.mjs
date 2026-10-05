// PURE REDUCER FOR THE `row` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `row` is a piece of intended work (LEDGER.md, "Units"), identified by
// the existing `work.txt` row id. This file is the transition table from
// docs/axis/LEDGER.md's "### row" section. The attempt policy (SAME, OTHER,
// ESCALATE, WAIT, DROP) stays in `retry-ladder.sh`'s `ladder_route`
// (LEDGER.md: "It moves into the reducer unchanged") -- this reducer only
// records that a ladder decision intent is emitted, never re-implements it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceTable } from './axis-machine-shared.mjs';

export const STATES = Object.freeze([
  'proposed', 'needs-scope', 'queued', 'active', 'parked', 'done', 'retired',
]);

// States with no outgoing row below.
export const TERMINAL_STATES = Object.freeze(['needs-scope', 'done', 'retired']);

const TABLE = [
  // (none) | proposed{title, source} | proposed | decide(brief.quality)
  {
    from: null, type: 'proposed',
    to: () => 'proposed',
    data: (e) => ({ title: e.title, source: e.source }),
    intents: () => [{ intent: 'decide', kind: 'brief.quality' }],
  },
  // proposed | owners, brief and precondition present | queued | none
  {
    from: 'proposed', type: 'scoped',
    guard: (e) => Boolean(e.owners) && Boolean(e.brief) && Boolean(e.precondition),
    to: () => 'queued',
    intents: () => [],
  },
  // proposed | owners missing | needs-scope | none (visible, never claimable)
  {
    from: 'proposed', type: 'scoped',
    guard: (e) => !e.owners,
    to: () => 'needs-scope',
    intents: () => [],
  },
  // queued | precondition{holds: false} | retired(already-fixed) | none
  {
    from: 'queued', type: 'precondition',
    guard: (e) => e.holds === false,
    to: () => 'retired',
    data: () => ({ cause: 'already-fixed' }),
    intents: () => [],
  },
  // queued | scheduler grant | active | lane.create (one, or two when hedged)
  {
    from: 'queued', type: 'granted',
    to: () => 'active',
    intents: (e) => (e.hedge ? [{ intent: 'lane.create' }, { intent: 'lane.create' }] : [{ intent: 'lane.create' }]),
  },
  // active | a lane produced a change that reaches confirmed | done | card.update
  {
    from: 'active', type: 'lane.confirmed',
    to: () => 'done',
    intents: () => [{ intent: 'card.update' }],
  },
  // active | every lane closed without a change, attempts left | queued | ladder picks the next pool
  {
    from: 'active', type: 'lane.closed',
    guard: (e) => e.attemptsLeft === true,
    to: () => 'queued',
    intents: () => [{ intent: 'ladder', mode: 'next-pool' }],
  },
  // active | attempts exhausted | parked{reason, until} | card.create(lane_insight)
  {
    from: 'active', type: 'lane.closed',
    guard: (e) => e.attemptsLeft === false,
    to: () => 'parked',
    data: (e) => ({ reason: e.reason, until: e.until }),
    intents: () => [{ intent: 'card.create', kind: 'lane_insight' }],
  },
  // parked | until passed or operator revive | queued | none
  {
    from: 'parked', type: 'revive',
    guard: (e) => e.untilPassed === true || e.operator === true,
    to: () => 'queued',
    intents: () => [],
  },
  // any | retired{superseded | dropped} | retired | card.create
  {
    from: 'ANY', type: 'retired',
    guard: (e) => e.superseded === true || e.dropped === true,
    to: () => 'retired',
    data: (e) => ({ cause: e.superseded ? 'superseded' : 'dropped' }),
    intents: () => [{ intent: 'card.create' }],
  },
];

export function reduce(state, event) {
  return reduceTable(state, event, TABLE, {
    // "any" means any EXISTING row, not one never proposed.
    matchesFrom: (row, status) => (row.from === 'ANY' ? status !== null : row.from === status),
  });
}

// Re-exported so the row's ladder-related intents can be checked against the
// real ladder vocabulary without re-typing it (see axis-machine-lane.mjs and
// axis-machines.mjs for the same pattern against claims.sh).
export function retryLadderPath() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(root, 'ops', 'fleet', 'queue-ceo', 'retry-ladder.sh');
}
export function readRetryLadderSource() {
  return readFileSync(retryLadderPath(), 'utf8');
}
