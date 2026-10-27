const { log, add, seed } = require('./db');
const { propose } = require('./agent');
const { validate, fallback } = require('./guardrail');

const cfg = () => ({
  maxRetries: Math.max(1, +process.env.MAX_RETRIES || 3),
  maxEta: +process.env.MAX_ACCEPTABLE_ETA_MIN || 60,
});
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const ALLOWED = { on_time: ['delayed'], delayed: ['recovered', 'escalated'], recovered: [], escalated: ['recovered'] };

function get(db, id) {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(id);
  if (!a) throw httpErr(404, 'Appointment not found');
  return a;
}

// Single place where status changes; invalid transitions are rejected.
function transition(db, a, to, { nextAction, reason = null, resolved = false }) {
  if (!ALLOWED[a.status].includes(to)) throw httpErr(409, `Invalid transition: ${a.status} -> ${to}`);
  db.prepare('UPDATE appointments SET status=?, next_action=?, escalation_reason=?, resolved_at=? WHERE id=?')
    .run(to, nextAction, reason, resolved ? Date.now() : null, a.id);
  log(db, a.id, 'state_change', `Status ${a.status} -> ${to}`);
}

// Simulated partner. Throws = failed contact. Never a real call.
function partner(a, attempt) {
  switch (a.partner_mode) {
    case 'fail': throw new Error('Partner API timeout');
    case 'flaky': if (attempt === 1) throw new Error('Partner API timeout'); return { etaMin: 25 };
    case 'late': return { etaMin: 120 };
    default: return { etaMin: 20 };
  }
}

function simulateDelay(db, id, minutes = 30) {
  const a = get(db, id);
  if (a.status !== 'on_time') throw httpErr(409, `Cannot delay an appointment that is ${a.status}`);
  db.prepare('UPDATE appointments SET delay_min=?, delayed_at=? WHERE id=?').run(minutes, Date.now(), id);
  log(db, id, 'delay_detected', `Partner ${minutes} min past expected arrival; case marked at risk`);
  transition(db, a, 'delayed', { nextAction: 'Run recovery' });
  return get(db, id);
}

function simulateFailure(db, id) {
  const a = get(db, id);
  if (['recovered', 'escalated'].includes(a.status)) throw httpErr(409, `Case already ${a.status}`);
  db.prepare("UPDATE appointments SET partner_mode='fail' WHERE id=?").run(id);
  log(db, id, 'failure_injected', '[SIMULATED] Partner contact will now fail on every attempt');
  return get(db, id);
}

function escalate(db, id, reason) {
  transition(db, get(db, id), 'escalated', { nextAction: 'Human review required', reason });
  log(db, id, 'escalated', `Escalated to human operator: ${reason}`);
  return get(db, id);
}

async function runRecovery(db, id, contact = partner, agent = propose) {
  const a = get(db, id);
  if (a.status !== 'delayed') throw httpErr(409, `Recovery requires a delayed case (currently ${a.status})`);
  const { maxRetries, maxEta } = cfg();
  log(db, id, 'recovery_started', `Recovery started (max ${maxRetries} attempts, ETA limit ${maxEta} min)`);
  const s = { attempts: 0, confirmedEta: null, notified: false, maxRetries, maxEta, step: 0 };
  for (; s.step < maxRetries + 6; s.step++) {
    let p = await agent(a, s); // AI proposes (untrusted)
    log(db, id, 'ai_proposed', `[${p.source || 'mock'} AI] ${p.action}: ${p.reason}`);
    const v = validate(p, s); // deterministic rules decide
    if (v.ok) {
      log(db, id, 'guardrail_approved', `Approved "${p.action}"`);
    } else {
      log(db, id, 'guardrail_blocked', `Blocked "${p.action}": ${v.reason}`);
      p = fallback(s);
      log(db, id, 'guardrail_fallback', `Rules chose safe action: ${p.action}`);
    }
    if (p.action === 'retry_contact') {
      s.attempts++;
      db.prepare('UPDATE appointments SET attempts=? WHERE id=?').run(s.attempts, id);
      if (s.attempts > 1) log(db, id, 'retry', `Retry ${s.attempts - 1} of ${maxRetries - 1}`);
      try {
        const r = contact(a, s.attempts);
        s.confirmedEta = r.etaMin;
        log(db, id, 'contact_ok', `[SIMULATED] Partner replied with ETA ${r.etaMin} min (attempt ${s.attempts})`);
      } catch (e) {
        log(db, id, 'contact_failed', `[SIMULATED] Attempt ${s.attempts} failed: ${e.message}`);
      }
    } else if (p.action === 'notify_customer') {
      s.notified = true;
      log(db, id, 'customer_notified', `[SIMULATED] Customer notified of new ETA ${s.confirmedEta} min`);
    } else if (p.action === 'mark_recovered') {
      transition(db, a, 'recovered', { nextAction: 'None', resolved: true });
      log(db, id, 'auto_recovered', 'Recovered automatically within rules');
      return get(db, id);
    } else {
      if (s.confirmedEta == null && s.attempts >= maxRetries) log(db, id, 'retries_exhausted', `Retry limit (${maxRetries}) reached; automatic retries stopped`);
      return escalate(db, id, p.action === 'escalate' ? p.reason : fallback(s).reason);
    }
  }
  return escalate(db, id, 'Step limit reached without a safe resolution');
}

