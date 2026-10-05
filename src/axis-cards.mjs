// axis-cards.mjs — primitive (e), the card model and gallery store.
//
// WHY THIS EXISTS. HARVEST.md: "hundreds of dropped features must never
// vanish -- every drop becomes a card he can see and revive." Today a
// retiring verdict in docs/dropped-work is free text nothing indexes
// (readVerdicts only ever asked "is this decided", never "what was it"),
// a failed lane's partial work is reclaimed with its worktree, and an
// operator idea is capped at 5 pending cards on a surface that was never
// meant to hold the whole backlog. This module is the one card ledger all
// three sources write into.
//
// ZERO DEPENDENCIES. Node built-ins only. Flat file store (a single JSON
// document, atomic rename on write) under a caller-supplied path -- tests
// always pass a temp path; nothing here defaults to a path under
// ~/Desktop or a live queue.
//
// The ledger (P01) is a parallel packet. It is injected, never imported:
// `{ emit(kind, unit, type, payload, opts) }` or null. Every call site
// here treats a missing ledger as "record nothing, proceed".
//
// Since 2026-09-26 the retiring verdicts come from the AXIS verdict ledger
// (axis-verdicts.mjs verdictUnits), passed in as `sources.verdicts`: a
// verdict is a ledger row, and docs/dropped-work is read only by its import.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { diffTreeStdin, resolveCommits } from './git-batch.mjs';

/** Where the card store lives when nobody overrides it. `APEX_FLEET_HOME`
 *  is the env var every other axis-fleet module already reads (bob-doctor-
 *  status.mjs, emergency.mjs). Never used by ingest/list/revive directly --
 *  only the CLI and the route file, which are the layers allowed to touch
 *  real state, default to it. */
export function defaultStorePath(env = process.env) {
  return join(env.APEX_FLEET_HOME || join(env.HOME || homedir(), '.apex-fleet'), 'axis', 'cards.json');
}

/** The live fleet queue is Apex's, not the card store's: liveQueuePath in
 *  fleet-ops-dir.mjs resolves it, and only the CLI's `--live` flag or the
 *  mounted route may point revive() at it -- see the hard rule in revive()'s
 *  own doc comment. */

/** Verdicts HARVEST.md calls "retiring": the patch is not landing as it
 *  stood, and what happens to it is "not now", never "gone". LANDED-IN is
 *  excluded on purpose -- a landed patch is not dropped. */
const RETIRING_VERDICT = new Set(['SUPERSEDED-BY', 'DROP']);

function readError(path, cause) {
  const err = new Error(`axis-cards: could not read ${path}: ${cause?.message ?? cause}`);
  err.cause = cause;
  return err;
}

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw readError(`git ${args.join(' ')}`, r.error);
  if (r.status !== 0) throw new Error(`axis-cards: git ${args.join(' ')} exited ${r.status}: ${String(r.stderr ?? '').trim().slice(0, 300)}`);
  return r.stdout;
}

/** Throws unless every sha is a 40-hex commit git can read. `diff-tree
 *  --stdin` skips an unknown object and still exits 0, so without this an
 *  unreadable commit would read as "empty diff" -- an answer, not an error
 *  (a-failed-reading-is-not-a-verdict). */
function assertCommits(repo, shas) {
  for (const sha of shas) if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error(`axis-cards: not a commit sha: ${sha}`);
  let resolved;
  try { resolved = resolveCommits(repo, shas); } catch (err) { throw readError('git cat-file --batch-check', err); }
  for (const sha of shas) if (resolved.get(sha) !== sha) throw new Error(`axis-cards: git cannot read commit ${sha}`);
}

/** The stable patch-id of every commit in `shas`, as Map sha -> id: the same
 *  computation unlanded-backlog.mjs uses to dedupe the backlog. Two commits
 *  whose diff is byte-identical (after the context/whitespace normalisation
 *  patch-id applies) share one id, so a patch reachable from six refs is one
 *  card. One `diff-tree -p --stdin` per chunk piped into ONE `patch-id
 *  --stable`, which prints `<patch-id> <commit>` per commit. MEASURED
 *  2026-09-26: the one-commit form cost two processes per retiring line
 *  (2,114 lines on master) and was part of why `axis decide --backlog` ran
 *  for hours.
 *
 *  A commit with no textual diff (a merge with nothing to say, a commit whose
 *  tree equals its parent's) gives `git patch-id` nothing to hash and gets no
 *  line back -- a real, distinct patch-id space collapsing onto itself, not a
 *  read failure. Every such commit gets its own stable id, content-addressed
 *  by its own sha, so it still dedupes against ANOTHER retiring line for the
 *  same commit while never colliding with a different empty commit. */
