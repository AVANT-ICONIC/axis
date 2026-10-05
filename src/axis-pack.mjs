/* AXIS P05 -- packing (TEST-ENGINE.md "Change T3: exact blame and packing", 2026-09-26).
 *
 * A pack is a batch of eligible changes the merge queue verifies with ONE run. Two changes
 * may share a pack only if the tests they touch are disjoint (SHARED_TEST_LIMIT = 0, the value
 * TEST-ENGINE.md starts at): "With SHARED_TEST_LIMIT = 0, every failure in a pack is blamed
 * exactly, so a red pack never costs a bisect." Raising the limit trades exact blame for denser
 * packs; this module keeps the constant so axis-queue.mjs's blame() can rely on the invariant.
 *
 * Pure function: `testsFor` is injected (per PACKETS.md P05 "takes testsFor as a parameter"), so
 * this module never reads the fingerprint store, the reverse test index, or the filesystem.
 *
 * A UNIVERSAL TEST IS NOT A SHARED ONE. The reverse index (P04, `axis-test-index.mjs`) marks a
 * test universal when its recorded trace reads the whole tree (`ls-files`, `status`, a recursive
 * listing of `.`): every non-empty change reaches it. MEASURED 2026-09-27 on the live suite cache
 * (108,347 stored results): 491 of 1,985 tests are universal, so any two changes share at least
 * 491 tests, and with the limit at 0 every pack held exactly one change. The planner could never
 * batch, which is W4's whole premise ("N PRs per run, split on red"). A universal test cannot
 * tell two changes apart whether they share a pack or not, so the caller may name them in
 * `universal` and they are left out of the overlap count. They stay in each entry's `tests`,
 * so axis-queue.mjs's blame() sees a failing universal test with every change in the pack as
 * its owner and bisects over them: the split on red. Exact blame still holds for every other
 * test. Omitted, `universal` is empty and packing is exactly what it was.
 */

export const SHARED_TEST_LIMIT = 0;

/**
 * @param {Array<{id: string|number, files?: string[]}>} changes  eligible changes, priority order
 * @param {number} K            max pack size (TEST-ENGINE.md's `adaptiveBatchSize()`)
 * @param {(files: string[]) => Iterable<string>} testsFor  the reverse test index (P04), injected
 * @param {{ universal?: Iterable<string> }} [options]  tests every change reaches, not counted as shared
 * @returns {Array<Array<{id: string|number, files: string[], tests: Set<string>}>>}
 *   packs, in the same relative order as `changes`. Each entry in a pack carries `tests`, the
 *   Set axis-queue.mjs's blame() reads to compute owners(t).
 */
export function pack(changes, K, testsFor, { universal = [] } = {}) {
  if (!Array.isArray(changes)) {
    throw new TypeError('pack: changes must be an array');
  }
  if (!Number.isInteger(K) || K < 1) {
    throw new TypeError('pack: K must be a positive integer');
  }
  if (typeof testsFor !== 'function') {
    throw new TypeError('pack: testsFor must be a function (files) => tests');
  }

  if (universal == null || typeof universal[Symbol.iterator] !== 'function') {
    throw new TypeError('pack: options.universal must be an array, Set, or other iterable of test names');
  }
  const everyone = new Set(universal);
  const entries = changes.map((change, index) => {
    if (change == null || (typeof change.id !== 'string' && typeof change.id !== 'number')) {
      throw new TypeError(`pack: changes[${index}] must have a string or number "id"`);
    }
    const files = Array.isArray(change.files) ? change.files : [];
    const tests = toTestSet(testsFor(files), index);
    return { ...change, files, tests };
  });

  /** @type {Array<Array<typeof entries[number]>>} */
  const packs = [];
  let cur = [];

  for (const entry of entries) {
    const sharedWithCur = cur.length === 0
      ? 0
      : Math.max(...cur.map((d) => intersectionSize(entry.tests, d.tests, everyone)));

    if (cur.length < K && sharedWithCur <= SHARED_TEST_LIMIT) {
      cur.push(entry);
    } else {
      packs.push(cur);
      cur = [entry];
    }
  }
  if (cur.length > 0) {
    packs.push(cur);
  }
  return packs;
}

function toTestSet(tests, index) {
  if (tests instanceof Set) {
    return tests;
  }
  if (Array.isArray(tests)) {
    return new Set(tests);
  }
  if (tests != null && typeof tests[Symbol.iterator] === 'function') {
    return new Set(tests);
  }
  throw new TypeError(
    `pack: testsFor(changes[${index}].files) must return an array, Set, or other iterable of test names`,
  );
}

function intersectionSize(a, b, except) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const item of small) {
    if (large.has(item) && !except.has(item)) n++;
  }
  return n;
}
