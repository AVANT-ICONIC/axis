// AXIS P01 — the one ledger. See docs/axis/LEDGER.md (branch origin/docs/axis-spec) for the
// data model this implements: seven unit kinds, one append-only event table, CAS on the unit
// table, idempotency by `idem`, and the legacy/shadow/axis owner switch.
//
// Zero dependencies: node:sqlite (Node 22.5+, this machine runs v26) and other node builtins only.
//
// Reducers are injected (`openLedger(path, { reducers })`), so this module never imports P02's
// state machines and does not wait for them. A reducer is a plain function per unit kind:
//   reduce(current, event) -> { next: { state, data }, intents? } | { refused: true, why }
// `current` is `{ state, data, version }` for an existing unit or `null` for a brand-new one.
// `event` is `{ kind, unit, type, payload, at, actor, cause }`.
//
// MEASURED 2026-09-26 (this machine, fleet running, load elevated — see
// tests/axis-ledger-a-concurrent-write-never-loses-a-cas-update.test.mjs, which doubles as the
// LEDGER.md "measure first" item 1 write-latency probe): 8 worker threads each opening their own
// connection to one ledger file and emitting 300 events apiece (2,400 total, one shared unit,
// maximum contention) completed across three runs with p50 = 0.04-0.46ms and p99 = 3.9-4.9ms per
// `emit()` call; a rare outlier hit 165-514ms (worker-thread start-up / GC under this machine's
// fleet load, not lock contention — busy_timeout is 5000ms and was never hit). Zero SQLITE_BUSY
// escapes past the retry, zero lost CAS updates, seq 1..2400 gapless every run. LEDGER.md asks
// for "40 processes at load 300"; this machine could not be pushed to literal system load 300
// without contending with the fleet it was trying to measure honestly, so 8 concurrent writers is
// the deviation — recorded here rather than claimed as the real number. Re-measure before quoting.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { enableWal, withTransaction } from './db-transaction.mjs';

// Thrown from inside emit()'s withTransaction callback to signal "CAS lost the race, roll back
// and retry" without treating it as a real failure — never let this escape emit() itself.
class CasRetry extends Error {}

const REDUCER_VERSION_DEFAULT = 'unversioned';
const OWNER_MODES = new Set(['legacy', 'shadow', 'axis']);

