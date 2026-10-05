/* axis-decider.mjs — AXIS primitive (c): one calibrated decider engine.
 *
 * WHY ONE ENGINE. DECISIONS.md: four question kinds (patch.verdict,
 * diff.review, brief.quality, error.class), one tier ladder (T0 git, T1
 * graph, T2 Jev+Luna, T3 free pool, T4 paid, T5 Marc), one calibration
 * protocol. PRIMITIVES.md (c): "A cheap decider is not allowed to gate
 * anything until its calibration for that question kind is recorded. Before
 * that it runs in shadow and writes its answer beside the legacy decision."
 * This module is the ladder-walker; it is not a specific tier.
 *
 * P06 ships T0 (axis-decider-git.mjs) and T2 (axis-decider-jev.mjs,
 * axis-decider-luna.mjs, combined here by `createAgreementTier`). T1
 * (P07), T3/T4/T5 (later packets, verdict-rows.mjs today) are callers'
 * responsibility — this engine only walks whatever tier list it is given.
 *
 * CONTRACT
 *   decide(question, { tiers, calibration, cache }) -> decision
 *     question   { kind, subject, evidence }
 *     tiers      [{ name, ask(question) -> answer | { error } }]
 *     calibration  { [tierName]: { calibrated: bool, thresholds: { [label]: theta } } }
 *     cache      optional P03 fingerprint stub: { get(kind, key), put(kind, key, value, inputs) }
 *
 *   answer = { label, confidence, why, cost, ms, successor? }
 *
 * NOTHING HERE GUESSES. A tier that cannot answer returns { error }, which
 * escalates — it is never turned into a label. An uncalibrated tier's answer
 * is recorded (shadow) and ALSO escalates, because shadow never gates
 * (PRIMITIVES.md (c)).
 */

/** Stable content hash for a question, used as the fingerprint-cache key and
 *  as the fallback in-memory dedupe key when no cache is injected. No crypto
 *  dependency: this is a cache key, not a security boundary, and a weak but
 *  fast hash is what a per-process test double needs. Collisions cost a
 *  cache miss, never a wrong answer, because the value is verified by kind
 *  before use (see `readCache`). */
function stableHash(value) {
  const text = canonicalJSON(value);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)) >>> 0;
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/** The answer-cache key: MODEL ANSWERS ARE CACHED PER EXACT INPUT, NEVER PER
 *  SIMILAR INPUT (PRIMITIVES.md (b)) — so the key is over the tier name, the
 *  question kind, and the exact subject+evidence content, never a fuzzy
 *  summary. */
export function answerCacheKey(tierName, question) {
  return stableHash({ tier: tierName, kind: question.kind, subject: question.subject, evidence: question.evidence });
}

/** Reads the injected fingerprint cache, kind 'model-answer'. A READ ERROR
 *  THROWS, NEVER RETURNS A MISS (PRIMITIVES.md (b)) — a decider must not
 *  silently recompute into a different answer because the store hiccuped, so
 *  this rethrows rather than swallowing. Returns null only on a clean miss. */
function readCache(cache, key) {
  if (!cache || typeof cache.get !== 'function') return null;
  const hit = cache.get('model-answer', key);
  return hit && typeof hit === 'object' ? (hit.value ?? hit) : null;
}

function writeCache(cache, key, value, inputs) {
  if (!cache || typeof cache.put !== 'function') return;
  cache.put('model-answer', key, value, inputs ?? []);
}

function isPlainAnswer(a) {
  return a && typeof a === 'object' && typeof a.label === 'string' && a.label.length > 0
    && typeof a.confidence === 'number' && Number.isFinite(a.confidence);
}

