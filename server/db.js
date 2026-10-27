const Database = require('better-sqlite3');
const path = require('path');

function open(file = process.env.DB_FILE || path.join(__dirname, '..', 'visitguard.db')) {
  const db = new Database(file);
  db.exec(`
  CREATE TABLE IF NOT EXISTS appointments(
    id INTEGER PRIMARY KEY AUTOINCREMENT, partner TEXT, customer TEXT, scheduled_at TEXT,
    status TEXT DEFAULT 'on_time', priority TEXT DEFAULT 'medium', delay_min INTEGER DEFAULT 0,
    partner_mode TEXT DEFAULT 'normal', ai_mode TEXT DEFAULT 'normal', attempts INTEGER DEFAULT 0, next_action TEXT,
    escalation_reason TEXT, delayed_at INTEGER, resolved_at INTEGER);
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id INTEGER, ts INTEGER, type TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY, response TEXT);`);
  try { db.exec("ALTER TABLE appointments ADD COLUMN ai_mode TEXT DEFAULT 'normal'"); } catch (e) { /* already exists */ }
  return db;
}

function log(db, id, type, message) {
  db.prepare('INSERT INTO events(appointment_id,ts,type,message) VALUES(?,?,?,?)').run(id, Date.now(), type, message);
}

function add(db, f) {
  const when = new Date(Date.now() + (f.offsetMin ?? 30) * 60000).toISOString();
  const id = db.prepare(`INSERT INTO appointments(partner,customer,scheduled_at,priority,partner_mode,ai_mode,next_action)
    VALUES(?,?,?,?,?,?,?)`).run(f.partner, f.customer, when, f.priority || 'medium', f.mode || 'normal', f.ai || 'normal', 'Monitor arrival').lastInsertRowid;
  log(db, id, 'created', 'Appointment created (synthetic data)');
  return Number(id);
}

const SEED = [
  { partner: 'Demo Partner A (mobile health)', customer: 'Customer #1041', priority: 'high', offsetMin: 20 },
  { partner: 'Demo Partner B (diagnostics)', customer: 'Customer #1042', priority: 'medium', offsetMin: 45, mode: 'flaky' },
  { partner: 'Demo Partner C (home visits)', customer: 'Customer #1043', priority: 'low', offsetMin: 90 },
  { partner: 'Demo Partner D (imaging)', customer: 'Customer #1044', priority: 'high', offsetMin: 60, mode: 'late' },
  { partner: 'Demo Partner E (care network)', customer: 'Customer #1045', priority: 'medium', offsetMin: 120 },
  { partner: 'Demo Partner F (lab services)', customer: 'Customer #1046', priority: 'high', offsetMin: -25, mode: 'fail', delayed: 25 },
  { partner: 'Demo Partner G (clinics)', customer: 'Customer #1047', priority: 'low', offsetMin: -40, mode: 'flaky', delayed: 40 },
  { partner: 'Demo Partner H (health)', customer: 'Customer #1048', priority: 'medium', offsetMin: 150 },
];

function seed(db) {
  db.exec('DELETE FROM appointments; DELETE FROM events; DELETE FROM idempotency; DELETE FROM sqlite_sequence;');
  for (const s of SEED) {
    const id = add(db, s);
    if (s.delayed) {
      db.prepare("UPDATE appointments SET status='delayed', delay_min=?, delayed_at=?, next_action='Run recovery' WHERE id=?")
        .run(s.delayed, Date.now(), id);
      log(db, id, 'delay_detected', `Partner ${s.delayed} min past expected arrival; case marked at risk`);
    }
  }
}

module.exports = { open, seed, add, log };