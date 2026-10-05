/* AXIS P05 -- exact blame and the speculative queue planner
 * (TEST-ENGINE.md "Change T3", MERGE-QUEUE.md "The algorithm", "Invariant Q1", 2026-09-26).
 *
 * Both functions here are pure: no git calls, no filesystem, no clock. MERGE-QUEUE.md's
 * `tick()` reads state off disk, calls git (`merge-tree`, `commit-tree`), and pushes; the WIRE
 * packet W4 (`merge-pipeline-conductor.mjs`) does that. This module only decides WHAT to do,
 * returned as a list of intents the caller executes and then reports back as the next `state`.
 *
 * Invariant Q1 ("master never goes red, exactly one writer") reduces, inside this module, to
 * one guarantee `plan()` must never break: a `land` intent only ever covers a PREFIX of the
 * stack whose every position has `status === 'passed'`. The moment a position is anything else
 * (`pending`, `failed`), landing stops there. tests/axis-a-red-position-never-reaches-master.test.mjs
 * is the proof.
 */

import { pack } from './axis-pack.mjs';

/**
 * TEST-ENGINE.md T3 blame:
 *   owners(t) = { c in pack : t in T(c) }
 *   t flaky            -> no blame, quarantine, rerun once
 *   owners(t) empty     -> not caused by this pack: key gap or environment, never eject
 *   owners(t) == {c}    -> c is blamed, exactly, no bisect
 *   otherwise            -> bisect over owners(t), ceil(log2 |owners|) runs of t alone
 *
 * @param {Array<{id: string|number, tests: Set<string>|string[]}>} thePack  a packed run's changes
 * @param {Iterable<string>} failed  tests that failed on this pack's tree
 * @param {Iterable<string>} flaky   the flaky quarantine (retention class `flaky`)
 */
export function blame(thePack, failed, flaky) {
  if (!Array.isArray(thePack)) {
    throw new TypeError('blame: pack must be an array');
  }
  const failedSet = toSet(failed, 'failed');
  const flakySet = toSet(flaky, 'flaky');
  const ownersOf = thePack.map((change) => ({ id: change.id, tests: toSet(change.tests, `pack[${change.id}].tests`) }));

  const ejects = [];       // [{ change, test }]
  const quarantined = [];  // [test]
  const unowned = [];      // [test]  -- key gap or environment; never eject
  const bisect = [];       // [{ test, candidates, runs }]

  for (const test of failedSet) {
    if (flakySet.has(test)) {
      quarantined.push(test);
      continue;
    }
    const owners = ownersOf.filter((c) => c.tests.has(test));
    if (owners.length === 0) {
      unowned.push(test);
    } else if (owners.length === 1) {
      ejects.push({ change: owners[0].id, test });
    } else {
      bisect.push({
        test,
        candidates: owners.map((o) => o.id),
        runs: Math.ceil(Math.log2(owners.length)),
      });
    }
  }

  const ejected = dedupe(ejects.map((e) => e.change));
  return {
    ejected,
    ejects,
    quarantined: dedupe(quarantined),
    unowned: dedupe(unowned),
    bisect,
    clean: ejected.length === 0 && bisect.length === 0,
  };
}

/**
 * MERGE-QUEUE.md tick(), split into pure decision-making. `state.S` positions the caller already
 * resolved (status 'passed' | 'failed' | 'pending') come in as given; this call never mutates
 * them, it only reads them to decide the next set of intents.
 *
 * @param {{ M: string, Q: Array<{id, files}>, S: Array<Position> }} state
 *   M  the last commit the queue pushed (or its symbolic placeholder before the first push)
 *   Q  eligible changes in priority order (MERGE-QUEUE.md "Priority order of Q")
 *   S  speculative positions, index 0 is the one built directly on M
 *      Position = { pack: PackedChange[], base: string, commit: string|null,
 *                    status: 'pending'|'passed'|'failed', failedTests?: string[] }
 * @param {{ depth: number, K: number, testsFor: Function, flaky?: Iterable<string> }} readings
 *   depth     D, already the min of scheduler.grant('land') and hedge.width(...) (P10/P14)
 *   K         adaptiveBatchSize()
 *   testsFor  injected reverse test index, same contract as pack()'s third argument
 *   flaky     the current flaky quarantine
 *   universal tests every change reaches (the index's tree-wide traces): packed across, and a
 *             red one is bisected over the whole pack by blame() (axis-pack.mjs says why)
 * @returns {{ intents: Intent[] }}
 */
