// axis-test-index.mjs — P04: the reverse test index. "Which tests does this
// changed file reach?" answered from what the suite cache already recorded,
// instead of walking the import graph forward from every test on every call.
//
// TEST-ENGINE.md change T2: `suite-result-cache.mjs` writes, for every test
// file that passed, a STATIC key (`closureKeys`, the test's own bytes plus
// its import closure plus its declared reads) and a TRACE (`traceOf`:
// exactly the other files it read, listed, executed or probed while it ran).
// Both together are the exact set of inputs that pass depended on. Walking
// every stored result once and inverting file -> test out of that union is
// the reverse index this module builds; T2's spec names the destination as
// `fp_input(kind='test', key, path)`, a table `axis-fingerprint.mjs` (P03)
// and its wiring (W1) do not exist yet. Until then this module reads the
// SAME facts directly out of the store the runner writes: the machine-wide
// test cache (machine-test-cache.mjs `entries()`, each one `{ file, trace,
// ... }`), which replaced the JSON `files/**/*.json` directory PACKETS.md P04
// first named. When P03/W1 land, `buildIndex` gains a
// second source and nothing about `testsFor`'s contract changes.
//
// EVERY TEST WITH NO STORED KEY FALLS BACK TO THE STATIC WALK. A test that
// has never passed under the runner has no trace to invert, so
// `tools/impact-tests.mjs` (`selectFrom`) is run over exactly that subset --
// the same safety net the runner itself uses, reused rather than
// reimplemented. `selectFrom`'s own uncertainty rule is inherited unchanged:
// an unresolved import over the untraced set falls back to `full: true`,
// never to a silently empty answer.
//
// A CHANGE TO A FULL_SUITE_TRIGGER (`impact-tests.mjs`) SHORT-CIRCUITS
// EVERYTHING ABOVE: `testsFor` returns `full: true` before touching the
// index, because a change to the runner itself invalidates the premise that
// yesterday's traces still describe today's run.
//
// A TREE-WIDE TRACE (`ls-files`, `check-ignore`, `status`, `grep`, or a
// recursive listing rooted at `.`) MAKES A TEST UNIVERSAL: hit by every
// non-empty change, not just the files it happens to name. MEASURED
// 2026-09-26 (`axis-cli-test-index-superset.mjs` against the live store,
// 157,273 entries): treating a `t` trace as unkeyable and dropping it --
// this module's first version -- undercounted `selectFrom`'s own ratchet
// tier by 55-73 tests on every one of ten real commits. A recorded tree-wide
// read is exact evidence the test's subject is the whole tree, which is
// exactly what `selectFrom`'s RATCHET_ARTIFACT/SCANS_TRACKED source-text
// heuristic is a proxy FOR.
//
// A TRACED TEST IS ANSWERED FROM ITS TRACE ALONE, NEVER RE-WALKED
// STATICALLY -- and that is ALLOWED to disagree with `selectFrom`.
// PACKETS.md's own proof is a superset "minus nothing that a stored trace
// reached": `selectFrom`'s RATCHET_ARTIFACT/literal-name/one-hop-data-file
// tiers are proxies for "might depend on anything", used because static
// analysis alone cannot know a test's real reach. A test with a stored key
// HAS a real, recorded reach, and when that reach does not include the
// changed file, omitting it is a MORE ACCURATE answer, not a gap. MEASURED
// 2026-09-26, second pass, same live store: with tree-wide traces now
// counted (above), every remaining test `selectFrom` picked up that this
// module's answer omitted, on all ten commits, already had a stored key
// (`index.testsSeen`; 1,808 of 1,811 real test files did) -- zero of the ten
// had an actual (untraced) violation, once the comparison was fixed to
// match PACKETS.md's own carve-out instead of a raw `selectFrom` diff
// (`axis-cli-test-index-superset.mjs`'s `measure()` reports both counts).
//
// On a repository whose suite cache is empty -- true of a fresh worktree --
// every test is untraced and the two walks agree exactly, trivially. What
// remains for W1 (P03's `fp_input` write, replacing this module's own
// directory walk) is precision, not correctness: a traced test could in
// principle carry a stale or partial trace if `suite-result-cache.mjs`'s own
// read-recording ever missed something it should have caught, but that
// would be a bug in the trace, not in this module's use of it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closureKeys, repoIndex, runnerSalt } from './suite-result-cache.mjs';
import { listTestFiles, EXCLUDED_TEST_DIRS } from './shard-planner.mjs';
import { forcesFullSuite, scansRepository, selectFrom } from '../../../tools/impact-tests.mjs';