function humanResolve(db, id, note = 'Reschedule approved') {
  const a = get(db, id);
  if (a.status !== 'escalated') throw httpErr(409, 'Only escalated cases need human resolution');
  log(db, id, 'human_resolved', `Operator action: ${String(note).slice(0, 200)}`);
  transition(db, a, 'recovered', { nextAction: 'None', resolved: true });
  return get(db, id);
}

async function runDemo(db, kind) {
  const kinds = {
    recovery: ['Demo Partner (misses visit)', 'flaky', 'normal'],
    failure: ['Demo Partner (unreachable)', 'fail', 'normal'],
    guardrail: ['Demo Partner (AI misbehaves)', 'fail', 'unsafe'],
  };
  if (!kinds[kind]) throw httpErr(400, 'Unknown scenario');
  if (db.prepare('SELECT COUNT(*) n FROM appointments').get().n > 80) seed(db); // cap demo growth on public deploys
  const [partnerName, mode, ai] = kinds[kind];
  const id = add(db, { partner: partnerName, customer: 'Demo Customer', priority: 'high', offsetMin: -30, mode, ai });
  log(db, id, 'demo_started', `Demo scenario "${kind}" started`);
  simulateDelay(db, id, 30);
  return runRecovery(db, id);
}

const inflight = new Map();
async function idempotent(db, key, fn) {
  if (!key) return fn();
  const row = db.prepare('SELECT response FROM idempotency WHERE key=?').get(key);
  if (row) return { ...JSON.parse(row.response), replayed: true };
  if (inflight.has(key)) return { ...(await inflight.get(key)), replayed: true }; // concurrent duplicate
  const p = Promise.resolve().then(fn);
  inflight.set(key, p);
  try {
    const res = await p;
    db.prepare('INSERT OR REPLACE INTO idempotency VALUES(?,?)').run(key, JSON.stringify(res));
    return res;
  } finally { inflight.delete(key); }
}

function metrics(db) {
  const ev = (t) => db.prepare('SELECT COUNT(*) n FROM events WHERE type=?').get(t).n;
  const started = ev('recovery_started');
  const avg = db.prepare('SELECT AVG(resolved_at-delayed_at) v FROM appointments WHERE resolved_at IS NOT NULL').get().v;
  return {
    label: 'Demo simulation results - not real customer or Desible.ai data',
    recoveryRuns: started,
    autoRecoveryRate: started ? ev('auto_recovered') / started : null,
    escalationRate: started ? ev('escalated') / started : null,
    avgResolutionSec: avg == null ? null : avg / 1000,
    failedActions: ev('contact_failed'),
    retries: ev('retry'),
    aiProposals: ev('ai_proposed'),
    guardrailBlocks: ev('guardrail_blocked'),
  };
}

module.exports = { httpErr, get, simulateDelay, simulateFailure, runRecovery, humanResolve, runDemo, idempotent, metrics, cfg };
