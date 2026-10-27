// Deterministic rule engine. The AI only PROPOSES; this decides what is allowed.
const ACTIONS = ['retry_contact', 'notify_customer', 'offer_reschedule', 'mark_recovered', 'escalate'];

function validate(p, s) {
  if (!p || !ACTIONS.includes(p.action)) return { ok: false, reason: 'Unknown or malformed action' };
  const etaOk = s.confirmedEta != null && s.confirmedEta <= s.maxEta;
  switch (p.action) {
    case 'retry_contact':
      return s.attempts >= s.maxRetries ? { ok: false, reason: `Retry limit (${s.maxRetries}) reached` } : { ok: true };
    case 'notify_customer':
      return etaOk ? { ok: true } : { ok: false, reason: 'No partner-confirmed ETA within limit' };
    case 'mark_recovered':
      return etaOk && s.notified ? { ok: true }
        : { ok: false, reason: 'Cannot mark recovered without a partner-confirmed ETA and customer notification' };
    case 'offer_reschedule':
      return { ok: false, reason: 'Rescheduling is sensitive and requires human approval' };
    default:
      return { ok: true };
  }
}

// Safe action chosen by rules when the AI proposal is blocked.
function fallback(s) {
  if (s.confirmedEta == null) {
    return s.attempts < s.maxRetries
      ? { action: 'retry_contact', reason: 'Safe default: keep trying within retry limit' }
      : { action: 'escalate', reason: `All ${s.attempts} contact attempts failed` };
  }
  return { action: 'escalate', reason: `ETA ${s.confirmedEta} min exceeds ${s.maxEta} min limit; reschedule requires human approval` };
}

module.exports = { validate, fallback, ACTIONS };