/**
 * Everything one stored pass rests on: its static closure (`keyOf.inputsOf`)
 * and what its trace recorded. `files` are exact paths; `dirs` are listings
 * (`recursive` for a whole subtree); `universal` is a tree-wide read (`t`),
 * which every change reaches. `p` (probes) names no single file or directory
 * to key by: "did this path exist" is not "this test depends on that path's
 * content" outside the key it is already covered by.
 *
 * The one reading of an entry's inputs: this index inverts it, and
 * scripts/run-tests.mjs writes it to `fp_input` through `fpInputPaths`.
 */
function entryInputs(entry, keyOf) {
  const files = new Set();
  const dirs = [];
  let universal = false;
  let inputs = null;
  try { inputs = keyOf.inputsOf(entry.file); } catch { inputs = null; }
  if (inputs) for (const f of inputs.files) files.add(f);
  const trace = entry.trace;
  if (trace && typeof trace === 'object') {
    for (const row of Array.isArray(trace.r) ? trace.r : []) if (typeof row?.[0] === 'string') files.add(row[0]);
    for (const row of Array.isArray(trace.x) ? trace.x : []) if (typeof row?.[0] === 'string') files.add(row[0]);
    for (const row of Array.isArray(trace.l) ? trace.l : []) {
      const [dir, recursive] = row ?? [];
      if (typeof dir === 'string') dirs.push({ dir, recursive: recursive === 'r' || recursive === true });
    }
    for (const row of Array.isArray(trace.d) ? trace.d : []) {
      const dir = row?.[0];
      if (typeof dir === 'string') dirs.push({ dir, recursive: true });
    }
    universal = (Array.isArray(trace.t) ? trace.t : []).length > 0;
  }
  return { files, dirs, universal };
}

/**
 * `entryInputs` as the flat path list `fp_input` holds: a file as itself, a
 * listing as `<dir>/*` (or `<dir>/**` for a subtree), a tree-wide read as
 * `**`. Invalidation by path matches rows exactly, so a shared input found in
 * `fp_input` is always a string this function wrote.
 */
export function fpInputPaths(entry, keyOf) {
  const { files, dirs, universal } = entryInputs(entry, keyOf);
  const out = new Set(files);
  for (const { dir, recursive } of dirs) out.add(`${dir === '.' ? '' : `${dir}/`}${recursive ? '**' : '*'}`);
  if (universal) out.add('**');
  return [...out].sort();
}

/**
 * @param {object} args
 * @param {{machine: {entries: Function}}} args.store a suite-result-cache
 *   store behind `withMachineCache` (machine-test-cache-adapter.mjs), or
 *   anything exposing the same `machine.entries()`.
 * @param {string} args.root the repository root.
 * @param {string[]} [args.testFiles] the universe `testsFor`'s static
 *   fallback walks for a test with no stored key. Defaults to
 *   `listTestFiles(root)`, the real suite. A caller that already knows a
 *   narrower universe (a fixture, a measurement scoped to one shard) may
 *   pass it directly instead of paying `selectFrom`'s per-file cost over
 *   every test the real repository has -- this changes nothing about what
 *   the interface promises, only what "everything" means for that build.
 * @returns {object} an opaque index; pass it straight to `testsFor`.
 */
