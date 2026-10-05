// AXIS primitive (b), one content-fingerprint cache (docs/axis/PRIMITIVES.md "(b) One
// content-fingerprint cache", docs/axis/PACKETS.md "P03 Fingerprint primitive and
// contradiction replay").
//
// Six kinds share one contract: test, tree-verify, graft-index, model-answer,
// patch-class, clone-seed. `test` delegates its value storage to the existing
// `suite-result-cache.mjs` store (986 lines, already load-bearing) instead of
// building a second one; the rest use the `fp`/`fp_input` tables P01 owns
// (LEDGER.md). The store is an injected dependency: `createLedgerFpStore(ledger)`
// over an `openLedger()` handle is the real one (W1 wires it into
// scripts/run-tests.mjs), and `createMemoryFpStore()` is the in-memory stand-in
// for tests.
//
// Two rules apply to every kind, carried over from the test cache
// (PRIMITIVES.md "(b)"): only a successful result is ever stored (the caller
// decides success -- this module has no "storeFailure" path so there is
// nothing to call it with), and a READ ERROR THROWS. It never returns null,
// because a null read that is actually a broken store would silently
// recompute into a different answer next time (`tools/verdict-honesty.mjs`'s
// rule: a failed read must not become a verdict).

import { createHash } from 'node:crypto';

const TEST_KIND = 'test';

/**
 * sha256 over a canonical encoding of `parts`. Each part is either a plain
 * string, or `{ path, blob }` for a file input (blob is its content hash or
 * any stable identifier -- axis-fingerprint never reads the file itself).
 * The kind is folded into the hash so the same parts under two kinds never
 * collide.
 */
export function key(kind, parts) {
  if (typeof kind !== 'string' || !kind) {
    throw new TypeError(`key(): kind must be a non-empty string, got ${JSON.stringify(kind)}`);
  }
  if (!Array.isArray(parts)) {
    throw new TypeError('key(): parts must be an array of strings or {path, blob}');
  }
  const h = createHash('sha256');
  h.update('kind:');
  h.update(kind);
  h.update('\u0000');
  for (const part of parts) {
    if (typeof part === 'string') {
      h.update('s:');
      h.update(part);
      h.update('\u0000');
      continue;
    }
    if (part && typeof part === 'object' && typeof part.path === 'string') {
      h.update('f:');
      h.update(part.path);
      h.update(':');
      h.update(String(part.blob ?? ''));
      h.update('\u0000');
      continue;
    }
    throw new TypeError(`key(): part must be a string or {path, blob}, got ${JSON.stringify(part)}`);
  }
  return h.digest('hex');
}

function readError(kind, k, cause) {
  const err = new Error(`axis-fingerprint: read error for ${kind}:${k}: ${cause.message}`);
  err.cause = cause;
  err.kind = kind;
  err.fpKey = k;
  return err;
}

/**
 * The in-memory stand-in for the `fp` / `fp_input` tables (LEDGER.md), used
 * until P01 lands and for tests. Shape matches what a ledger-backed store
 * will need to provide: getFp/putFp/invalidateFp for values, putInput /
 * keysForPath for the reverse index that `invalidate(kind, { path })` walks.
 */
export function createMemoryFpStore() {
  const rows = new Map(); // `${kind}\u0000${key}` -> { value, at }
  const byPath = new Map(); // path -> Set of `${kind}\u0000${key}`
  const rowId = (kind, k) => `${kind}\u0000${k}`;

  return {
    getFp(kind, k) {
      const row = rows.get(rowId(kind, k));
      return row ? { value: row.value, at: row.at } : null;
    },
    putFp(kind, k, value, at) {
      rows.set(rowId(kind, k), { value, at });
    },
    invalidateFp(kind, k) {
      const had = rows.delete(rowId(kind, k));
      return had;
    },
    putInput(kind, k, path) {
      let set = byPath.get(path);
      if (!set) {
        set = new Set();
        byPath.set(path, set);
      }
      set.add(rowId(kind, k));
    },
    putInputs(kind, entries) {
      for (const { key: k, paths } of entries) for (const path of paths) this.putInput(kind, k, path);
    },
    keysForPath(path) {
      const set = byPath.get(path);
      if (!set) return [];
      return [...set].map((id) => {
        const i = id.indexOf('\u0000');
        return { kind: id.slice(0, i), key: id.slice(i + 1) };
      });
    },
    inputsForKey(kind, k) {
      const id = rowId(kind, k);
      return [...byPath].filter(([, set]) => set.has(id)).map(([path]) => path).sort();
    },
    pruneOlder(kind, before) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (!id.startsWith(`${kind}\u0000`) || row.at >= before) continue;
        rows.delete(id);
        for (const set of byPath.values()) set.delete(id);
        removed += 1;
      }
      return removed;
    },
  };
}

