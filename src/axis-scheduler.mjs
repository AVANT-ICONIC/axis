// AXIS P10 -- primitive (h), the admission half. One `admit()` for
// everything that consumes the machine or a provider (SCHEDULER.md). Takes
// a `readings()` result and the current lease table as plain data -- no I/O,
// no clock but the one passed in -- so it is a pure function over the
// world's state, exactly like axis-machine-*.mjs's `reduce`.
//
// Zero dependencies beyond node:fs for the one read-only slider lookup.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Classes and order (SCHEDULER.md "Classes and order"). Landing beats
// verifying beats deciding beats producing beats idle.
export const CLASSES = Object.freeze(['land', 'verify', 'decide', 'produce', 'idle']);

// Load-per-core ceiling per class (SCHEDULER.md "Admission"; its first draft
// read "land none, verify 4, produce 2.5, idle 1", and both middle numbers
// were replaced by measurements below). `land` has no ceiling; `decide` is "cheap on the machine"
// per SCHEDULER.md's Resources note, so it is also uncapped here.
//
// `produce` was 2.5 in the spec draft, before this machine's own operating
// range was measured (AXIS.md "Measure first" lists M-S1..M-S3 as still to
// measure). The W3 shadow (`.ledger/todo/axis-w3-cut-shadow-disagrees-
// 20260927.md`, 239 decisions, 2026-09-26 22:57Z-2026-09-27 05:14Z) measured
// this 10-core Mac's actual load1/core during ORDINARY fleet operation --
// legacy `pool-launch.sh` launching lanes the whole window, nothing stuck:
// p10 4.3, p50 12.1, p90 22.1 -- and 2.5 refused 96 of those 239 launches on
// load alone (`load-ceiling`), each one a lane legacy correctly started.
// CPU is the "soft" resource here (SCHEDULER.md's Resources table: "soft:
// degrades gracefully", unlike memory, "the hard one"), and a raw load
// average does not separate a genuinely full machine from threads blocked on
// I/O or provider round-trips (AGENTS.md: "load-is-a-stuck-process-and-a-
// full-machine ... high loadavg is usually OUR code misreading it"). 25 is
// set above the measured p90 with headroom, so `produce` stops refusing
// routine operation on this machine while still catching load genuinely
// beyond what the fleet produces day to day; memory (`mem.state`) stays the
// hard gate below and is untouched by this calibration.
export const PRODUCE_LOAD_CEILING_MEASURED_20260927 = 25;

// `verify` was 4, the spec draft's number, and after `produce` moved to 25 it
// sat BELOW produce: a lane could start at load/core 20 while the gate and CI
// suites that verify its work waited, and a produce request aged 15 minutes
// into `verify` became harder to admit, not easier. SCHEDULER.md's class
// order says the opposite (landing beats verifying beats producing), so the
// machine ceilings must not rise as the class falls (the test pins it).
//
// MEASURED 2026-09-28 12:03Z to 2026-09-29 21:30Z (docs/axis/SHADOW-REPORT-
// 20260930.md): 922 of the 933 admit-suite shadow divergences were the
// scheduler refusing a suite legacy started; 912 on this ceiling (the 539
// logged as `suite-full` were a light-lane `load-ceiling` hidden behind the
// main lane's why) at load/core 4.0-32.9, the other 10 an `other` suite on
// the idle ceiling. The CI suite jobs of the window:
// 393, of which 379 started above 4/core. None reached the 20-minute job
// timeout; 18 failed in their last three minutes, where the suite deadline
// (what is left of the job) cuts them: 0 of 14 at <=4/core, 6 of 170 at 4-8,
// 6 of 140 at 8-12, 6 of 64 at 12-25. Holding verify at 4 would have queued
// 379 of 393 on a machine above 4/core for 96% of the window, and that wait
// is charged to the same job budget. The tail above 12 is the fleet
// producing more than it verifies, which class order answers by holding
// produce first, never verification. 40 keeps the spec's ratio to produce
// (4 : 2.5) on the measured produce ceiling; it is the highest load/core
// logged in three days (40.6, the 09-26 swap storm), where memory pressure
// already holds verify back.
export const VERIFY_LOAD_CEILING_MEASURED_20260929 = 40;