// Every table LEDGER.md's "Storage" section lists, so later packets (P02..P18) build on this
// schema without a second migration. `event` carries two columns beyond the spec table —
// `refused` and `why` — because "an event the reducer refuses is stored as refused" (P01 Proof)
// needs somewhere to record that without mutating the meaning of `payload`, which callers read
// as exactly what they passed in.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS event (
  seq     INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  unit    TEXT NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor   TEXT NOT NULL,
  cause   INTEGER,
  idem    TEXT UNIQUE,
  reducer TEXT NOT NULL,
  refused INTEGER NOT NULL DEFAULT 0,
  why     TEXT
);
CREATE TABLE IF NOT EXISTS unit (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  state    TEXT NOT NULL,
  version  INTEGER NOT NULL,
  data     TEXT NOT NULL,
  updated  INTEGER NOT NULL,
  last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edge (
  src TEXT NOT NULL,
  rel TEXT NOT NULL,
  dst TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (src, rel, dst)
);
CREATE TABLE IF NOT EXISTS lease (
  id      TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  amount  REAL NOT NULL,
  holder  TEXT NOT NULL,
  class   TEXT NOT NULL,
  granted INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  state   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fp (
  kind  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  at    INTEGER NOT NULL,
  hits  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, key)
);
CREATE TABLE IF NOT EXISTS fp_input (
  kind TEXT NOT NULL,
  key  TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner (
  topic  TEXT PRIMARY KEY,
  mode   TEXT NOT NULL CHECK (mode IN ('legacy','shadow','axis')),
  set_by TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS divergence (
  seq    INTEGER PRIMARY KEY,
  topic  TEXT,
  legacy TEXT,
  axis   TEXT,
  at     INTEGER
);
CREATE INDEX IF NOT EXISTS unit_state ON unit(kind, state);
CREATE INDEX IF NOT EXISTS event_unit ON event(unit, seq);
CREATE INDEX IF NOT EXISTS fp_input_path ON fp_input(path);
CREATE INDEX IF NOT EXISTS fp_input_key ON fp_input(kind, key);
`;

/** `~/.apex-fleet/axis/axis.db` — outside ~/Desktop so a launchd job can open it (AGENTS.md). */
export function defaultDbPath() {
  return join(homedir(), '.apex-fleet', 'axis', 'axis.db');
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (err) {
    // A row this module itself wrote should always parse. If it doesn't, the database is
    // corrupt underneath us — raise, do not paper over it with `fallback`.
    if (fallback === undefined) {
      throw new Error(`axis-ledger: stored JSON did not parse: ${err.message}`);
    }
    return fallback;
  }
}

function toUnitRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    version: row.version,
    data: parseJson(row.data, {}),
    updated: row.updated,
    lastSeq: row.last_seq,
  };
}

function toEventRecord(row) {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    unit: row.unit,
    type: row.type,
    payload: parseJson(row.payload, {}),
    actor: row.actor,
    cause: row.cause,
    idem: row.idem,
    reducer: row.reducer,
    refused: !!row.refused,
    why: row.why,
  };
}

function toOwnerRecord(row) {
  if (!row) return null;
  return { topic: row.topic, mode: row.mode, setBy: row.set_by, at: row.at };
}

/**
 * openLedger(path, { reducers, busyTimeoutMs }) -> {
 *   emit(kind, unit, type, payload, { actor, idem, cause }),
 *   get(unit), why(unit), list({ kind, state }),
 *   owner(topic), setOwner(topic, mode, by),
 *   tx(fn), close(),
 * }
 *
 * `reducers` maps unit kind -> reduce(current, event) function. A kind with no registered
 * reducer raises on `emit` rather than silently accepting the event (a house failure this
 * ledger exists to stop: "an unreadable input raises, never returns empty" applies just as
 * much to a missing reducer as to a missing file).
 */
export function openLedger(path, { reducers = {}, busyTimeoutMs = 5000 } = {}) {
  if (!path) throw new Error('axis-ledger: openLedger requires a path');

  mkdirSync(dirname(path), { recursive: true });

  // A directory (or any non-database file) at `path` must raise here, not hang or return an
  // empty ledger. `new DatabaseSync` on a directory throws synchronously on this platform; we
  // still guard with statSync first so the error message names the actual problem.
  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      throw new Error(`axis-ledger: ${path} is a directory, not a database file`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let db;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw new Error(`axis-ledger: cannot open database at ${path}: ${err.message}`);
  }

  // busy_timeout FIRST. `journal_mode = WAL` takes a lock, and set before the
  // timeout it answers a concurrent opener "database is locked" at once instead
  // of waiting. MEASURED 2026-09-27: 16 processes opening one ledger at once
  // (stage8 workers taking file leases, axis-cli-lease.mjs), 3 of 48 died at
  // open with that error; with the timeout set first, none. Not closed, only
  // narrowed: enableWal (db-transaction.mjs) retries the switch itself.
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0};`);
  enableWal(db);
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = {
    getUnit: db.prepare('SELECT * FROM unit WHERE id = ?'),
    insertUnit: db.prepare(
      'INSERT INTO unit (id, kind, state, version, data, updated, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    updateUnit: db.prepare(
      'UPDATE unit SET state = ?, version = ?, data = ?, updated = ?, last_seq = ? WHERE id = ? AND version = ?'
    ),
    insertEvent: db.prepare(
      `INSERT INTO event (at, kind, unit, type, payload, actor, cause, idem, reducer, refused, why)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    eventByIdem: db.prepare('SELECT * FROM event WHERE idem = ?'),
    eventsForUnit: db.prepare('SELECT * FROM event WHERE unit = ? ORDER BY seq ASC'),
    lastEventAt: db.prepare('SELECT MAX(at) AS at FROM event WHERE kind = ? AND type = ? AND refused = 0'),
    ownerGet: db.prepare('SELECT * FROM owner WHERE topic = ?'),
    ownerUpsert: db.prepare(
      `INSERT INTO owner (topic, mode, set_by, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(topic) DO UPDATE SET mode = excluded.mode, set_by = excluded.set_by, at = excluded.at`
    ),
  };

  function get(unit) {
    if (!unit) throw new Error('axis-ledger: get requires a unit id');
    return toUnitRecord(q.getUnit.get(unit));
  }

  function why(unit) {
    if (!unit) throw new Error('axis-ledger: why requires a unit id');
    return q.eventsForUnit.all(unit).map(toEventRecord);
  }

  // When an event of this kind and type last happened (F-18: the last landing).
  // A refused event did not happen. None at all is null, never zero.
  function lastEventAt({ kind, type } = {}) {
    if (!kind || !type) throw new Error('axis-ledger: lastEventAt requires a kind and a type');
    const at = q.lastEventAt.get(kind, type)?.at;
    return Number.isFinite(at) ? at : null;
  }

  function list({ kind, state } = {}) {
    const clauses = [];
    const params = [];
    if (kind) {
      clauses.push('kind = ?');
      params.push(kind);
    }
    if (state) {
      clauses.push('state = ?');
      params.push(state);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM unit ${where} ORDER BY id ASC`).all(...params);
    return rows.map(toUnitRecord);
  }

  function owner(topic) {
    if (!topic) throw new Error('axis-ledger: owner requires a topic');
    return toOwnerRecord(q.ownerGet.get(topic));
  }

  function setOwner(topic, mode, by) {
    if (!topic) throw new Error('axis-ledger: setOwner requires a topic');
    if (!OWNER_MODES.has(mode)) {
      throw new Error(`axis-ledger: owner mode must be one of legacy|shadow|axis, got "${mode}"`);
    }
    if (!by) throw new Error('axis-ledger: setOwner requires "by" (who set it)');
    const at = Date.now();
    q.ownerUpsert.run(topic, mode, by, at);
    return { topic, mode, setBy: by, at };
  }

  function tx(fn) {
    if (typeof fn !== 'function') throw new Error('axis-ledger: tx requires a function');
    return withTransaction(db, () => fn({ get, why, list, owner, setOwner, db }));
  }

  const MAX_ATTEMPTS = 3;

  function emit(kind, unit, type, payload, { actor, idem, cause = null } = {}) {
    if (!kind) throw new Error('axis-ledger: emit requires a kind');
    if (!unit) throw new Error('axis-ledger: emit requires a unit id');
    if (!type) throw new Error('axis-ledger: emit requires a type');
    if (!actor) throw new Error('axis-ledger: emit requires an actor');

    const reducer = reducers[kind];
    if (typeof reducer !== 'function') {
      throw new Error(`axis-ledger: no reducer registered for kind "${kind}"`);
    }
    const reducerVersion = reducer.version || REDUCER_VERSION_DEFAULT;
    const payloadJson = JSON.stringify(payload ?? {});

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return withTransaction(db, () => {
          // Idempotency: a retried `axis emit` (bash callers retry blind) is a no-op. Checked
          // inside the transaction so a concurrent writer racing the same idem key can't slip
          // two rows past this check.
          if (idem) {
            const existing = q.eventByIdem.get(idem);
            if (existing) {
              return {
                seq: existing.seq,
                unit: existing.unit,
                idem,
                replay: true,
                refused: !!existing.refused,
                why: existing.why,
                intents: [],
              };
            }
          }

          const currentRow = q.getUnit.get(unit);
          const current = currentRow
            ? { state: currentRow.state, data: parseJson(currentRow.data, {}), version: currentRow.version }
            : null;
          const at = Date.now();
          const event = { kind, unit, type, payload: payload ?? {}, at, actor, cause };

          const result = reducer(current, event);

          if (result && result.refused) {
            const why_ = result.why || 'refused';
            const info = q.insertEvent.run(
              at, kind, unit, type, payloadJson, actor, cause, idem ?? null, reducerVersion, 1, why_
            );
            return { seq: Number(info.lastInsertRowid), unit, refused: true, why: why_, intents: [] };
          }

          if (!result || !result.next || typeof result.next.state !== 'string') {
            throw new Error(
              `axis-ledger: reducer for kind "${kind}" must return { next: { state, data } } or { refused, why }`
            );
          }

          const { next, intents = [] } = result;
          const nextData = JSON.stringify(next.data ?? {});
          const info = q.insertEvent.run(
            at, kind, unit, type, payloadJson, actor, cause, idem ?? null, reducerVersion, 0, null
          );
          const seq = Number(info.lastInsertRowid);
          const newVersion = (currentRow ? currentRow.version : 0) + 1;

          let applied;
          if (currentRow) {
            const r = q.updateUnit.run(next.state, newVersion, nextData, at, seq, unit, currentRow.version);
            applied = r.changes === 1;
          } else {
            try {
              q.insertUnit.run(unit, kind, next.state, newVersion, nextData, at, seq);
              applied = true;
            } catch (err) {
              // Another writer created this unit between our read and our insert (UNIQUE
              // violation on the primary key) — a CAS loss on the "current === null" edge. Treat
              // it exactly like a version mismatch: roll back and retry against the fresh row.
              applied = false;
            }
          }

          if (!applied) {
            // Roll back the whole transaction (including the event row inserted above) and
            // retry against the now-current row.
            throw new CasRetry();
          }

          return { seq, unit, state: next.state, version: newVersion, intents };
        });
      } catch (err) {
        if (err instanceof CasRetry) continue;
        throw err;
      }
    }

    const err = new Error(
      `axis-ledger: CAS conflict on unit "${unit}" after ${MAX_ATTEMPTS} attempts`
    );
    err.code = 'EXIT_3';
    throw err;
  }

  function close() {
    db.close();
  }

  // A READ OUTSIDE A TRANSACTION. tx() is BEGIN IMMEDIATE, a write lock, and a scan under it holds
  // every other writer out. MEASURED 2026-09-29: 14 stage8 lane events were lost to "database is
  // locked" (busy_timeout 5 s) in three days, and the fp_input prune was a writer that held the
  // lock for seconds: a GROUP BY over 6.2M rows and up to 2,000 keys' deletes (~480k rows) in one
  // immediate transaction. A read here sees one WAL snapshot per statement and blocks nobody.
  function read(fn) {
    if (typeof fn !== 'function') throw new Error('axis-ledger: read requires a function');
    return fn({ db });
  }

  // How big the file is and how much of it is free pages (SQLite never shrinks a file by itself).
  function fileStats() {
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const autoVacuum = db.prepare('PRAGMA auto_vacuum').get().auto_vacuum;
    return { path, pageSize, pages, freePages: free, bytes: pages * pageSize, freeBytes: free * pageSize, autoVacuum };
  }

  // THE ONE-TIME COMPACTION. MEASURED 2026-09-29 on a copy (VACUUM INTO, read-only on the live
  // file): 3.41 GB became 1.65 GB in 19.5 s; 1.64 GB of the file was free pages left by the
  // fp_input prune. The same VACUUM switches the file to incremental auto-vacuum, which a plain
  // `PRAGMA auto_vacuum` cannot do to a file that has tables, so every later prune can hand its
  // freed pages back in small steps (incrementalVacuum) instead of ever needing this again. It
  // holds the write lock for the whole copy: writers wait up to `busyTimeoutMs` and then fail
  // into their own .failed logs, so it runs only when someone asks (axis ledger-retention
  // --compact), never on a timer.
  function compact() {
    const before = fileStats();
    db.exec(`PRAGMA busy_timeout = ${Math.max(Number(busyTimeoutMs) | 0, 60_000)};`);
    try {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
      db.exec('VACUUM;');
    } finally {
      db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0};`);
    }
    return { before, after: fileStats() };
  }

  // Hands up to `pages` free pages back to the file system; a no-op (0) until compact() has made
  // the file incremental. Bounded so it never holds the write lock long.
  function incrementalVacuum(pages = 4096) {
    const { autoVacuum, freePages } = fileStats();
    if (autoVacuum !== 2 || freePages === 0) return 0;
    const n = Math.min(Math.max(1, Number(pages) | 0), freePages);
    db.exec(`PRAGMA incremental_vacuum(${n});`);
    return n;
  }

  return { path, emit, get, why, list, lastEventAt, owner, setOwner, tx, read, fileStats, compact, incrementalVacuum, close };
}

// THE START TIME IS WHEN THIS PROCESS STARTED, AS AN EPOCH. It was
// `process.hrtime()` in milliseconds: monotonic time since an arbitrary origin
// (boot, on this Mac), which no `ps` can print and which changed on every call.
// So no holder this ledger recorded could ever be matched to a live process,
// and F-02 had nothing to check a lease against (axis-readings.mjs
// readProcessTable matches it to `ps -o lstart=`). Computed once, so every
// actor id one process writes names the same process.
const PROCESS_STARTED_MS = String(Math.round(Date.now() - process.uptime() * 1000));

/** `role:pid:start_time:host` — the identity triple `singleton.sh` already checks (LEDGER.md). */
export function actorId({ role, pid = process.pid, startTime, host = 'localhost' } = {}) {
  if (!role) throw new Error('axis-ledger: actorId requires a role');
  const st = startTime ?? PROCESS_STARTED_MS;
  return `${role}:${pid}:${st}:${host}`;
}

/**
 * A permissive placeholder reducer registry so P01's CLI and tests work standalone before
 * P02's state machines exist ("Reducers are injected, so P01 does not wait for P02" —
 * PACKETS.md). It never refuses and just folds the payload into `data`, with `state = type`.
 * Since W10 (2026-09-30) the production writers open the ledger with `axis-machines.mjs`
 * `machineReducers(permissiveReducers())`: the seven machines decide their kinds and this
 * placeholder folds only the kinds no machine knows (detector runs, verdicts, ingest
 * observations). Nothing in this file depends on the shape beyond the reducer contract.
 */
export function permissiveReducer(current, event) {
  return {
    next: {
      state: event.type,
      data: { ...(current?.data ?? {}), ...(event.payload ?? {}) },
    },
    intents: [],
  };
}
permissiveReducer.version = 'axis-ledger-permissive-placeholder-v1';

/** A Proxy that hands back `permissiveReducer` for any kind never explicitly registered. */
export function permissiveReducers(overrides = {}) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Never answer well-known property probes (`.then`, `.constructor`, ...) with a
      // reducer function — doing so for `then` makes any code that `await`s this proxy treat
      // it as a thenable and hang forever (`{}.then` must stay `undefined`).
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor' || prop === 'toJSON') {
        return undefined;
      }
      return permissiveReducer;
    },
    has() {
      return true;
    },
  });
}
