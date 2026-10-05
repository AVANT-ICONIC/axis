// PURE REDUCER FOR THE `decision` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `decision` is one question asked of the decider tier (LEDGER.md,
// "Units"). This file is the transition chain from docs/axis/LEDGER.md's
// "### decision" section: `open -> asked{tier} -> answered{label,
// confidence, decider, cost} -> final | escalated -> asked{tier+1}`.
//
// "A `final` decision can be overridden by a newer decision about the same
// subject, which records `overrides: dec_...`." That override is a NEW
// decision unit's data (an `about`/`overrides` edge, per LEDGER.md's edge
// table), not a transition of THIS unit -- "Nothing is edited in place, so
// every retired patch can show who decided, at which tier, at what
// calibrated precision." `final` is therefore this machine's rest position;
// there is no row that leaves it.
import { reduceTable } from './axis-machine-shared.mjs';

export const STATES = Object.freeze(['open', 'asked', 'final', 'escalated']);

export const TERMINAL_STATES = Object.freeze(['final']);

const TABLE = [
  { from: null, type: 'opened', to: () => 'open', data: (e) => ({ kind: e.kind, subject: e.subject }), intents: () => [] },
  {
    from: 'open', type: 'asked',
    to: () => 'asked',
    data: (e) => ({ tier: e.tier }),
    intents: (e) => [{ intent: 'decider.ask', tier: e.tier }],
  },
  {
    from: 'escalated', type: 'asked',
    to: () => 'asked',
    data: (e) => ({ tier: e.tier }),
    intents: (e) => [{ intent: 'decider.ask', tier: e.tier }],
  },
  // asked | answered{...}, no escalation | final | none
  {
    from: 'asked', type: 'answered',
    guard: (e) => e.escalate !== true,
    to: () => 'final',
    data: (e) => ({ label: e.label, confidence: e.confidence, decider: e.decider, cost: e.cost }),
    intents: () => [],
  },
  // asked | answered{...}, escalate | escalated | none (a later `asked{tier+1}` follows)
  {
    from: 'asked', type: 'answered',
    guard: (e) => e.escalate === true,
    to: () => 'escalated',
    data: (e) => ({ label: e.label, confidence: e.confidence, decider: e.decider, cost: e.cost }),
    intents: () => [],
  },
];

export function reduce(state, event) {
  return reduceTable(state, event, TABLE);
}
