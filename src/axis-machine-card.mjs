// PURE REDUCER FOR THE `card` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `card` is a harvested item a person can browse and revive (LEDGER.md,
// "Units"). This file is the transition chain from docs/axis/LEDGER.md's
// "### card" section: `listed -> revived(row) | archived | landed`.
//
// "A card is never deleted. `archived` only hides it from the default
// gallery view" -- there is no `deleted` event anywhere in this reducer,
// by construction, not by convention (HARVEST.md owns the gallery view
// that reads `archived` as a filter, not this reducer).
import { reduceTable } from './axis-machine-shared.mjs';

export const STATES = Object.freeze(['listed', 'revived', 'archived', 'landed']);

// `listed` is the only state with outgoing rows below.
export const TERMINAL_STATES = Object.freeze(['revived', 'archived', 'landed']);

const TABLE = [
  { from: null, type: 'listed', to: () => 'listed', data: (e) => ({ source: e.source }), intents: () => [] },
  {
    from: 'listed', type: 'revived',
    to: () => 'revived',
    data: (e) => ({ row: e.row }),
    intents: (e) => [{ intent: 'row.attach', row: e.row }],
  },
  { from: 'listed', type: 'archived', to: () => 'archived', intents: () => [] },
  { from: 'listed', type: 'landed', to: () => 'landed', data: (e) => ({ sha: e.sha }), intents: () => [] },
];

export function reduce(state, event) {
  return reduceTable(state, event, TABLE);
}