export function buildIndex({ store, root, testFiles: testFilesOverride } = {}) {
  if (!store || typeof store.machine?.entries !== 'function') {
    throw new Error('axis-test-index: buildIndex requires a store with machine results (machine-test-cache-adapter.mjs withMachineCache)');
  }
  if (typeof root !== 'string' || !root) {
    throw new Error('axis-test-index: buildIndex requires a repository root');
  }

  let repo;
  try {
    repo = repoIndex(root);
  } catch (err) {
    throw new Error(`axis-test-index: cannot read the repository tree at ${root}: ${err.message}`);
  }

  let testFiles;
  if (Array.isArray(testFilesOverride)) {
    testFiles = testFilesOverride;
  } else {
    try {
      testFiles = listTestFiles(root);
    } catch (err) {
      throw new Error(`axis-test-index: cannot enumerate test files: ${err.message}`);
    }
  }

  const salt = runnerSalt({ root, index: repo });
  const keyOf = closureKeys({ root, index: repo, salt });

  // path -> Set(test): a direct hit, either from the test's own static
  // closure (import edges, declared reads) or from a traced file read/exec.
  const filePaths = new Map();
  const addFile = (path, test) => {
    let s = filePaths.get(path);
    if (!s) { s = new Set(); filePaths.set(path, s); }
    s.add(test);
  };

  // { dir, recursive, test }: a traced listing or a traced exec-of-a-
  // directory. A changed path under `dir` (or exactly `dir`, when the test
  // listed the directory itself) is a hit. `dir === '.'` with `recursive`
  // true is the whole tree, and is matched by every non-empty change,
  // exactly like `universalTests` below.
  const watchedDirs = [];

  // A test whose trace carries a `t` entry (`traceOf`'s tree-wide kind:
  // `git ls-files`/`check-ignore` against the tree, or `git status`/`grep`)
  // has a REAL, RECORDED dependency on the whole tree, not a guess about
  // one. MEASURED 2026-09-26 against the live store (157,273 entries): the
  // first version of this module treated `t` as unkeyable and dropped it,
  // which is wrong, not merely conservative -- on 10 real master commits it
  // undercounted `tools/impact-tests.mjs`'s own ratchet/`ls-files` tier
  // (TIER.ratchet) by 55-73 tests on every one of them
  // (`axis-cli-test-index-superset.mjs`, run against the live store). A
  // tree-wide trace IS a per-file hit for every file, because the hash it
  // holds changes on every one of them.
  const universalTests = new Set();

  const testsSeen = new Set();
  let entriesRead = 0;
  let entriesUnreadable = 0;
  let storeReadable = true;

  const addEntry = (entry) => {
    const test = entry.file;
    testsSeen.add(test);
    const { files, dirs, universal } = entryInputs(entry, keyOf);
    for (const f of files) addFile(f, test);
    for (const d of dirs) watchedDirs.push({ ...d, test });
    if (universal) universalTests.add(test);
  };

  // THE STORED PASSES ARE THE MACHINE STORE'S (machine-test-cache.mjs), one
  // sqlite file every worktree shares, since the per-file JSON directory was
  // deleted (parallel-lanes `cache`). A store that cannot be read is not an
  // empty one: the index says so (storeReadable) and testsFor's static walk
  // still answers for every test.
  let stored = [];
  try {
    stored = store.machine.entries();
  } catch {
    storeReadable = false;
  }
  for (const entry of stored) {
    if (!entry || typeof entry.file !== 'string' || !entry.file) { entriesUnreadable += 1; continue; }
    entriesRead += 1;
    addEntry(entry);
  }

  const cache = new Map();
  const read = (p) => {
    if (cache.has(p)) return cache.get(p);
    let text = null;
    try { text = readFileSync(join(root, p), 'utf8'); } catch { text = null; }
    cache.set(p, text);
    return text;
  };
  const exists = (p) => repo.files.has(p);
  const excludedDirs = Object.keys(EXCLUDED_TEST_DIRS);

  // A TEST WHOSE SOURCE LISTS THE REPOSITORY IS UNIVERSAL WHETHER OR NOT IT
  // WAS TRACED. Its trace recorded the files and directories that existed the
  // day it passed; a change that ADDS a file under a subdirectory it never
  // listed reaches none of them, and that is exactly the change such a guard
  // exists to judge (every-store-schema-is-one-transaction after #1870, where
  // the red module was a new file). `scansRepository` is the same reading
  // `selectFrom` ranks as never-cut, so the two answers cannot disagree on it.
  for (const test of testFiles) {
    if (!universalTests.has(test) && scansRepository(read(test))) universalTests.add(test);
  }

  return {
    root,
    testFiles,
    testsSeen,
    filePaths,
    watchedDirs,
    universalTests,
    read,
    exists,
    excludedDirs,
    storeReadable,
    entriesRead,
    entriesUnreadable,
  };
}

