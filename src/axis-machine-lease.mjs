// PURE REDUCER FOR THE `lease` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `lease` is a scheduler grant of a resource to a unit (LEDGER.md,
// "Units"). This file is the transition table from docs/axis/LEDGER.md's
// "### lease" section: `requested -> granted{ttl} -> released | expired |
// revoked`, plus the sentence right after it: "A lease must be renewed by
// its holder before ttl. `expired` moves the holder unit to `reconcile`."
//
// DEVIATION from the literal one-line chain: that sentence describes
// renewal but the chain has no event for it, so a granted lease could never
// legally stay granted past a renewal -- it could only ever expire. A
// `renewed` event is added below to make the described behaviour reachable;
// it is called out again in the PR body.
//
// `released` is checked against the same closed vocabulary
// `axis-machine-lane.mjs` builds from `claims.sh:77` plus the AXIS-only
// reasons (F-27): a `reason` outside that vocabulary is refused here, not
// silently accepted and then dropped somewhere downstream the way
// `stage8.sh:3785`'s `ladder-advise` is today.
import { releaseReasonVocabulary } from './axis-machine-lane.mjs';
import { reduceTable } from './axis-machine-shared.mjs';

export const STATES = Object.freeze(['requested', 'granted', 'released', 'expired', 'revoked']);

export const TERMINAL_STATES = Object.freeze(['released', 'expired', 'revoked']);

const TABLE = [
  // (none) --requested{resource, holder, class}--> requested
  {
    from: null, type: 'requested',
    to: () => 'requested',
    data: (e) => ({ resource: e.resource, holder: e.holder, class: e.class }),
    intents: () => [],
  },
  // requested --granted{ttl}--> granted
  {
    from: 'requested', type: 'granted',
    to: () => 'granted',
    data: (e) => ({ ttl: e.ttl, expires: e.expires }),
    intents: () => [],
  },
  // granted --renewed{ttl}--> granted (see the DEVIATION note above)
  {
    from: 'granted', type: 'renewed',
    to: () => 'granted',
    data: (e) => ({ ttl: e.ttl, expires: e.expires }),
    intents: () => [],
  },
  // granted --released{reason}--> released
  {
    from: 'granted', type: 'released',
    guard: (e) => releaseReasonVocabulary().has(e.reason),
    to: () => 'released',
    data: (e) => ({ reason: e.reason }),
    intents: () => [],
  },
  // granted --expired--> expired ("expired moves the holder unit to reconcile")
  {
    from: 'granted', type: 'expired',
    to: () => 'expired',
    intents: (e, s) => [{ intent: 'holder.reconcile', holder: s && s.holder }],
  },
  // granted --revoked{by}--> revoked
  {
    from: 'granted', type: 'revoked',
    to: () => 'revoked',
    data: (e) => ({ by: e.by }),
    intents: () => [],
  },
];

export function reduce(state, event) {
  return reduceTable(state, event, TABLE);
}
