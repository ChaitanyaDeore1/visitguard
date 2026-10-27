const test = require('node:test');
const assert = require('node:assert');
const { open, add } = require('../server/db');
const w = require('../server/workflow');
const { validate } = require('../server/guardrail');

const setup = (mode, ai) => { const db = open(':memory:'); const id = add(db, { partner: 'P', customer: 'C', mode, ai }); return { db, id }; };
const count = (db, id, t) => db.prepare('SELECT COUNT(*) n FROM events WHERE appointment_id=? AND type=?').get(id, t).n;
process.env.MAX_RETRIES = '3';

test('valid and invalid state transitions', async () => {
  const { db, id } = setup('normal');
  assert.strictEqual(w.simulateDelay(db, id, 30).status, 'delayed');
  assert.throws(() => w.simulateDelay(db, id, 30), /Cannot delay/);
  assert.strictEqual((await w.runRecovery(db, id)).status, 'recovered');
  await assert.rejects(() => w.runRecovery(db, id), /requires a delayed/);
});

test('failed first attempt is retried and then recovers', async () => {
  const { db, id } = setup('flaky');
  w.simulateDelay(db, id);
  const a = await w.runRecovery(db, id);
  assert.strictEqual(a.status, 'recovered');
  assert.strictEqual(a.attempts, 2);
  assert.strictEqual(count(db, id, 'contact_failed'), 1);
  assert.strictEqual(count(db, id, 'retry'), 1);
});

test('exhausted retries escalate and never mark recovered', async () => {
  const { db, id } = setup('fail');
  w.simulateDelay(db, id);
  const a = await w.runRecovery(db, id);
  assert.strictEqual(a.status, 'escalated');
  assert.strictEqual(a.attempts, 3);
  assert.strictEqual(count(db, id, 'contact_failed'), 3);
  assert.strictEqual(count(db, id, 'retries_exhausted'), 1);
  assert.match(a.escalation_reason, /All 3 contact attempts failed/);
});

test('late ETA: reschedule proposal is blocked and needs human approval', async () => {
  const { db, id } = setup('late');
  w.simulateDelay(db, id);
  assert.strictEqual((await w.runRecovery(db, id)).status, 'escalated');
  assert.strictEqual(count(db, id, 'guardrail_blocked'), 1);
  assert.strictEqual(w.humanResolve(db, id).status, 'recovered');
});

test('guardrail blocks unsafe AI proposals (premature recovery, retry over limit)', async () => {
  const { db, id } = setup('fail', 'unsafe');
  w.simulateDelay(db, id);
  const a = await w.runRecovery(db, id);
  assert.strictEqual(a.status, 'escalated');
  assert.strictEqual(count(db, id, 'guardrail_blocked'), 2);
  assert.strictEqual(a.attempts, 3);
});

test('a malicious LLM answer cannot bypass rules', async () => {
  const { db, id } = setup('normal');
  w.simulateDelay(db, id);
  const evil = async () => ({ action: 'mark_recovered', reason: 'trust me', source: 'llm' });
  const a = await w.runRecovery(db, id, undefined, evil);
  assert.ok(count(db, id, 'guardrail_blocked') >= 1);
  assert.notStrictEqual(a.next_action, undefined);
  assert.strictEqual(validate({ action: 'drop_database' }, { maxEta: 60 }).ok, false);
});

test('idempotency: sequential and concurrent duplicates run once', async () => {
  const { db, id } = setup('normal');
  w.simulateDelay(db, id);
  const run = () => w.idempotent(db, 'recover:1:k1', () => w.runRecovery(db, id));
  const [x, y] = await Promise.all([run(), run()]);
  const z = await run();
  assert.strictEqual(x.id, y.id);
  assert.ok(y.replayed && z.replayed);
  assert.strictEqual(count(db, id, 'recovery_started'), 1);
});

test('metrics come from persisted events', async () => {
  const db = open(':memory:');
  await w.runDemo(db, 'recovery'); await w.runDemo(db, 'guardrail');
  const m = w.metrics(db);
  assert.strictEqual(m.recoveryRuns, 2);
  assert.strictEqual(m.autoRecoveryRate, 0.5);
  assert.strictEqual(m.escalationRate, 0.5);
  assert.strictEqual(m.guardrailBlocks, 2);
});