export function patchIdsOf(repo, shas) {
  const unique = [...new Set(shas)];
  const ids = new Map();
  if (!unique.length) return ids;
  assertCommits(repo, unique);
  // A chunk at a time, so one patch-id input stays well inside a string.
  for (let i = 0; i < unique.length; i += 400) {
    const batch = unique.slice(i, i + 400);
    const per = diffTreeStdin(repo, ['-p', '--no-color', '--full-index', '--root'], batch);
    const diff = batch.map(sha => per.get(sha)).join('');
    const pids = new Map();
    if (diff.trim()) {
      for (const line of git(repo, ['patch-id', '--stable'], diff).split('\n')) {
        const [id, commit] = line.split(' ');
        if (commit) pids.set(commit, id);
      }
    }
    for (const sha of batch) {
      if (!per.get(sha).trim()) { ids.set(sha, createHash('sha1').update(`axis-cards:empty-diff:${sha}`).digest('hex')); continue; }
      const id = pids.get(sha);
      if (!/^[0-9a-f]{40}$/.test(id ?? '')) throw new Error(`axis-cards: git patch-id produced no id for ${sha}`);
      ids.set(sha, id);
    }
  }
  return ids;
}

/** Files each commit touched, Map sha -> [path]: deepest truth for "owners"
 *  on revive. One `diff-tree --name-only --stdin` per chunk. */
export function filesOfMany(repo, shas) {
  const unique = [...new Set(shas)];
  const files = new Map();
  if (!unique.length) return files;
  assertCommits(repo, unique);
  const per = diffTreeStdin(repo, ['--name-only', '-r'], unique);
  for (const sha of unique) files.set(sha, per.get(sha).split('\n').slice(1).map(s => s.trim()).filter(Boolean));
  return files;
}

/** The retiring rows of the verdict ledger, one per (source, row): `units`
 *  is axis-verdicts.mjs verdictUnits(). A whole-ref row names no commit --
 *  readVerdicts' domain, not a card's. Replaces parseDroppedWork(), which read
 *  the same lines out of docs/dropped-work/*.md until 2026-09-26. */
export function retiringRows(units) {
  const out = [];
  for (const u of units ?? []) {
    if (!u.source) continue;
    for (const r of u.rows) {
      if (!RETIRING_VERDICT.has(r.verdict)) continue;
      out.push({ origin: r.origin, ref: r.ref ?? u.source, source: u.source, verdict: r.verdict, reason: `${r.successor ? `${r.successor} · ` : ''}${r.reason}` });
    }
  }
  return out;
}

/* ---------- the store: a flat JSON document, atomic write ---------- */

function loadStore(path) {
  if (!existsSync(path)) return { cards: {} };
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (err) { throw readError(path, err); }
  if (!text.trim()) return { cards: {} };
  try { return JSON.parse(text); }
  catch (err) { throw readError(path, err); }
}

function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}

function emitLedger(ledger, unit, type, payload) {
  if (!ledger || typeof ledger.emit !== 'function') return;
  ledger.emit('card', unit, type, payload, { actor: 'axis-cards' });
}

const AREA_OF = path => path.split('/').slice(0, 2).join('/');

function upsertCard(store, card) {
  const existing = store.cards[card.id];
  if (existing) {
    // Re-ingesting must be idempotent: keep operator-set fields (status,
    // value, revived_row), refresh everything derived from the source.
    store.cards[card.id] = {
      ...existing,
      ...card,
      status: existing.status,
      value: existing.value,
      revived_row: existing.revived_row,
    };
    return { card: store.cards[card.id], created: false };
  }
  store.cards[card.id] = card;
  return { card, created: true };
}

/**
 * ingest(sources) -> cards
 *
 * sources:
 *   storePath      required. Where the card ledger lives (a JSON file).
 *   repo           required for patch cards. Repo root, for patch-id and
 *                  file lookups.
 *   verdicts       the verdict ledger's units (axis-verdicts.mjs
 *                  verdictUnits); patch cards come from its retiring rows.
 *   ideas          [{ id, title, does, files, areas }] -- idea_candidate rows.
 *   laneInsights   [{ id, row, title, does, files, transcript }] -- failed/
 *                  empty lanes worth keeping.
 *   ledger         optional { emit } -- P01, stubbed in tests.
 *
 * Every retiring verdict row becomes exactly one `patch` card, keyed by
 * patch-id: the same commit reachable from two refs, or two commits whose
 * diff is identical, collapse to one card, ingested any number of times.
 */
