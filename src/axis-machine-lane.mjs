// PURE REDUCER FOR THE `lane` UNIT. AXIS P02 (docs/axis/PACKETS.md).
//
// A `lane` is one attempt to execute a row on one pool (LEDGER.md, "Units").
// This file is the transition table from docs/axis/LEDGER.md's "### lane"
// section.
//
// INVARIANT L1 (LEDGER.md): "every transition into a terminal lane state
// releases every lease the lane holds, in the same transaction." That is
// implemented once, below `reduce()`, as a wrapper around the table lookup
// rather than repeated per row -- the whole point of L1 is that it holds for
// EVERY terminal transition, including ones nobody thought to add a release
// intent to by hand. That is the failure this closes: "parking a lane kept
// its claim forever, 87 of 105 rows frozen" and "stage8.sh:3785 calls
// claim_release ... ladder-advise, which is not in the 16 reasons at
// claims.sh:77, so that claim is never removed" (F-27). See
// `releaseReasonVocabulary()` below for the second half of that fix.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceTable } from './axis-machine-shared.mjs';

export const STATES = Object.freeze([
  'requested', 'admitted', 'workspace-ready', 'running',
  'produced', 'closed(empty)', 'provider-fault', 'closed(provider)',
  'checkpointed', 'waiting-reset', 'resumed', 'reconcile',
]);

// States with no outgoing row in the LEDGER.md table: this machine's rest
// positions. `reconcile` has no further row here -- LEDGER.md's own
// escape-state rule (F-01) resolves it from OUTSIDE this table, by
// readback.
//
// `resumed` is NOT a rest position: P12 (checkpoint and resume) exists so a
// lane cut by quota or a deadline comes back and finishes the SAME session
// (PACKETS.md P12: `resumePlan(lane) -> { at, argv, prompt }`). The table's
// own text for `waiting-reset -> resumed` names the intent
// `spawn(pool arm, --resume session)` -- the same shape as
// `workspace-ready`'s `spawned{pid, start_time, session}` row landing on
// `running` -- and the diagram right above the table draws
// `resumed --> running`. That arrow is not itself a labelled table row, so
// the row below is this file's addition, using the table's own `spawned`
// event name for the same fact (a spawn completed) rather than inventing a
// new one; called out again in the PR body's deviations list.
export const TERMINAL_STATES = Object.freeze([
  'produced', 'closed(empty)', 'closed(provider)', 'checkpointed', 'reconcile',
]);

// --- F-27: the closed release-reason vocabulary, read from claims.sh -------
//
// claims.sh:77's CLAIM_RELEASE_REASONS is the vocabulary bash callers use
// today. AXIS adds its own reasons for releases the ledger itself triggers
// (a terminal lane transition, a lease's own ttl, a row retiring). The
// union is what a `released` event's `reason` is checked against below --
// read from the file, never retyped, so a rename of the bash vocabulary is
// never silently out of sync with this one (AGENTS.md: "an enum typed is an
// enum drawn around my expectations").
const CLAIMS_SH_RELEASE_REASONS_RE = /CLAIM_RELEASE_REASONS="([^"]*)"/;

export function claimsShPath() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(root, 'ops', 'fleet', 'queue-ceo', 'claims.sh');
}

/** Throws if claims.sh is unreadable or its vocabulary line is gone -- never
 * silently returns an empty (and therefore all-refusing-by-accident) set. */
export function bashClaimReleaseReasons() {
  const src = readFileSync(claimsShPath(), 'utf8');
  const m = CLAIMS_SH_RELEASE_REASONS_RE.exec(src);
  if (!m) throw new Error(`claims.sh: CLAIM_RELEASE_REASONS not found at ${claimsShPath()}`);
  return new Set(m[1].trim().split(/\s+/).filter(Boolean));
}

// New reasons the ledger itself uses that have no bash caller today.
export const AXIS_RELEASE_REASONS = Object.freeze([
  'lane-terminal',   // L1: a terminal lane transition releasing its own leases
  'lease-expired',   // a lease's ttl passed unrenewed
  'lease-revoked',   // the scheduler revoked a grant (SCHEDULER.md)
  'row-retired',      // the row the lease was scoped to retired
]);

let cachedVocabulary = null;
/** The union of claims.sh's 16 reasons and AXIS_RELEASE_REASONS. Computed
 * once (reduce() itself never does I/O -- LEDGER.md, "State machines"). */