// THE fp_input BUDGET (AXIS primitive (g), retention, for the one table that grows).
//
// MEASURED 2026-09-29 23:40 CEST, ~/.apex-fleet/axis/axis.db: fp_input held 6.24M rows for 25,908
// `test` keys (~240 paths a key), 1.75 GB of the 3.41 GB file (table 0.80, key index 0.57, path
// index 0.39; ~281 bytes a row); the other 1.64 GB were free pages. Since W1 began writing it
// (2026-09-26 17:26) the rowid reached 29.65M: about 9.1M rows written a day, 23.4M already
// pruned. 4.96M of the live rows belonged to a pass the machine test store still held (its own
// bounds: 24 h TTL, 512 MB), 1.28M to passes it had already dropped. The only thing between that
// and the disk was `pruneInputs` on a 5% dice roll: 2,000 keys at most, a full GROUP BY and ~480k
// deletes inside one write transaction, and a `keep` that touched every pass's LRU stamp.
//
// So: a row budget above the measured live peak, enforced on a clock rather than a dice roll,
// orphans first, in short transactions. Over budget, the oldest keys go, each pass dropped BEFORE
// its inputs, because a pass whose inputs are gone is one the key-gap escalation can no longer
// find and drop (a stale reuse); a pass that cannot be dropped keeps its inputs.
export const FP_INPUT_ROW_BUDGET = 6_000_000;
// How often a suite run may take the turn (the run that does pays a few seconds).
export const FP_RETENTION_EVERY_MS = 30 * 60 * 1000;
const RETENTION_KIND = 'retention';

/**
 * The `fp` / `fp_input` tables of an `openLedger()` handle (axis-ledger.mjs,
 * P01), behind the same interface as `createMemoryFpStore`. Every statement
 * runs through `ledger.tx`, so a batch is one transaction.
 *
 * A key is content-addressed: the same key always has the same inputs. So
 * `putInputs` writes a key's rows once and skips a key that already has any,
 * which is what keeps a suite that records the same pass twice from doubling
 * the reverse index.
 */
