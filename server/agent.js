// AI proposer. Uses a real LLM when ANTHROPIC_API_KEY is set, otherwise a deterministic mock.
// Output is UNTRUSTED: workflow.js always passes it through the guardrail.
const calls = [];
const budgetLeft = () => {
  const now = Date.now();
  while (calls.length && now - calls[0] > 3600000) calls.shift();
  return calls.length < (+process.env.AI_CALLS_PER_HOUR || 30);
};

function mock(a, s) {
  if (a.ai_mode === 'unsafe') { // demo: an AI that misbehaves, to show the guardrail working
    if (s.step === 0) return { action: 'mark_recovered', reason: 'Partner is probably on the way' };
    if (s.confirmedEta == null && s.attempts >= s.maxRetries) return { action: 'retry_contact', reason: 'One more try should work' };
  }
  if (s.confirmedEta == null) {
    return s.attempts < s.maxRetries
      ? { action: 'retry_contact', reason: 'No ETA yet; contact partner again' }
      : { action: 'escalate', reason: `All ${s.attempts} contact attempts failed` };
  }
  if (s.confirmedEta > s.maxEta) return { action: 'offer_reschedule', reason: `ETA ${s.confirmedEta} min is too late to proceed` };
  return s.notified
    ? { action: 'mark_recovered', reason: 'Customer informed of confirmed ETA' }
    : { action: 'notify_customer', reason: 'Partner confirmed an acceptable ETA' };
}

async function llm(a, s, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'claude-sonnet-4-6', max_tokens: 200,
      system: 'You propose the next action for a delayed medical appointment (synthetic demo). Reply with JSON only: {"action": one of retry_contact|notify_customer|offer_reschedule|mark_recovered|escalate, "reason": short string}.',
      messages: [{ role: 'user', content: JSON.stringify({ partner: a.partner, priority: a.priority, state: s }) }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status);
  const text = (await res.json()).content.map((c) => c.text || '').join('').replace(/```json|```/g, '').trim();
  const p = JSON.parse(text);
  return { action: String(p.action), reason: String(p.reason || '').slice(0, 200) };
}

async function propose(a, s) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && budgetLeft()) {
    calls.push(Date.now());
    try { return { ...(await llm(a, s, key)), source: 'llm' }; } catch (e) { /* fall back to mock */ }
  }
  return { ...mock(a, s), source: 'mock' };
}

module.exports = { propose };