export function releaseReasonVocabulary() {
  if (!cachedVocabulary) {
    cachedVocabulary = new Set([...bashClaimReleaseReasons(), ...AXIS_RELEASE_REASONS]);
  }
  return cachedVocabulary;
}

const TABLE = [
  // requested | granted{leases} | admitted | clone(seed(base))
  {
    from: 'requested', type: 'granted',
    to: () => 'admitted',
    data: (e) => ({ leases: Array.isArray(e.leases) ? e.leases : [] }),
    intents: () => [{ intent: 'clone', of: 'seed(base)' }],
  },
  // (none) | granted{leases} | admitted | clone(seed(base))
  //
  // A LANE IS BORN GRANTED. Every other machine has a `from: null` row; this table had none, so
  // no lane could ever exist: MEASURED 2026-09-29, a replay of the 7 days of stage8 lane events
  // (1,463) through this machine refused all 1,463, the first `granted` of each of 476 units and
  // then everything after it. stage8 decides admission before the unit exists (the claim and
  // `axis admit` run first), so its first event is `granted`, and the unit's `requested` moment
  // is that same decision. The row above stays for a caller that does emit `requested`.
  {
    from: null, type: 'granted',
    to: () => 'admitted',
    data: (e) => ({ leases: Array.isArray(e.leases) ? e.leases : [] }),
    intents: () => [{ intent: 'clone', of: 'seed(base)' }],
  },
  // (none) | exited{diff: empty} | closed(empty) | none
  //
  // A ROW THAT RAN NO LANE. stage8 records an outcome for a row it claimed and then did not
  // dispatch (`already-fixed`: its verdicts are already recorded, or its PRECONDITION-GREP no
  // longer matches) through the same `lane_axis_outcome` every lane ends in, so that unit's first
  // and only event is its exit. LEDGER.md L2 names it: closed(empty), cause never-started. An exit
  // with a diff is still refused from here: a diff needs a workspace, so a unit that shows one
  // first lost its grant (the "database is locked" writes in axis-lane-events.failed).
  {
    from: null, type: 'exited',
    guard: (e) => e.diff === 'empty' && (e.cause === '-' || e.cause === undefined || e.cause === null),
    to: () => 'closed(empty)',
    data: (e) => ({ cause: 'never-started', outcome: e.outcome }),
    intents: () => [],
  },
  // admitted | clone-failed | closed(empty) | release leases
  //
  // LEDGER.md L2: a lane that ends with no diff before it could start is `closed(empty)` with
  // cause `never-started`, charged to the pool's configuration, not the row or the model. A
  // workspace that could not be cut is exactly that (stage8 `lane_axis clone-failed`, 14 in the
  // 7 days replayed). Terminal, so L1 releases the leases below.
  {
    from: 'admitted', type: 'clone-failed',
    to: () => 'closed(empty)',
    data: (e) => ({ cause: 'never-started', outcome: e.outcome ?? 'clone-failed' }),
    intents: () => [],
  },
  // admitted | cloned{path} | workspace-ready | spawn(pool arm)
  {
    from: 'admitted', type: 'cloned',
    to: () => 'workspace-ready',
    data: (e) => ({ path: e.path }),
    intents: () => [{ intent: 'spawn', target: 'pool-arm' }],
  },
  // workspace-ready | spawned{pid, start_time, session} | running | none
  {
    from: 'workspace-ready', type: 'spawned',
    to: () => 'running',
    data: (e) => ({ pid: e.pid, start_time: e.start_time, session: e.session }),
    intents: () => [],
  },
  // running | exited{diff: non-empty} | produced | change.capture, release leases
  {
    from: 'running', type: 'exited',
    guard: (e) => e.diff === 'non-empty',
    to: () => 'produced',
    intents: () => [{ intent: 'change.capture' }],
  },
  // running | exited{diff: empty, cause: -} | closed(empty) | harvest(transcript), release leases
  {
    from: 'running', type: 'exited',
    guard: (e) => e.diff === 'empty' && (e.cause === '-' || e.cause === undefined || e.cause === null),
    to: () => 'closed(empty)',
    intents: () => [{ intent: 'harvest', of: 'transcript' }],
  },
  // running | exited{cause: quota | transient} | provider-fault | checkpoint
  {
    from: 'running', type: 'exited',
    guard: (e) => e.cause === 'quota' || e.cause === 'transient',
    to: () => 'provider-fault',
    data: (e) => ({ cause: e.cause }),
    intents: () => [{ intent: 'checkpoint' }],
  },
  // running | exited{cause: auth | funds | retired-model | login} | closed(provider) |
  //   hold(pool), release leases, row back to queued
  {
    from: 'running', type: 'exited',
    guard: (e) => ['auth', 'funds', 'retired-model', 'login'].includes(e.cause),
    to: () => 'closed(provider)',
    data: (e) => ({ cause: e.cause }),
    intents: () => [{ intent: 'hold', target: 'pool' }, { intent: 'row.requeue' }],
  },
  // running | deadline | checkpointed | checkpoint, kill_tree
  {
    from: 'running', type: 'deadline',
    to: () => 'checkpointed',
    intents: () => [{ intent: 'checkpoint' }, { intent: 'kill_tree' }],
  },
  // running | heartbeat stale, process gone | reconcile | readback(worktree, log)
  {
    from: 'running', type: 'heartbeat-check',
    guard: (e) => e.stale === true && e.processGone === true,
    to: () => 'reconcile',
    intents: () => [{ intent: 'readback', of: 'worktree+log' }],
  },
  // provider-fault | checkpointed{ref, session} | waiting-reset | timer(reset_at)
  {
    from: 'provider-fault', type: 'checkpointed',
    to: () => 'waiting-reset',
    data: (e) => ({ ref: e.ref, session: e.session }),
    intents: (e) => [{ intent: 'timer', at: e.reset_at }],
  },
  // waiting-reset | reset_at passed and scheduler grants | resumed | spawn(pool arm, --resume session)
  {
    from: 'waiting-reset', type: 'resume-check',
    guard: (e) => e.resetAtPassed === true && e.granted === true,
    to: () => 'resumed',
    intents: () => [{ intent: 'spawn', target: 'pool-arm', resume: true }],
  },
  // checkpointed | checkpointed{ref, session} | checkpointed | none
  //
  // `running --deadline--> checkpointed` names the checkpoint as an intent; stage8 then reports
  // the checkpoint it made (`lane_axis checkpointed ref=... cause=...`, stage8.sh) as its own
  // event, which found no row: 1 refusal in the 7-day replay (2026-09-29). The event records the
  // ref a resume needs and leaves the lane where the deadline put it. No lease is released twice:
  // L1 below fires on ENTERING a terminal state, and this row starts in one.
  {
    from: 'checkpointed', type: 'checkpointed',
    to: () => 'checkpointed',
    data: (e) => ({ ref: e.ref, session: e.session }),
    intents: () => [],
  },
  // resumed --spawned{pid, start_time, session}--> running
  //
  // Not a labelled LEDGER.md table row -- the diagram's `resumed -->
  // running` arrow, made concrete with the same `spawned` event the
  // workspace-ready row already uses for "a spawn completed" (see the
  // TERMINAL_STATES comment above). This is how P12's resumed session
  // actually goes back to doing work instead of sitting at rest forever.
  {
    from: 'resumed', type: 'spawned',
    to: () => 'running',
    data: (e) => ({ pid: e.pid, start_time: e.start_time, session: e.session }),
    intents: () => [],
  },
];

function tableReduce(state, event) {
  return reduceTable(state, event, TABLE);
}

export function reduce(state, event) {
  const result = tableReduce(state, event);
  if (result.refused) return result;

  // L1: a terminal transition releases every lease this lane holds, in the
  // same result -- not a separate call the caller might forget (LEDGER.md:
  // "Today release is a separate call in a separate script").
  if (TERMINAL_STATES.includes(result.next.status) && !TERMINAL_STATES.includes(state?.status)) {
    const leases = Array.isArray(result.next.leases) ? result.next.leases : [];
    const holder = state && typeof state === 'object' ? state.id : undefined;
    for (const lease of leases) {
      const releaseIntent = { intent: 'lease.release', lease, reason: 'lane-terminal' };
      if (holder !== undefined) releaseIntent.holder = holder;
      result.intents.push(releaseIntent);
    }
  }
  return result;
}

/** True only for a reason this machine's own vocabulary accepts. Exported
 * so tests (and, later, a real caller) can check a reason before releasing
 * instead of discovering the refusal after the fact. */
export function isValidReleaseReason(reason) {
  return releaseReasonVocabulary().has(reason);
}