export function ingest(sources = {}) {
  const { storePath, repo, ideas = [], laneInsights = [], ledger = null } = sources;
  if (!storePath) throw new Error('axis-cards: ingest requires sources.storePath');
  const store = loadStore(storePath);
  const produced = [];

  if (sources.verdicts) {
    if (!repo) throw new Error('axis-cards: ingest requires sources.repo to compute patch-id and files');
    const lines = retiringRows(sources.verdicts);
    // Dedup by patch-id within this ingest pass before touching the store,
    // so N retiring lines for the same patch never create N cards even on
    // a cold store.
    const byPatchId = new Map();
    const idOf = patchIdsOf(repo, lines.map(l => l.source));
    for (const line of lines) {
      const patchId = idOf.get(line.source);
      if (!byPatchId.has(patchId)) byPatchId.set(patchId, { patchId, lines: [] });
      byPatchId.get(patchId).lines.push(line);
    }
    const filesBySource = filesOfMany(repo, [...byPatchId.values()].map(g => g.lines[0].source));
    for (const { patchId, lines: group } of byPatchId.values()) {
      const first = group[0];
      const files = filesBySource.get(first.source);
      const card = {
        id: `card_patch_${patchId.slice(0, 16)}`,
        kind: 'patch',
        source: `change:chg_${patchId.slice(0, 16)}`,
        title: first.ref,
        does: first.reason.slice(0, 280),
        files,
        areas: [...new Set(files.map(AREA_OF))],
        ui: files.some(f => f.startsWith('apps/ui/')),
        screenshot: null,
        compat: { status: 'unknown', master: null, at: null },
        value: { score: null, basis: null }, // unknown until decided -- NEVER 0
        effort: { lines: null, files: files.length, conflicts: null },
        status: 'listed',
        retired_reason: group.map(l => `${l.verdict} ${l.reason}`).join(' | '),
        decided_by: null,
        revived_row: null,
      };
      const { card: stored, created } = upsertCard(store, card);
      produced.push(stored);
      if (created) emitLedger(ledger, stored.id, 'card.create', { kind: 'patch', patchId });
    }
  }

  for (const idea of ideas) {
    const card = {
      id: `card_idea_${idea.id}`,
      kind: 'idea',
      source: `idea:${idea.id}`,
      title: idea.title ?? idea.id,
      does: String(idea.does ?? '').slice(0, 280),
      files: idea.files ?? [],
      areas: idea.areas ?? [...new Set((idea.files ?? []).map(AREA_OF))],
      ui: (idea.files ?? []).some(f => f.startsWith('apps/ui/')),
      screenshot: null,
      compat: { status: 'unknown', master: null, at: null },
      value: { score: null, basis: null },
      effort: { lines: null, files: (idea.files ?? []).length, conflicts: null },
      status: 'listed',
      retired_reason: null,
      decided_by: null,
      revived_row: null,
    };
    const { card: stored, created } = upsertCard(store, card);
    produced.push(stored);
    if (created) emitLedger(ledger, stored.id, 'card.create', { kind: 'idea', ideaId: idea.id });
  }

  for (const lane of laneInsights) {
    const card = {
      id: `card_lane_${lane.id}`,
      kind: 'lane_insight',
      source: `lane:${lane.id}`,
      title: lane.title ?? `lane ${lane.id}`,
      does: String(lane.does ?? '').slice(0, 280),
      files: lane.files ?? [],
      areas: lane.areas ?? [...new Set((lane.files ?? []).map(AREA_OF))],
      ui: (lane.files ?? []).some(f => f.startsWith('apps/ui/')),
      screenshot: null,
      compat: { status: 'unknown', master: null, at: null },
      value: { score: null, basis: null },
      effort: { lines: null, files: (lane.files ?? []).length, conflicts: null },
      status: 'listed',
      retired_reason: lane.stoppedAt ? `stopped: ${lane.stoppedAt}` : null,
      decided_by: null,
      revived_row: lane.row ?? null,
    };
    const { card: stored, created } = upsertCard(store, card);
    produced.push(stored);
    if (created) emitLedger(ledger, stored.id, 'card.create', { kind: 'lane_insight', laneId: lane.id });
  }

  saveStore(storePath, store);
  return produced;
}

/**
 * list(filter) -> cards
 *
 * filter: { storePath (required), kind, status, area, json }
 * Archived cards are excluded by default -- "hides, never deletes" means
 * the default gallery view, not the store. Pass status:'archived' (or
 * status:'*') to see them.
 */
