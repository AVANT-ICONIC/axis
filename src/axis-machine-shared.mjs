// SHARED HELPERS FOR THE PURE TABLE-DRIVEN AXIS REDUCERS. AXIS P02
// (docs/axis/PACKETS.md).
//
// Every axis-machine-*.mjs file transcribes one docs/axis/LEDGER.md state
// table verbatim (CONTRACT, LEDGER.md "State machines": `reduce(state,
// event) -> { next, intents } | { refused, why }`, never partial, never I/O).
// The table itself is each file's own content and stays there; this module
// holds only the scaffolding every one of those tables was re-typing around
// itself -- `ok`/`refused` result shaping, the shared bad-input check, the
// `status` accessor, `apply`, and the generic scan-the-table loop -- so a
// 16th packet needs a table, not a reducer.
export function ok(next, intents = []) {
  return { next, intents };
}

export function refused(state, event, why) {
  return { refused: true, state, event, why };
}

export function badInput(state, event) {
  if (state !== null && state !== undefined && typeof state !== 'object') return true;
  if (state && typeof state.status !== 'string' && state.status !== null && state.status !== undefined) return true;
  if (event === null || typeof event !== 'object') return true;
  if (typeof event.type !== 'string' || event.type.length === 0) return true;
  return false;
}

export function statusOf(state) {
  return state && typeof state === 'object' ? (state.status ?? null) : null;
}

export function apply(state, to, data) {
  return { ...(state && typeof state === 'object' ? state : {}), status: to, ...(data || {}) };
}

/**
 * Scan TABLE for the first row whose `from` matches the current status,
 * whose `type` matches the event, and whose optional `guard` passes; apply
 * it and return `ok(...)`, or `refused(...)` when nothing matches.
 *
 * `matchesFrom(row, status)` overrides the default `row.from === status`
 * check -- axis-machine-row.mjs is the one table with a `from: 'ANY'` row
 * ("any EXISTING row, not one never proposed"), so it passes its own
 * predicate instead of forcing that case into every other table.
 */
export function reduceTable(state, event, TABLE, { matchesFrom } = {}) {
  if (badInput(state, event)) return refused(state, event, 'unreadable-input');
  const status = statusOf(state);
  for (const row of TABLE) {
    if (matchesFrom ? !matchesFrom(row, status) : row.from !== status) continue;
    if (row.type !== event.type) continue;
    if (row.guard && !row.guard(event, state)) continue;
    const to = row.to(event, state);
    const data = row.data ? row.data(event, state) : undefined;
    const intents = row.intents ? row.intents(event, state) : [];
    return ok(apply(state, to, data), intents);
  }
  return refused(state, event, `no transition from ${String(status)} on ${event.type}`);
}