export function createLedgerFpStore(ledger) {
  if (!ledger || typeof ledger.tx !== 'function') {
    throw new TypeError('createLedgerFpStore(ledger): an openLedger() handle is required');
  }
  const tx = (fn) => ledger.tx(({ db }) => fn(db));
  return {
    getFp(kind, k) {
      return tx((db) => {
        const row = db.prepare('SELECT value, at FROM fp WHERE kind = ? AND key = ?').get(kind, k);
        return row ? { value: JSON.parse(row.value), at: row.at } : null;
      });
    },
    putFp(kind, k, value, at) {
      tx((db) => db.prepare('INSERT OR REPLACE INTO fp (kind, key, value, at) VALUES (?, ?, ?, ?)')
        .run(kind, k, JSON.stringify(value ?? null), at));
    },
    invalidateFp(kind, k) {
      return tx((db) => {
        db.prepare('DELETE FROM fp_input WHERE kind = ? AND key = ?').run(kind, k);
        return db.prepare('DELETE FROM fp WHERE kind = ? AND key = ?').run(kind, k).changes > 0;
      });
    },
    putInput(kind, k, path) {
      this.putInputs(kind, [{ key: k, paths: [path] }]);
    },
    putInputs(kind, entries) {
      let written = 0;
      tx((db) => {
        const has = db.prepare('SELECT 1 FROM fp_input WHERE kind = ? AND key = ? LIMIT 1');
        const insert = db.prepare('INSERT INTO fp_input (kind, key, path) VALUES (?, ?, ?)');
        for (const { key: k, paths } of entries) {
          if (has.get(kind, k)) continue;
          for (const path of new Set(paths)) { insert.run(kind, k, path); written += 1; }
        }
      });
      return written;
    },
    keysForPath(path) {
      return tx((db) => db.prepare('SELECT DISTINCT kind, key FROM fp_input WHERE path = ?').all(path)
        .map((row) => ({ kind: row.kind, key: row.key })));
    },
    inputsForKey(kind, k) {
      return tx((db) => db.prepare('SELECT DISTINCT path FROM fp_input WHERE kind = ? AND key = ? ORDER BY path')
        .all(kind, k).map((row) => row.path));
    },
    // One caller per FP_RETENTION_EVERY_MS machine-wide, remembered in the ledger itself (an `fp`
    // row of kind `retention`). Two runs that race both run: the work is idempotent.
    claimRetentionTurn(kind, { now = Date.now(), everyMs = FP_RETENTION_EVERY_MS } = {}) {
      // Read and stamp in one write transaction, so two suites finishing together never both win.
      return tx((db) => {
        const last = db.prepare('SELECT at FROM fp WHERE kind = ? AND key = ?').get(RETENTION_KIND, kind);
        if (last && Number.isFinite(last.at) && now - last.at < everyMs) return false;
        db.prepare('INSERT OR REPLACE INTO fp (kind, key, value, at) VALUES (?, ?, ?, ?)')
          .run(RETENTION_KIND, kind, JSON.stringify({ by: process.pid }), now);
        return true;
      });
    },
    // The budget, enforced. `holds(key)` says a pass still rests on the key's inputs (a throw
    // reads as held: an unreadable answer never deletes); `drop(key)` removes that pass everywhere
    // (a throw stops the eviction). `dryRun` counts and writes nothing. At most `maxDeleteRows` rows go per call, in transactions of
    // `batchKeys` keys, so one call never holds the write lock for long; the next call continues.
    enforceInputBudget(kind, {
      holds, drop, maxRows = FP_INPUT_ROW_BUDGET, batchKeys = 25, maxDeleteRows = 250_000, vacuumPages = 4096, dryRun = false,
    } = {}) {
      if (typeof holds !== 'function') throw new TypeError('enforceInputBudget: holds(key) is required');
      const keys = ledger.read(({ db }) => db.prepare(
        'SELECT key, MIN(rowid) AS first, COUNT(*) AS n FROM fp_input WHERE kind = ? GROUP BY key ORDER BY first',
      ).all(kind));
      const report = { keys: keys.length, rows: keys.reduce((a, k) => a + k.n, 0), orphanKeys: 0, orphanRows: 0, holdsUnreadable: 0, evictedKeys: 0, evictedRows: 0, stopped: null };
      let budget = maxDeleteRows;
      const del = (batch) => dryRun || tx((db) => {
        const stmt = db.prepare('DELETE FROM fp_input WHERE kind = ? AND key = ?');
        for (const k of batch) stmt.run(kind, k.key);
      });
      // A holds() that throws is neither held nor orphaned: keep the rows (deleting on
      // a failed reading is the unsafe side) and count it, so the failure is visible.
      const isHeld = (k) => {
        try {
          return holds(k) !== false;
        } catch {
          report.holdsUnreadable += 1;
          return true;
        }
      };
      const held = [];
      let batch = [];
      for (const k of keys) {
        if (isHeld(k.key)) { held.push(k); continue; }
        if (budget - k.n < 0 && report.orphanKeys > 0) { report.stopped = 'delete-cap'; break; }
        batch.push(k);
        budget -= k.n;
        report.orphanKeys += 1;
        report.orphanRows += k.n;
        if (batch.length >= batchKeys) { del(batch); batch = []; }
      }
      if (batch.length) del(batch);
      // Orphans the delete cap left for the next call still occupy rows, so they count as live.
      let live = report.rows - report.orphanRows;
      // Over budget: evict down to 90% of it, oldest first, so the next run is not at the edge.
      if (live > maxRows && !report.stopped) {
        if (typeof drop !== 'function' && !dryRun) {
          report.stopped = 'over-budget-without-drop';
        } else {
          const floor = Math.floor(maxRows * 0.9);
          batch = [];
          for (const k of held) {
            if (live <= floor) break;
            if (budget - k.n < 0 && report.evictedKeys > 0) { report.stopped = 'delete-cap'; break; }
            if (!dryRun) { try { drop(k.key); } catch { report.stopped = 'drop-failed'; break; } }
            batch.push(k);
            budget -= k.n;
            live -= k.n;
            report.evictedKeys += 1;
            report.evictedRows += k.n;
            if (batch.length >= batchKeys) { del(batch); batch = []; }
          }
          if (batch.length) del(batch);
        }
      }
      report.rowsAfter = live;
      report.vacuumedPages = !dryRun && typeof ledger.incrementalVacuum === 'function' ? ledger.incrementalVacuum(vacuumPages) : 0;
      return report;
    },
    // Rows of `kind` written before `before` (epoch ms), with their inputs: a
    // kind whose value expires on a clock (`tree-verify`, suite-result-cache.mjs
    // TREE_TTL_MS) is never read past it, so keeping the row buys nothing.
    pruneOlder(kind, before) {
      return tx((db) => {
        db.prepare('DELETE FROM fp_input WHERE kind = ? AND key IN (SELECT key FROM fp WHERE kind = ? AND at < ?)').run(kind, kind, before);
        return db.prepare('DELETE FROM fp WHERE kind = ? AND at < ?').run(kind, before).changes;
      });
    },
  };
}

