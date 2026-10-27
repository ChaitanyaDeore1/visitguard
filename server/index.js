const express = require('express');
const path = require('path');
const { open, seed } = require('./db');
const w = require('./workflow');

const STATUSES = ['on_time', 'delayed', 'recovered', 'escalated'];
const PRIORITIES = ['high', 'medium', 'low'];

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });

  // Simple in-memory rate limit for write actions (protects a public deploy).
  const hits = new Map();
  const LIMIT = +process.env.RATE_LIMIT_PER_MIN || 60;
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= LIMIT) return res.status(429).json({ error: 'Too many requests; please slow down' });
    recent.push(now); hits.set(req.ip, recent);
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error' }); }
  };
  const idOf = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw w.httpErr(400, 'Invalid appointment id');
    return id;
  };

  app.get('/api/appointments', wrap((req) => {
    const { status, priority } = req.query;
    if (status && !STATUSES.includes(status)) throw w.httpErr(400, 'Invalid status filter');
    if (priority && !PRIORITIES.includes(priority)) throw w.httpErr(400, 'Invalid priority filter');
    return db.prepare('SELECT * FROM appointments WHERE (? IS NULL OR status=?) AND (? IS NULL OR priority=?) ORDER BY scheduled_at')
      .all(status || null, status || null, priority || null, priority || null);
  }));
  app.get('/api/appointments/:id', wrap((req) => {
    const id = idOf(req);
    return { appointment: w.get(db, id), events: db.prepare('SELECT * FROM events WHERE appointment_id=? ORDER BY id').all(id) };
  }));

  const act = (name, fn) => app.post(`/api/appointments/:id/${name}`, wrap((req) => {
    const id = idOf(req), key = req.get('Idempotency-Key');
    return w.idempotent(db, key && `${name}:${id}:${key}`, () => fn(id, req.body || {}));
  }));
  act('delay', (id, b) => {
    const m = b.minutes === undefined ? 30 : b.minutes;
    if (!Number.isInteger(m) || m < 1 || m > 600) throw w.httpErr(400, 'minutes must be an integer 1-600');
    return w.simulateDelay(db, id, m);
  });
  act('recover', (id) => w.runRecovery(db, id));
  act('fail', (id) => w.simulateFailure(db, id));
  act('resolve', (id, b) => w.humanResolve(db, id, b.note));

  app.post('/api/demo/:kind', wrap((req) => w.runDemo(db, req.params.kind)));
  app.post('/api/reset', wrap(() => { seed(db); return { ok: true }; }));
  app.get('/api/metrics', wrap(() => w.metrics(db)));
  app.get('/api/config', wrap(() => ({ ...w.cfg(), aiSource: process.env.ANTHROPIC_API_KEY ? 'llm' : 'mock' })));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

if (require.main === module) {
  const db = open();
  if (!db.prepare('SELECT COUNT(*) n FROM appointments').get().n) seed(db);
  const port = process.env.PORT || 3000;
  createApp(db).listen(port, '0.0.0.0', () => console.log(`VisitGuard running on port ${port}`));
}
module.exports = { createApp };