export function plan(state, readings) {
  assertState(state);
  assertReadings(readings);

  const { M, Q, S } = state;
  const { depth, K, testsFor, flaky = [], universal = [] } = readings;
  const intents = [];
  const stack = S.slice();

  // --- step 1: fill the stack --------------------------------------------------------------
  let queue = Q.slice();
  while (stack.length < depth && queue.length > 0) {
    const base = refOf(stack, M);
    const packs = pack(queue, K, testsFor, { universal });
    const nextPack = packs[0];
    if (!nextPack || nextPack.length === 0) break;
    queue = queue.slice(nextPack.length);
    const positionIndex = stack.length;
    stack.push({ pack: nextPack, base, commit: null, status: 'pending' });
    intents.push({
      type: 'verify',
      positionIndex,
      base,
      changes: nextPack.map((c) => c.id),
    });
  }

  // --- step 2: land the green prefix ---------------------------------------------------------
  // The whole guarantee lives here: k only grows through 'passed' positions, so the first
  // 'pending' or 'failed' entry stops it cold. Nothing after that point is ever in a 'land'
  // intent -- a failed or still-unverified position never reaches master (Q1).
  let k = 0;
  while (k < stack.length && stack[k].status === 'passed') k++;
  if (k > 0) {
    intents.push({
      type: 'land',
      through: k,
      commit: stack[k - 1].commit,
      changes: stack.slice(0, k).flatMap((p) => p.pack.map((c) => c.id)),
    });
  }

  // --- step 3: react to the first red position at or after the landed prefix -----------------
  const redIndex = indexOfFirstFailedFrom(stack, k);
  if (redIndex !== -1) {
    const redPos = stack[redIndex];
    const result = blame(redPos.pack, redPos.failedTests || [], flaky);

    for (const id of result.ejected) {
      const failingTests = result.ejects.filter((e) => e.change === id).map((e) => e.test);
      intents.push({ type: 'eject', change: id, positionIndex: redIndex, failingTests, reason: 'red' });
    }
    for (const test of result.quarantined) {
      intents.push({ type: 'quarantine', test, positionIndex: redIndex });
    }
    for (const test of result.unowned) {
      // "a failure owned by no change ejects nothing": key gap or environment, T1's job
      // (TEST-ENGINE.md Change T1), never a change's fault.
      intents.push({ type: 'adjudicate', test, positionIndex: redIndex, reason: 'unowned' });
    }
    for (const b of result.bisect) {
      intents.push({ type: 'bisect', test: b.test, candidates: b.candidates, runs: b.runs, positionIndex: redIndex });
    }

    // "positions after a red one were built on it": every position from the red one onward is
    // rebuilt on the position before it (or on M, for the red one itself).
    for (let i = redIndex; i < stack.length; i++) {
      intents.push({ type: 'rebuild', positionIndex: i });
    }
  }

  return { intents };
}

function indexOfFirstFailedFrom(stack, from) {
  for (let i = from; i < stack.length; i++) {
    if (stack[i].status === 'failed') return i;
  }
  return -1;
}

function refOf(stack, M) {
  if (stack.length === 0) return M;
  const top = stack[stack.length - 1];
  return top.commit != null ? top.commit : `#pending:${stack.length - 1}`;
}

function toSet(value, label) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value != null && typeof value[Symbol.iterator] === 'function') return new Set(value);
  throw new TypeError(`expected an array, Set, or iterable for ${label}`);
}

function dedupe(list) {
  return [...new Set(list)];
}

function assertState(state) {
  if (state == null || typeof state !== 'object') {
    throw new TypeError('plan: state must be an object');
  }
  if (typeof state.M !== 'string' && typeof state.M !== 'number') {
    throw new TypeError('plan: state.M must be a commit identifier (string or number)');
  }
  if (!Array.isArray(state.Q)) {
    throw new TypeError('plan: state.Q must be an array');
  }
  if (!Array.isArray(state.S)) {
    throw new TypeError('plan: state.S must be an array');
  }
  for (const [i, pos] of state.S.entries()) {
    if (!['pending', 'passed', 'failed'].includes(pos && pos.status)) {
      throw new TypeError(`plan: state.S[${i}].status must be one of "pending" | "passed" | "failed"`);
    }
  }
}

function assertReadings(readings) {
  if (readings == null || typeof readings !== 'object') {
    throw new TypeError('plan: readings must be an object');
  }
  if (!Number.isInteger(readings.depth) || readings.depth < 0) {
    throw new TypeError('plan: readings.depth must be a non-negative integer');
  }
  if (!Number.isInteger(readings.K) || readings.K < 1) {
    throw new TypeError('plan: readings.K must be a positive integer');
  }
  if (typeof readings.testsFor !== 'function') {
    throw new TypeError('plan: readings.testsFor must be a function');
  }
}