/** SUPERSEDED WITHOUT A VERIFIABLE SUCCESSOR ESCALATES. `fix(gate2)` PR
 *  #1503 already refuses a SUPERSEDED-BY with no successor (DECISIONS.md,
 *  T2). `verifySuccessor` is injected by the caller (T0/T1 know how to check
 *  a master ref exists; this engine does not). UNVERIFIABLE MEANS NO
 *  VERIFIER: with none injected, EVERY SUPERSEDED-shaped answer escalates,
 *  named successor or not. Trusting a tier's own claim was tried and is
 *  exactly the failure this rule exists to prevent — measured 2026-09-26,
 *  Jev is right 57% of the time and Luna 51% on the answer key, so an
 *  unverified "trust me, it's superseded" is a coin flip that drops real
 *  work. Fail closed. */
function supersededVerified(answer, question, verifySuccessor) {
  const label = String(answer.label || '');
  if (!/SUPERSEDED/i.test(label)) return true;
  if (!answer.successor) return false;
  if (typeof verifySuccessor !== 'function') return false; // no verifier injected: never trust the claim
  try {
    return verifySuccessor(answer.successor, question) === true;
  } catch {
    return false;
  }
}

/**
 * Walk the tier ladder for one question. Never throws for a tier's own
 * failure — a tier error is an escalation, not a crash — but DOES throw if
 * `tiers` is not iterable or a tier is malformed, because that is a caller
 * bug, not a decision outcome.
 */
export async function decide(question, { tiers, calibration = {}, cache = null, verifySuccessor = null } = {}) {
  if (question == null || typeof question !== 'object') throw new Error('decide requires a question object');
  const { kind, subject } = question;
  if (!kind) throw new Error('decide requires question.kind');
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error('decide requires a non-empty tiers array');

  const trail = [];
  for (const tier of tiers) {
    if (!tier || typeof tier.ask !== 'function' || !tier.name) {
      throw new Error('each tier needs a name and an ask() function');
    }
    const key = answerCacheKey(tier.name, question);
    let cached = false;
    let answer;
    let cacheError = null;
    try {
      answer = readCache(cache, key);
      if (answer != null) cached = true;
    } catch (error) {
      cacheError = error;
    }
    if (cacheError) {
      trail.push({ tier: tier.name, error: `answer cache read failed: ${cacheError.message}`, cached: false });
      throw cacheError; // a cache read error must surface, never become a silent miss
    }

    if (answer == null) {
      let raw;
      try {
        raw = await tier.ask({ kind, subject, evidence: question.evidence, trail: [...trail] });
      } catch (error) {
        trail.push({ tier: tier.name, error: `ask() threw: ${error.message}`, cached: false });
        continue; // escalate
      }
      answer = raw;
    }

    if (!answer || answer.error) {
      trail.push({ tier: tier.name, error: answer?.error ?? 'no answer', cached });
      continue; // escalate
    }
    if (!isPlainAnswer(answer)) {
      trail.push({ tier: tier.name, error: 'malformed answer (missing label/confidence)', cached });
      continue; // escalate — never guess a shape into a label
    }

    if (!cached) writeCache(cache, key, answer, [`kind:${kind}`, `subject:${JSON.stringify(subject)}`]);

    const tierCalibration = calibration[tier.name];
    const isCalibrated = Boolean(tierCalibration && tierCalibration.calibrated && tierCalibration.thresholds);
    if (!isCalibrated) {
      // SHADOW ONLY: recorded, never gates. PRIMITIVES.md (c).
      trail.push({ tier: tier.name, label: answer.label, confidence: answer.confidence, why: answer.why, cost: answer.cost ?? 0, ms: answer.ms ?? 0, cached, shadow: true });
      continue;
    }

    const theta = tierCalibration.thresholds[answer.label];
    if (theta == null) {
      trail.push({ tier: tier.name, label: answer.label, confidence: answer.confidence, why: answer.why, cost: answer.cost ?? 0, ms: answer.ms ?? 0, cached, gated: false, reason: 'label has no calibrated threshold' });
      continue; // escalate
    }
    if (answer.confidence < theta) {
      trail.push({ tier: tier.name, label: answer.label, confidence: answer.confidence, why: answer.why, cost: answer.cost ?? 0, ms: answer.ms ?? 0, cached, gated: false, reason: `confidence ${answer.confidence} below threshold ${theta}` });
      continue; // escalate — agreement/confidence below threshold escalates
    }
    if (!supersededVerified(answer, question, verifySuccessor)) {
      trail.push({ tier: tier.name, label: answer.label, confidence: answer.confidence, why: answer.why, cost: answer.cost ?? 0, ms: answer.ms ?? 0, cached, gated: false, reason: 'SUPERSEDED without a verifiable successor' });
      continue; // escalate
    }

    trail.push({ tier: tier.name, label: answer.label, confidence: answer.confidence, why: answer.why, cost: answer.cost ?? 0, ms: answer.ms ?? 0, cached, gated: true });
    return {
      kind, subject,
      decided: true,
      status: 'decided',
      tier: tier.name,
      label: answer.label,
      confidence: answer.confidence,
      why: answer.why,
      successor: answer.successor ?? null,
      cost: trail.reduce((s, t) => s + (t.cost ?? 0), 0),
      ms: trail.reduce((s, t) => s + (t.ms ?? 0), 0),
      trail,
    };
  }

  return {
    kind, subject,
    decided: false,
    status: 'escalated',
    tier: null,
    label: null,
    confidence: null,
    why: null,
    successor: null,
    cost: trail.reduce((s, t) => s + (t.cost ?? 0), 0),
    ms: trail.reduce((s, t) => s + (t.ms ?? 0), 0),
    trail,
  };
}