export const CLASS_LOAD_CEILING = Object.freeze({
  land: Infinity,
  verify: VERIFY_LOAD_CEILING_MEASURED_20260929,
  decide: Infinity,
  produce: PRODUCE_LOAD_CEILING_MEASURED_20260927,
  idle: 1,
});

// Aging (SCHEDULER.md: "Waiting longer than 15 minutes raises a request one
// class, up to verify, ... and produce can never age into land."). Same
// constant name and value as PR #1574's AGING_MS
// (verify-admission-core.mjs:186) -- both read the same fifteen-minute rule.
export const AGING_MS = 15 * 60 * 1000;

// The aging ladder only ever climbs toward `verify`, and never past it --
// `idle` -> `produce` -> `verify` is as far as any number of aging steps
// goes. `land`, `verify` and `decide` do not age at all: `land` is already
// the top, `verify` is the cap, and `decide` is a different resource
// entirely (quota, not the machine).
const AGING_LADDER = Object.freeze(['idle', 'produce', 'verify']);

export function agedClass(cls, waitedMs, agingMs = AGING_MS) {
  const steps = Math.floor((Number(waitedMs) || 0) / agingMs);
  if (steps <= 0) return cls;
  const idx = AGING_LADDER.indexOf(cls);
  if (idx === -1) return cls; // land / decide: no ladder to climb
  return AGING_LADDER[Math.min(AGING_LADDER.length - 1, idx + steps)];
}

// Committed-memory ceiling (SCHEDULER.md: "if committed_mem + request.mem >
// 0.85 * RAM: wait").
export const MEM_COMMIT_CEILING = 0.85;

// ---------------------------------------------------------------------------
// Sliders stay the operator's. `.apex/fleet-power.json` is READ, NEVER
// WRITTEN (AGENTS.md fill-the-gap exclusions: "`.apex/fleet-power.json` is
// his and is read-only to every agent"; SCHEDULER.md: "`.apex/fleet-power.json`
// is read, never written"). This module never imports `node:fs/promises`'s
// `writeFile`/`rename` and never opens the file with a write flag --
// `readFileSync(path)` defaults to flag `'r'`, so there is no write handle
// to assert against, by construction, not by discipline alone.
//
// Levels and their lane budgets, from stage8.sh:1848-1862 (off 0, escalation
// 1 emergency-only, small 2, normal 4, drain unlimited) and
// fleet-power.mjs's UNSET_LEVEL: "a missing key reads as normal"
// (SCHEDULER.md). Duplicated here rather than imported so this packet stays
// self-contained (PACKETS.md P10 "Depends on: nothing"); fleet-power.mjs
// remains the one place that WRITES the file (setPower) and is the
// authority if the two ever disagree.
export const SLIDER_LEVELS = Object.freeze(['off', 'escalation', 'small', 'normal', 'drain']);
export const SLIDER_UNSET_LEVEL = 'normal';
export const SLIDER_LANE_BUDGET = Object.freeze({
  off: 0,
  escalation: 1, // emergency only -- a caller outside an emergency must not request quota for this level
  small: 2,
  normal: 4,
  drain: Infinity,
});

/**
 * Read `.apex/fleet-power.json`, read-only, never throwing. An unreadable or
 * unparseable file reads as `{}` (every key then resolves through
 * `SLIDER_UNSET_LEVEL`), matching "a missing key reads as normal"
 * everywhere, including "the file itself is missing".
 */