export function list(filter = {}) {
  const { storePath } = filter;
  if (!storePath) throw new Error('axis-cards: list requires filter.storePath');
  const store = loadStore(storePath);
  let cards = Object.values(store.cards);
  if (filter.kind) cards = cards.filter(c => c.kind === filter.kind);
  if (filter.area) cards = cards.filter(c => c.areas.includes(filter.area));
  if (filter.status) {
    cards = filter.status === '*' ? cards : cards.filter(c => c.status === filter.status);
  } else {
    cards = cards.filter(c => c.status !== 'archived');
  }
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}

export function get(cardId, { storePath }) {
  if (!storePath) throw new Error('axis-cards: get requires storePath');
  const store = loadStore(storePath);
  return store.cards[cardId] ?? null;
}

/** archive(cardId) -> card | null. Hides a card from the default gallery.
 *  Never deletes the row -- `list({ status: '*' })` and `get` still find it. */
export function archive(cardId, { storePath, ledger = null } = {}) {
  if (!storePath) throw new Error('axis-cards: archive requires storePath');
  const store = loadStore(storePath);
  const card = store.cards[cardId];
  if (!card) return null;
  card.status = 'archived';
  saveStore(storePath, store);
  emitLedger(ledger, cardId, 'card.archive', {});
  return card;
}

const PRECONDITION_HEADER = 'PRECONDITION-NOGREP';

/** Owners for a revive row: the card's files, deduped, in the `paths`
 *  shape the queue's `id|owners|title|desc` line already uses (comma-
 *  joined). A card with no files (an idea never scoped to a path) falls
 *  back to its areas, so a row is never created with an empty owners
 *  field. */
function ownersOf(card) {
  const files = card.files ?? [];
  if (files.length) return [...new Set(files)];
  if (card.areas?.length) return [...new Set(card.areas)];
  return ['unscoped'];
}

function preconditionNogrep(card) {
  const targets = (card.files ?? []).slice(0, 8);
  const probe = targets.length
    ? `grep -q . ${targets.map(f => `"${f}"`).join(' ')} 2>/dev/null && echo present || echo absent`
    : 'true # no files recorded on this card; precondition cannot be automated';
  return `${PRECONDITION_HEADER}: the feature card ${card.id} describes is still absent from master -- verify with \`${probe}\` before dispatching, and refuse the row if it now reads present.`;
}

// An APPEND, not a read-and-rewrite: writeFileSync of the whole file truncated it
// and wrote back the copy read a moment earlier, dropping any row another writer
// appended in between.
function appendQueueRow(queuePath, line) {
  mkdirSync(dirname(queuePath), { recursive: true });
  const existing = existsSync(queuePath) ? readFileSync(queuePath, 'utf8') : '';
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(queuePath, `${sep}${line}\n`);
}

/**
 * revive(cardId, opts) -> row
 *
 * opts.queuePath is REQUIRED, on purpose: there is no default that could
 * resolve to the live fleet queue, so a caller that forgets it fails
 * loudly instead of silently reaching ops/fleet/queue-ceo/work.txt. The
 * CLI and the route file are the only callers allowed to pass the real
 * path; every test passes a temp file.
 */
export function revive(cardId, opts = {}) {
  const { storePath, queuePath, ledger = null, now = () => new Date().toISOString() } = opts;
  if (!storePath) throw new Error('axis-cards: revive requires storePath');
  if (!queuePath) throw new Error('axis-cards: revive requires an explicit queuePath (never defaults to the live queue)');
  const store = loadStore(storePath);
  const card = store.cards[cardId];
  if (!card) throw new Error(`axis-cards: no card ${cardId}`);
  if (card.status === 'archived') throw new Error(`axis-cards: ${cardId} is archived; restore it before reviving`);

  const owners = ownersOf(card);
  const title = `revive: ${card.title}`.slice(0, 200);
  const desc = `bring ${card.source} onto master as it is now. ${preconditionNogrep(card)} card ${card.id}`;
  const rowId = `axis-revive-${card.id.replace(/^card_/, '')}`;
  const line = [rowId, owners.join(','), title, desc].map(s => String(s).replace(/[\n|]/g, ' ')).join('|');
  appendQueueRow(queuePath, line);

  card.status = 'revived';
  card.revived_row = rowId;
  saveStore(storePath, store);
  emitLedger(ledger, cardId, 'card.revive', { row: rowId, queuePath });

  return { id: rowId, owners, title, desc, card: card.id, queuePath, at: now() };
}
