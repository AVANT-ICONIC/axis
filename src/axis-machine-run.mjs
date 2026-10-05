// PURE REDUCER FOR THE `run` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `run` is one test run over one tree (LEDGER.md, "Units"). This file is
// the transition chain from docs/axis/LEDGER.md's "### run" section:
// `planned -> admitted -> running -> passed | failed{files} | flaky{files}
// | infra{why} | unknown`. Per-file results never go through this reducer
// (LEDGER.md: "They go to the fingerprint store, keyed by file key.").
//
// `infra` covers the cases docs/MERGE_PIPELINE.md already refuses to call
// red: a deadline, a spawn storm, no summary, exit 124, admission refused
// (exit 75) -- listed here only as documentation of WHY `infra{why}` exists
// as its own terminal state distinct from `failed` (F-22: "a deadline kill
// recorded as a red test").
import { reduceTable } from './axis-machine-shared.mjs';

export const STATES = Object.freeze(['planned', 'admitted', 'running', 'passed', 'failed', 'flaky', 'infra', 'unknown']);

export const TERMINAL_STATES = Object.freeze(['passed', 'failed', 'flaky', 'infra', 'unknown']);

const TABLE = [
  { from: null, type: 'planned', to: () => 'planned', data: (e) => ({ tree: e.tree, request: e.request }), intents: () => [] },
  { from: 'planned', type: 'admitted', to: () => 'admitted', intents: () => [{ intent: 'lease.grant', resource: 'suite' }] },
  { from: 'admitted', type: 'started', to: () => 'running', intents: () => [] },
  { from: 'running', type: 'passed', to: () => 'passed', intents: () => [] },
  { from: 'running', type: 'failed', to: () => 'failed', data: (e) => ({ files: e.files }), intents: () => [] },
  { from: 'running', type: 'flaky', to: () => 'flaky', data: (e) => ({ files: e.files }), intents: () => [{ intent: 'quarantine' }] },
  { from: 'running', type: 'infra', to: () => 'infra', data: (e) => ({ why: e.why }), intents: () => [] },
  { from: 'running', type: 'unknown', to: () => 'unknown', data: (e) => ({ why: e.why }), intents: () => [] },
];

export function reduce(state, event) {
  return reduceTable(state, event, TABLE);
}