/**
 * T2's agreement rule, tier-shaped so `decide()` never has to know Jev and
 * Luna exist. DECISIONS.md: "Decision rule: both return the same label, each
 * with confidence at or above that label's threshold... Two agreeing models
 * are not two independent measurements... only the calibrated precision of
 * the agreeing case decides" — so this tier does NOT apply a threshold
 * itself; it only enforces agreement and privacy, and leaves confidence
 * gating to `decide()`'s calibration table for the combined tier name, same
 * as every other tier.
 *
 * PRIVACY GATE, before either asker is called: `classify(question)` must
 * return `{ sensitivity }`. `private` (or worse) is refused outright —
 * NEVER SENT to Luna or Jev. `secret`-pattern text is redacted by `redact`
 * (the "seatbelt") before it reaches either asker; `redact` defaults to a
 * no-op secret-pattern stripper covering the common credential shapes so a
 * caller that forgets to inject one is still covered.
 *
 * ANY ASKERS, NOT ONLY JEV AND LUNA. `askers: [{ alias, ask }]` adds further
 * judges (the free T2 models, axis-decider-free.mjs) beside or instead of the
 * two named slots. With `askersRequired: 1` and one asker this is a single
 * judge behind the same privacy gate, which is how a free model becomes its
 * own calibrated T2 tier: the gate is never re-implemented per model.
 */
