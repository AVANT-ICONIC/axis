// REGISTRY FOR AXIS'S SEVEN STATE MACHINES. AXIS P02 (docs/axis/PACKETS.md).
//
// One place that lists the seven pure reducers docs/axis/LEDGER.md defines
// (`change`, `row`, `lane`, `run`, `decision`, `card`, `lease`), so a caller
// (P01's ledger, which injects reducers rather than importing them itself --
// PACKETS.md P01: "Reducers are injected, so P01 does not wait for P02") can
// get all seven from one import instead of naming each file.
//
// `reduce(kind, current, event) -> { next, intents } | { refused, why }`
// matches LEDGER.md's "State machines" section exactly: the kind selects
// which of the seven pure functions runs; an unknown kind is refused the
// same way an unknown (state, event) pair inside one machine is.
import * as change from './axis-machine-change.mjs';
import * as row from './axis-machine-row.mjs';
import * as lane from './axis-machine-lane.mjs';
import * as run from './axis-machine-run.mjs';
import * as decision from './axis-machine-decision.mjs';
import * as card from './axis-machine-card.mjs';
import * as lease from './axis-machine-lease.mjs';

export const MACHINES = Object.freeze({ change, row, lane, run, decision, card, lease });

export const KINDS = Object.freeze(Object.keys(MACHINES));

/** `reduce('lane', state, event) -> { next, intents } | { refused, why }`.
 * An unrecognised kind is refused, never thrown -- a caller building a kind
 * string from unread input gets the same tri-state contract every reducer
 * gives an unreadable event (LEDGER.md, F-24: "a failed read becomes a
 * verdict"). */
export function reduce(kind, state, event) {
  const machine = MACHINES[kind];
  if (!machine) {
    return { refused: true, state, event, why: `unknown kind: ${String(kind)}` };
  }
  return machine.reduce(state, event);
}

/** Terminal states per kind, keyed the same way MACHINES is. Used by the
 * lane machine's L1 property test, and by anything that needs to know
 * whether a unit is at rest without re-deriving it from each table. */
export const TERMINAL_STATES = Object.freeze(
  Object.fromEntries(KINDS.map((k) => [k, MACHINES[k].TERMINAL_STATES]))
);

// --- F-27: the release-reason vocabulary, re-exported from the lane machine
//
// The lane machine owns reading claims.sh (it is the one that emits
// `lease.release` intents on every terminal transition, L1), and the lease
// machine imports the same function to validate a `released` event's
// `reason`. This registry just re-exports it so a caller of the registry
// does not need to know which of the seven files happens to own the read.
export const { releaseReasonVocabulary, bashClaimReleaseReasons, AXIS_RELEASE_REASONS, claimsShPath, isValidReleaseReason } = lane;

// --- W10: the shadow that came first
//
// From 2026-09-26 shadowReducers(primary) wrapped the placeholder and kept, in each unit's
// `data.axisMachine`, what the machine for its kind would have said. It never saw a real lane:
// stage8 writes through `axis lane event`, which opened the ledger with the bare placeholder, so
// no unit in the live ledger ever carried `axisMachine` (MEASURED 2026-09-29, 0 of 4,859 units).
// The swap below was proven by replaying the recorded events instead (docs/axis/SHADOW-REPORT-
// 20260930.md), and the shadow wrapper was deleted with it (tombstone symbol--shadowReducers).
const SHADOW_KEY = 'axisMachine';

// --- W10, the swap: the seven machines decide ------------------------------------------------
//
// The ledger's reducer contract is `(current {state, data}, event {type, payload}) ->
// { next: {state, data}, intents } | { refused, why }`; a machine's is `(state {status, ...},
// flat event) -> { next: {status, ...}, intents } | { refused, why }`. machineReducers() is the
// adapter, and the registry every production writer opens the ledger with once the placeholder
// is gone (axisd, `axis emit`, `axis lane event`). A kind no machine knows (`detector`, `verdict`,
// anything new) still goes to `fallback`, the permissive reducer, so no writer loses a kind.
//
// DATA KEEPS THE PAYLOAD. The placeholder folded every payload into `data`, and the readers of a
// lane unit (`axis why`, the census, the cards) read `row`, `pool`, `outcome` from there. The
// machine's own fields (`leases`, `path`, `cause`, ...) are laid over it; `status` becomes the
// unit's `state`.
//
// A UNIT THE PLACEHOLDER LEFT BEHIND. A lane that was in flight when this shipped carries the
// placeholder's state, the last event type: `granted`, `cloned` or `spawned`, none of which is a
// lane machine state. They are read as the state that event puts a lane in (admitted,
// workspace-ready, running), so an in-flight lane finishes through the machine instead of being
// refused for the rest of its life.
export const MACHINE_REDUCER_VERSION = 'axis-machines-v1';

const PLACEHOLDER_LANE_STATES = Object.freeze({ granted: 'admitted', cloned: 'workspace-ready', spawned: 'running' });

function machineStatusOf(kind, current) {
  if (!current) return null;
  if (kind === 'lane' && Object.hasOwn(PLACEHOLDER_LANE_STATES, current.state)) return PLACEHOLDER_LANE_STATES[current.state];
  return current.state ?? null;
}

function machineReducer(kind, machine) {
  const reducer = (current, event) => {
    const { [SHADOW_KEY]: _shadow, ...data } = current?.data ?? {};
    const state = current ? { ...data, status: machineStatusOf(kind, current) } : null;
    let verdict;
    try {
      verdict = machine.reduce(state, { ...(event?.payload ?? {}), type: event?.type });
    } catch (err) {
      verdict = { refused: true, why: `machine threw: ${err.message}` };
    }
    if (verdict.refused) return { refused: true, why: verdict.why ?? 'refused' };
    const { status, ...machineData } = verdict.next;
    return {
      next: { state: status, data: { ...data, ...(event?.payload ?? {}), ...machineData } },
      intents: verdict.intents ?? [],
    };
  };
  reducer.version = MACHINE_REDUCER_VERSION;
  return reducer;
}

/** The seven machines as a ledger reducer registry; every other kind resolves to `fallback`. */
export function machineReducers(fallback) {
  const own = Object.fromEntries(KINDS.map((k) => [k, machineReducer(k, MACHINES[k])]));
  return new Proxy(own, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(target, prop)) return target[prop];
      return fallback?.[prop];
    },
    has(target, prop) {
      return Object.hasOwn(target, prop) || (fallback ? prop in fallback : false);
    },
  });
}