/**
 * `createFingerprint({ store, testStore })` -> `{ key, get, put, invalidate }`.
 *
 * `store` is the fp/fp_input-shaped store (see createMemoryFpStore above),
 * used for every kind except `test`, and for the `test` kind's input->key
 * reverse index regardless (suite-result-cache has no reverse index of its
 * own, so path-based invalidation for `test` is tracked here).
 *
 * `testStore` is the suite-result-cache.mjs store behind the machine test
 * cache (`withMachineCache(openStore())`, machine-test-cache-adapter.mjs),
 * used for `test` kind's value storage when supplied. A `test` value is
 * stored only with a `trace` whose inputs are digests. Omitting it makes `test` behave
 * like any other kind against `store` -- useful for tests, and for callers
 * that have not wired the real cache in yet.
 */
export function createFingerprint({ store = createMemoryFpStore(), testStore = null, now = () => Date.now() } = {}) {
  function get(kind, k) {
    if (kind === TEST_KIND && testStore) {
      let entry;
      try {
        entry = testStore.getFile(k);
      } catch (err) {
        throw readError(kind, k, err);
      }
      if (!entry) return null;
      // suite-result-cache's entries carry whatever the caller put in `value`
      // and a top-level `at`; axis-fingerprint's contract is { value, at }.
      const { at, ...rest } = entry;
      const value = 'value' in rest ? rest.value : rest;
      return { value, at };
    }
    let row;
    try {
      row = store.getFp(kind, k);
    } catch (err) {
      throw readError(kind, k, err);
    }
    return row;
  }

  function put(kind, k, value, inputs = []) {
    const at = now();
    if (kind === TEST_KIND && testStore) {
      // The machine test cache (machine-test-cache-adapter.mjs) keeps a pass
      // only against the digests in its trace, and says so rather than
      // throwing. A put that was not stored must not read as one that was.
      const r = testStore.putFile(k, value?.trace ? { value, trace: value.trace } : { value });
      if (r?.stored === false) throw new Error(`axis-fingerprint: test result for ${k} not stored: ${r.reason}`);
    } else {
      store.putFp(kind, k, value, at);
    }
    // One batch, not one call per path: the ledger store writes a key's inputs
    // once and skips a key that already has any, so a per-path loop kept only
    // the first input of a multi-input put.
    const paths = inputs.map((input) => (typeof input === 'string' ? input : input?.path)).filter(Boolean);
    if (paths.length) store.putInputs(kind, [{ key: k, paths }]);
    return { at };
  }

  // Scoped only: by key, or by input path. There is no "invalidate everything":
  // T1 (TEST-ENGINE.md) removed the test cache's `invalidateAll`, and no other
  // kind ever had a blanket invalidate to begin with.
  function invalidate(kind, where) {
    if (!where || (where.key === undefined && where.path === undefined)) {
      throw new TypeError('invalidate(kind, where): where must be { key } or { path }');
    }
    if (where.key !== undefined && where.path !== undefined) {
      throw new TypeError('invalidate(kind, where): pass { key } or { path }, not both');
    }
    if (where.key !== undefined) {
      let removed = false;
      if (kind === TEST_KIND && testStore) {
        removed = invalidateTestFile(testStore, where.key);
      } else {
        removed = store.invalidateFp(kind, where.key);
      }
      return { count: removed ? 1 : 0 };
    }
    const rows = store.keysForPath ? store.keysForPath(where.path) : [];
    let count = 0;
    for (const row of rows) {
      if (row.kind !== kind) continue;
      let removed;
      if (kind === TEST_KIND && testStore) {
        removed = invalidateTestFile(testStore, row.key);
      } else {
        removed = store.invalidateFp(kind, row.key);
      }
      if (removed) count += 1;
    }
    return { count };
  }

  return { key, get, put, invalidate };
}

// The test store owns its own layout, so it owns deleting one entry too
// (`invalidateFile`, added by W1 in place of `invalidateAll`; the machine
// test cache's since the parallel-lanes `cache` step). A store without it has
// nothing this module may delete.
function invalidateTestFile(testStore, k) {
  if (typeof testStore?.invalidateFile !== 'function' || typeof k !== 'string' || !k) return false;
  return testStore.invalidateFile(k);
}