export function createAgreementTier({
  name = 'T2',
  jev,
  luna,
  classify,
  redact = defaultRedact,
  askersRequired = 2,
  askers: extraAskers = [],
} = {}) {
  const named = [];
  if (typeof jev?.ask === 'function') named.push({ alias: 'jev', ask: jev.ask });
  if (typeof luna?.ask === 'function') named.push({ alias: 'luna', ask: luna.ask });
  for (const a of extraAskers) {
    if (!a?.alias || typeof a.ask !== 'function') throw new Error('each extra asker needs an alias and an ask() function');
    named.push({ alias: a.alias, ask: a.ask });
  }
  if (!named.length) {
    throw new Error('createAgreementTier requires at least one of jev.ask / luna.ask / askers');
  }
  if (typeof classify !== 'function') throw new Error('createAgreementTier requires classify(question) -> { sensitivity }');

  async function ask(question) {
    const sensitivityInput = { text: JSON.stringify({ subject: question.subject, evidence: question.evidence }) };
    const classified = classify(sensitivityInput);
    if (!classified || classified.sensitivity == null) return { error: 'classify() returned no sensitivity' };
    if (classified.sensitivity === 'private' || classified.sensitivity === 'secret-block') {
      return { error: `refused: classifyForIngest marked this ${classified.sensitivity}` };
    }

    const safeQuestion = classified.sensitivity === 'secret'
      ? redactQuestion(question, redact)
      : question;

    const askers = named;
    if (askers.length < askersRequired) return { error: `agreement tier needs ${askersRequired} askers, has ${askers.length}` };

    const askOne = async a => {
      try {
        return { alias: a.alias, answer: await a.ask(safeQuestion) };
      } catch (error) {
        return { alias: a.alias, answer: { error: error.message } };
      }
    };
    // A PAID ASKER WITH A PRE-CHECK GOES LAST. Jev spends a finite grant and
    // its createJevTier carries `shouldAsk` (axis-decider-jev.mjs
    // JEV_T2_POLICY): the free askers answer first, and when the pre-check
    // says Jev's answer could not count, Jev is never called.
    const gated = askers.find(a => a.alias === 'jev' && typeof jev?.shouldAsk === 'function');
    let results;
    if (gated) {
      const first = await Promise.all(askers.filter(a => a !== gated).map(askOne));
      const prior = Object.fromEntries(first.map(r => [r.alias, r.answer]));
      const verdict = jev.shouldAsk(prior);
      if (!verdict?.ok) return { error: `jev not asked: ${verdict?.reason ?? 'pre-check refused'}` };
      results = [...first, await askOne(gated)];
    } else {
      results = await Promise.all(askers.map(askOne));
    }

    for (const r of results) {
      if (!r.answer || r.answer.error) return { error: `${r.alias} did not answer: ${r.answer?.error ?? 'no answer'}` };
    }

    const [first, ...rest] = results;
    const agree = rest.every(r => r.answer.label === first.answer.label);
    if (!agree) {
      return { error: `no agreement: ${results.map(r => `${r.alias}=${r.answer.label}`).join(', ')}` };
    }

    const confidence = Math.min(...results.map(r => r.answer.confidence));
    const cost = results.reduce((s, r) => s + (r.answer.cost ?? 0), 0);
    const ms = Math.max(...results.map(r => r.answer.ms ?? 0));
    const why = results.map(r => `${r.alias}: ${r.answer.why ?? ''}`).join(' | ');
    const successor = results.map(r => r.answer.successor).find(Boolean) ?? null;

    return { label: first.answer.label, confidence, why, cost, ms, successor, agreement: results.map(r => ({ alias: r.alias, confidence: r.answer.confidence })) };
  }

  return { name, ask };
}

/** The seatbelt: strips the same secret shapes context-sensitivity.mjs
 *  flags (env values, private keys, API-key-looking tokens, DB URLs, AWS/
 *  Slack/Stripe/GitHub keys) out of free text before it is ever built into
 *  a T2 prompt. Independent of context-sensitivity.mjs's patterns on
 *  purpose: this is a redaction pass (replace and keep going), that module
 *  is a classification gate (refuse outright) — the two must not share one
 *  implementation, because a bug in a shared regex would open both holes at
 *  once. */
export function defaultRedact(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED-PRIVATE-KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED-TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED-SECRET]')
    .replace(/\b(?:sk_live_|pk_live_|rk_live_)[A-Za-z0-9]{20,}\b/g, '[REDACTED-SECRET]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-AWS-KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED-SLACK-TOKEN]')
    .replace(/\b(?:postgres|postgresql|mysql|mongodb|redis|sqlite|sqlserver|mssql|oracle):\/\/\S+/gi, '[REDACTED-DB-URL]')
    .replace(/(?<![A-Za-z0-9])(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token)(?![A-Za-z0-9])\s*[:=]\s*\S+/gi, '[REDACTED-CREDENTIAL]');
}

function redactQuestion(question, redact) {
  return {
    ...question,
    subject: typeof question.subject === 'string' ? redact(question.subject) : question.subject,
    evidence: redactDeep(question.evidence, redact),
  };
}

function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out;
  }
  return value;
}
