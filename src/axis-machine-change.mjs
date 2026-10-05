// PURE REDUCER FOR THE `change` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `change` is a diff that could land on master (LEDGER.md, "Units"). This
// file is the transition table from docs/axis/LEDGER.md's "### change"
// section, translated to code with nothing invented beyond what that table
// says. Every row below cites the table row it implements.
//
// CONTRACT (LEDGER.md, "State machines"): `reduce(state, event) ->
// { next, intents } | { refused, why }`. A reducer never does I/O and never
// applies an event partly -- a pair not in the table is refused, with the
// state and event recorded, not silently ignored.
//
// RETIRING is the real class set from `unlanded-drain.mjs:44-49` (imported,
// not re-typed -- a retyped vocabulary drifts the moment either file
// changes, and PACKETS.md cites that exact line range for the source of
// truth).
import { RETIRING } from './unlanded-drain.mjs';
import { reduceTable } from './axis-machine-shared.mjs';

/** States this machine can be in. `null` is "(none)": the unit does not exist yet. */
export const STATES = Object.freeze([
  'captured', 'deciding', 'eligible', 'needs-revise', 'awaiting-operator',
  'queued', 'speculating', 'verified', 'landing', 'landed', 'confirmed', 'retired',
]);

// States with no outgoing row below: this machine's rest positions.
export const TERMINAL_STATES = Object.freeze(['retired', 'confirmed']);