/**
 * @param {object} index from `buildIndex`.
 * @param {string[]} paths changed, repo-relative paths.
 * @returns {{ tests: string[]|null, via: { traced: string[], static: string[] }, full: boolean }}
 *   `tests` is `null` exactly when `full` is true -- run everything. A test
 *   in `via.traced` may also be in `via.static`; `tests` is their union.
 */
export function testsFor(index, paths) {
  if (!index || !(index.filePaths instanceof Map)) throw new Error('axis-test-index: testsFor requires an index from buildIndex');
  const cleaned = [...new Set((paths ?? []).map((p) => String(p ?? '').trim()).filter(Boolean))];
  if (cleaned.length === 0) return { tests: [], via: { traced: [], static: [] }, full: false };
  if (forcesFullSuite(cleaned)) return { tests: null, via: { traced: [], static: [] }, full: true };

  // A test with a recorded tree-wide dependency (`t` in its trace: `git
  // ls-files`/`check-ignore`, `git status`/`grep`) is reached by every
  // non-empty change -- the hash it depends on changes on every one of
  // them. `cleaned` is already known non-empty at this point.
  const traced = new Set(index.universalTests);
  for (const p of cleaned) {
    for (const t of index.filePaths.get(p) ?? []) traced.add(t);
    for (const w of index.watchedDirs) {
      // `dir === '.'` recursive is a listing of the WHOLE tree: also a hit
      // for every path, the same as a `universalTests` entry.
      const hit = w.dir === '.' && w.recursive ? true
        : w.recursive ? (p === w.dir || p.startsWith(`${w.dir}/`))
        : dirname(p) === w.dir;
      if (hit) traced.add(w.test);
    }
  }

  const untracedTestFiles = index.testFiles.filter((t) => !index.testsSeen.has(t));
  const { selection, reason } = selectFrom(cleaned, {
    testFiles: untracedTestFiles,
    read: index.read,
    exists: index.exists,
    excludedDirs: index.excludedDirs,
    cap: Infinity,
  });
  // `selectFrom` with `cap: Infinity` never answers `over-cap`, and
  // `full-suite-trigger` is already handled above, so a `null` selection
  // here means one of two different things and they are NOT the same
  // answer. `unresolved` (an import it could not follow) is uncertainty:
  // widen to everything, same as `selectFrom`'s own rule. `nothing-reaches`
  // is a COMPLETED walk that found nothing in the untraced subset -- a
  // confident answer of zero, not a reason to give up. Collapsing the two
  // (MEASURED 2026-09-26, `axis-cli-test-index-superset.mjs`'s predecessor
  // against a narrow test-file universe: every `nothing-reaches` answer
  // silently became `full: true`) turns "no untraced test cares about this
  // file" into "run everything", which is wrong in the direction that costs
  // time, not the direction that costs correctness, but still not what this
  // reason means.
  if (selection === null && reason === 'unresolved') {
    return { tests: null, via: { traced: [...traced].sort(), static: [] }, full: true };
  }

  const staticSet = new Set(selection ?? []);
  // A changed file that is itself a test always runs, whatever the walks
  // found: `selectFrom` guarantees this for the untraced subset it was
  // given, and a changed test that already has a stored key is otherwise
  // reachable only through its own trace, which a test never traces itself
  // reading.
  for (const p of cleaned) {
    if (p.endsWith('.test.mjs') && index.exists(p) && index.testFiles.includes(p)) staticSet.add(p);
  }

  const tests = new Set([...traced, ...staticSet]);
  return {
    tests: [...tests].sort(),
    via: { traced: [...traced].sort(), static: [...staticSet].sort() },
    full: false,
  };
}