export function readFleetPowerLevelsSync(path) {
  try {
    const text = readFileSync(path, 'utf8'); // default flag 'r' -- read-only, no write handle ever opened
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function sliderLevelFor(levels, account) {
  const key = typeof account === 'string' ? account.trim().toLowerCase() : '';
  if (!key) return SLIDER_UNSET_LEVEL;
  const raw = levels && typeof levels === 'object' ? levels[key] : undefined;
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SLIDER_LEVELS.includes(id) ? id : SLIDER_UNSET_LEVEL;
}

export function defaultApexPowerPath(root = process.cwd()) {
  return join(root, '.apex', 'fleet-power.json');
}

// ---------------------------------------------------------------------------
// Preemption under CRIT (SCHEDULER.md: "checkpoints and stops the most
// recently admitted `produce` lanes ... until pressure is back under HIGH,
// then resumes them in admission order"). Newest-produce-first.
export function preemptionList(leases) {
  return (Array.isArray(leases) ? leases : [])
    .filter((l) => l && !l.released && l.class === 'produce')
    .slice()
    .sort((a, b) => (Number(b.grantedAt) || 0) - (Number(a.grantedAt) || 0));
}

function activeLeases(leases) {
  return (Array.isArray(leases) ? leases : []).filter((l) => l && !l.released);
}

function scopesOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((p) => set.has(p));
}

// The `suite` resource (SCHEDULER.md "Resources": "suite | slots | the
// existing slot directory | kept as a unit for runs, now a lease kind").
// verify-admission-core.mjs owns the slot files and the machine queue, so it
// hands the scheduler the counts it read: `held` suites in the slot kind this
// run asks for, `ahead` claimable tickets ranked before it, `capacity` slots
// of that kind, and `machineHeld`, every suite on the machine in any kind.
//
// THE MACHINE'S LAST SUITE IS NEVER REFUSED. With `machineHeld === 0` no
// reading (unknown, high, crit, load) holds the run back: a machine that
// refuses its only suite over memory has deadlocked into zero tests, which
// is worse than the swap storm the refusal exists to prevent (#1574's rule,
// kept when its decision moved here). Only the slot count itself can.
function suiteResource(suite) {
  if (!suite || typeof suite !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const held = n(suite.held);
  return {
    held,
    ahead: n(suite.ahead),
    capacity: n(suite.capacity),
    machineHeld: suite.machineHeld == null ? held : n(suite.machineHeld),
  };
}

/**
 * `admit(request, readings, leases) -> { grant } | { wait, why }`
 *
 * `request`: { class, mem, scope?, pool?, poolConcurrency?, family?,
 *   familyConcurrency?, account?, waitedMs?, id?,
 *   suite?: { held, ahead, capacity, machineHeld } }
 * `readings`: the object returned by `axis-readings.mjs`'s `readings()`.
 * `leases`: the current lease table, each `{ id, class, mem, scope, pool,
 *   family, account, grantedAt, released }`.
 */
export function admit(request, readingsIn, leases = [], { now = Date.now() } = {}) {
  if (!request || typeof request !== 'object') {
    return { wait: true, why: 'bad-request' };
  }
  const cls = request.class;
  if (!CLASSES.includes(cls)) return { wait: true, why: 'bad-class' };

  const mem = readingsIn && readingsIn.mem;
  const memUnknown = !mem || mem.state === 'unknown';
  const live = activeLeases(leases);
  const suite = suiteResource(request.suite);

  if (suite) {
    if (suite.held + suite.ahead >= suite.capacity) return { wait: true, why: 'suite-full' };
    if (suite.machineHeld === 0) {
      return { grant: makeGrant(request, now, { class: cls, effClass: agedClass(cls, request.waitedMs), memUnknown }) };
    }
  }

  // Fail closed below `land`: an unreadable memory reading admits land
  // only, one at a time.
  if (memUnknown) {
    if (cls !== 'land') return { wait: true, why: 'mem-unreadable' };
    if (live.some((l) => l.class === 'land')) return { wait: true, why: 'mem-unreadable-land-busy' };
    return { grant: makeGrant(request, now, { class: 'land', memUnknown: true }) };
  }

  // Aging is evaluated FIRST: a long-waiting `produce` or `idle` request is
  // admitted under its aged, effective class for every gate below,
  // including the pressure gates (SCHEDULER.md's aging rule exists
  // precisely so a starved request eventually clears HIGH's "land and
  // verify only").
  const effClass = agedClass(cls, request.waitedMs);

  const preempt = mem.state === 'crit' ? preemptionList(live) : undefined;

  if (mem.state === 'crit' && effClass !== 'land') {
    return { wait: true, why: 'pressure-crit', preempt };
  }
  if (mem.state === 'high' && effClass !== 'land' && effClass !== 'verify') {
    return { wait: true, why: 'pressure-high' };
  }

  // Committed-memory ceiling.
  const totalBytes = Number(mem.totalBytes);
  if (Number.isFinite(totalBytes) && totalBytes > 0) {
    const committed = live.reduce((sum, l) => sum + (Number(l.mem) || 0), 0);
    const reqMem = Number(request.mem) || 0;
    if (committed + reqMem > MEM_COMMIT_CEILING * totalBytes) {
      return { wait: true, why: 'mem-ceiling' };
    }
  }

  // Load-per-core ceiling for the EFFECTIVE (aged) class.
  const cpu = readingsIn.cpu;
  const ceiling = CLASS_LOAD_CEILING[effClass] ?? Infinity;
  if (cpu && cpu.state !== 'unknown' && Number.isFinite(cpu.value) && Number.isFinite(ceiling) && cpu.value > ceiling) {
    return { wait: true, why: 'load-ceiling' };
  }

  // Scope leases: two overlapping scopes never both granted.
  const scope = Array.isArray(request.scope) ? request.scope : [];
  if (scope.length) {
    const overlap = live.some((l) => scopesOverlap(l.scope, scope));
    if (overlap) return { wait: true, why: 'scope-overlap' };
  }

  // Pool concurrency.
  if (request.pool != null && Number.isFinite(Number(request.poolConcurrency))) {
    const cap = Number(request.poolConcurrency);
    const held = live.filter((l) => l.pool === request.pool).length;
    if (held >= cap) return { wait: true, why: 'pool-full' };
  }

  // Upstream family concurrency.
  if (request.family != null && Number.isFinite(Number(request.familyConcurrency))) {
    const cap = Number(request.familyConcurrency);
    const held = live.filter((l) => l.family === request.family).length;
    if (held >= cap) return { wait: true, why: 'family-full' };
  }

  // Quota: the operator's slider, read-only.
  if (request.account != null) {
    const levels = typeof request.fleetPowerLevels === 'object' && request.fleetPowerLevels !== null
      ? request.fleetPowerLevels
      : readFleetPowerLevelsSync(request.apexPowerPath || defaultApexPowerPath(request.root));
    const level = sliderLevelFor(levels, request.account);
    const budget = SLIDER_LANE_BUDGET[level] ?? SLIDER_LANE_BUDGET[SLIDER_UNSET_LEVEL];
    if (level === 'escalation' && !request.emergency) {
      return { wait: true, why: 'quota-escalation-not-emergency' };
    }
    const held = live.filter((l) => l.account === request.account).length;
    if (Number.isFinite(budget) && held >= budget) {
      return { wait: true, why: 'quota' };
    }
  }

  return { grant: makeGrant(request, now, { class: cls, effClass, preempt: mem.state === 'crit' ? preempt : undefined }) };
}

function makeGrant(request, now, extra) {
  return {
    id: request.id || `lease-${now}-${Math.random().toString(36).slice(2, 10)}`,
    class: extra.class,
    effClass: extra.effClass ?? extra.class,
    mem: Number(request.mem) || 0,
    scope: Array.isArray(request.scope) ? request.scope.slice() : [],
    pool: request.pool ?? null,
    family: request.family ?? null,
    account: request.account ?? null,
    grantedAt: now,
    ttl: Number.isFinite(Number(request.deadline)) ? Number(request.deadline) : null,
    released: false,
    memUnknown: Boolean(extra.memUnknown),
    ...(extra.preempt ? { preempt: extra.preempt } : {}),
  };
}