// Table rows, in the order docs/axis/LEDGER.md lists them under "### change".
const TABLE = [
  // (none) | captured{source, commit, patch_id, files} | captured | fingerprint(change), triage
  {
    from: null, type: 'captured',
    to: () => 'captured',
    data: (e) => ({ source: e.source, commit: e.commit, patch_id: e.patch_id, files: e.files }),
    intents: () => [{ intent: 'fingerprint', unit: 'change' }, { intent: 'triage' }],
  },
  // captured | triaged{class} in RETIRING | retired | card.create, record.write
  {
    from: 'captured', type: 'triaged',
    guard: (e) => RETIRING.has(e.class),
    to: () => 'retired',
    data: (e) => ({ class: e.class }),
    intents: () => [{ intent: 'card.create' }, { intent: 'record.write' }],
  },
  // captured | triaged{class: CONFLICTS} | deciding | decide(patch.verdict)
  {
    from: 'captured', type: 'triaged',
    guard: (e) => e.class === 'CONFLICTS',
    to: () => 'deciding',
    data: (e) => ({ class: e.class }),
    intents: () => [{ intent: 'decide', kind: 'patch.verdict' }],
  },
  // captured | triaged{class: APPLIES-CLEAN} | eligible | preflight, decide(patch.verdict) shadow
  {
    from: 'captured', type: 'triaged',
    guard: (e) => e.class === 'APPLIES-CLEAN',
    to: () => 'eligible',
    data: (e) => ({ class: e.class }),
    intents: () => [{ intent: 'preflight' }, { intent: 'decide', kind: 'patch.verdict', shadow: true }],
  },
  // captured | triaged{class: lane-diff | pr} | eligible | preflight
  {
    from: 'captured', type: 'triaged',
    guard: (e) => e.class === 'lane-diff' || e.class === 'pr',
    to: () => 'eligible',
    data: (e) => ({ class: e.class }),
    intents: () => [{ intent: 'preflight' }],
  },
  // deciding | decided{label: SUPERSEDED | DROP} | retired | card.create, record.write
  {
    from: 'deciding', type: 'decided',
    guard: (e) => e.label === 'SUPERSEDED' || e.label === 'DROP',
    to: () => 'retired',
    data: (e) => ({ label: e.label }),
    intents: () => [{ intent: 'card.create' }, { intent: 'record.write' }],
  },
  // deciding | decided{label: KEEP, applies: true} | eligible | preflight
  {
    from: 'deciding', type: 'decided',
    guard: (e) => e.label === 'KEEP' && e.applies === true,
    to: () => 'eligible',
    data: (e) => ({ label: e.label }),
    intents: () => [{ intent: 'preflight' }],
  },
  // deciding | decided{label: KEEP, applies: false} | needs-revise | row.create(port)
  {
    from: 'deciding', type: 'decided',
    guard: (e) => e.label === 'KEEP' && e.applies === false,
    to: () => 'needs-revise',
    data: (e) => ({ label: e.label }),
    intents: () => [{ intent: 'row.create', mode: 'port' }],
  },
  // deciding | decided{label: NEEDS-MARC} | awaiting-operator | card.create(needs_marc)
  {
    from: 'deciding', type: 'decided',
    guard: (e) => e.label === 'NEEDS-MARC',
    to: () => 'awaiting-operator',
    data: (e) => ({ label: e.label }),
    intents: () => [{ intent: 'card.create', kind: 'needs_marc' }],
  },
  // eligible | preflight{ok} | queued | queue.enqueue
  {
    from: 'eligible', type: 'preflight',
    guard: (e) => e.ok === true,
    to: () => 'queued',
    intents: () => [{ intent: 'queue.enqueue' }],
  },
  // eligible | preflight{fail, reason} | needs-revise | row.create(revise) or ladder rung
  {
    from: 'eligible', type: 'preflight',
    guard: (e) => e.fail === true,
    to: () => 'needs-revise',
    data: (e) => ({ reason: e.reason }),
    intents: (e) => [{ intent: 'row.create', mode: 'revise', reason: e.reason }],
  },
  // queued | stacked{position, base} | speculating | run(tree_i)
  {
    from: 'queued', type: 'stacked',
    to: () => 'speculating',
    data: (e) => ({ position: e.position, base: e.base }),
    intents: (e) => [{ intent: 'run', tree: e.position }],
  },
  // speculating | run.passed and every earlier position passed | verified | land
  {
    from: 'speculating', type: 'run.passed',
    guard: (e) => e.everyEarlierPassed === true,
    to: () => 'verified',
    intents: () => [{ intent: 'land' }],
  },
  // speculating | run.failed{blame: self} | needs-revise | ladder rung 1 = author
  {
    from: 'speculating', type: 'run.failed',
    guard: (e) => e.blame === 'self',
    to: () => 'needs-revise',
    intents: () => [{ intent: 'ladder', rung: 1, target: 'author' }],
  },
  // speculating | run.failed{blame: other} or restacked | queued | none
  {
    from: 'speculating', type: 'run.failed',
    guard: (e) => e.blame === 'other',
    to: () => 'queued',
    intents: () => [],
  },
  {
    from: 'speculating', type: 'restacked',
    to: () => 'queued',
    intents: () => [],
  },
  // speculating | run.flaky{file} | speculating | quarantine(test file), rerun
  {
    from: 'speculating', type: 'run.flaky',
    to: () => 'speculating',
    intents: (e) => [{ intent: 'quarantine', file: e.file }, { intent: 'rerun' }],
  },
  // verified | landing.started | landing | push(master, tree)
  {
    from: 'verified', type: 'landing.started',
    to: () => 'landing',
    intents: () => [{ intent: 'push', target: 'master' }],
  },
  // landing | landed{sha} | landed | card.update, record.write (LANDED-IN)
  {
    from: 'landing', type: 'landed',
    to: () => 'landed',
    data: (e) => ({ sha: e.sha }),
    intents: () => [{ intent: 'card.update' }, { intent: 'record.write', kind: 'LANDED-IN' }],
  },
  // landing | push timed out | reconcile | readback(origin/master)
  {
    from: 'landing', type: 'push-timeout',
    to: () => 'reconcile',
    intents: () => [{ intent: 'readback', of: 'origin/master' }],
  },
  // landed | master green at a head containing it | confirmed | none
  {
    from: 'landed', type: 'master-green',
    to: () => 'confirmed',
    intents: () => [],
  },
  // landed | reverted{failing} | needs-revise | reland ladder
  {
    from: 'landed', type: 'reverted',
    to: () => 'needs-revise',
    data: (e) => ({ failing: e.failing }),
    intents: () => [{ intent: 'ladder', mode: 'reland' }],
  },
  // needs-revise --(row created, lane produces a new change)--> retired(replaced)
  // Not a labelled table row, but named directly in the diagram text under
  // "### change"; no intent is listed there, so none is added here.
  {
    from: 'needs-revise', type: 'superseded',
    to: () => 'retired',
    data: (e) => ({ replaced: true, by: e.by }),
    intents: () => [],
  },
];

export function reduce(state, event) {
  return reduceTable(state, event, TABLE);
}
