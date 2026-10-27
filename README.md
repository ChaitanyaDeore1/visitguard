# VisitGuard - AI Appointment Recovery Agent (prototype)

**The AI proposes. Deterministic rules decide.** When a medical partner misses an appointment, an AI agent proposes the next action (retry contact, notify customer, reschedule, escalate). A rule engine approves or blocks every proposal, so the AI can never skip a safety rule. Unresolved cases escalate to a human with a full audit trail.

Independent prototype inspired by the PPMC appointment-coordination use case published by Desible.ai. Not an official Desible.ai product. All partner contacts and notifications are **simulated**; data is synthetic; metrics are **demo simulation results**.

## Run locally (Node 18+)
```
npm install
npm start      # http://localhost:3000
npm test
```
Works with no API key (mock AI). Set `ANTHROPIC_API_KEY` to use a real LLM as the proposer; its output is still validated by the guardrails, and invalid or failed LLM calls fall back to the mock.

## Deploy on Render (free)
1. Push this folder to a GitHub repo.
2. Render > New > Blueprint > select the repo (uses `render.yaml`). Or New > Web Service: build `npm install`, start `npm start`, health check `/health`.
3. Optional: add `ANTHROPIC_API_KEY` in the Render dashboard. Never commit it.
Note: the free tier sleeps when idle and the demo database lives in `/tmp`, so it resets on restart. This is intended.

## Demo steps
1. **Run Demo Scenario**: first contact fails, retry returns an ETA, customer notified, case recovered.
2. **Run Failure Scenario**: every attempt fails, retries stop at the limit, case escalates.
3. **Run AI Guardrail Demo**: the AI tries to mark the case recovered before the partner confirmed and to retry past the limit. The guardrail blocks both and escalates. Open the case to read "AI proposed / Guardrail blocked / Rules chose".
4. In any case: Simulate Delay, Run Recovery, Simulate Failure, Approve reschedule. **Reset** re-seeds.

## Architecture
- `server/agent.js` AI proposer (LLM or mock); output treated as untrusted
- `server/guardrail.js` rule engine: allowed actions, retry limit, recovery requires confirmed ETA + notification, reschedule requires human approval
- `server/workflow.js` state machine (on_time -> delayed -> recovered | escalated), agent loop, idempotency, metrics
- `server/db.js` SQLite + seed; `server/index.js` REST API, validation, rate limit, `/health`
- `public/index.html` dashboard; `test/` node:test suite (transitions, retries, escalation, guardrails, idempotency incl. concurrent, metrics)

## API
GET /health | GET /api/appointments?status=&priority= | GET /api/appointments/:id | POST /api/appointments/:id/{delay,recover,fail,resolve} (optional `Idempotency-Key`) | POST /api/demo/{recovery,failure,guardrail} | POST /api/reset | GET /api/metrics | GET /api/config

## Config
`MAX_RETRIES`, `MAX_ACCEPTABLE_ETA_MIN`, `RATE_LIMIT_PER_MIN`, `AI_CALLS_PER_HOUR`, `AI_MODEL`, `DB_FILE`, `PORT`.

## Limitations
No real calls/SMS or partner integrations. Plain JS frontend (no React/TS build). In-memory rate limiter, single instance. Not for real patient data.
