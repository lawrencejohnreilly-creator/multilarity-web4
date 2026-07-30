# multilarity-web4

Autonomous reference instrument for **draft-reilly-multilarity-00**,
*The Multilarity: Plural Intelligence Growth Without Convergence*.

The site does not describe the framework. It runs it: eight agents
measure a reference ecology every interval, commit what they found to a
hash-linked epoch chain, issue and verify Multilarity Attestation
Records, and repair the convergence pathologies they detect.

## What it demonstrates

The draft's central claim is that plurality is not the default outcome
of many actors existing at once, and that the difference between a
plural ecology and a singleton wearing many hostnames is checkable on
the wire. The instrument makes that checkable difference visible:

- **Loci, not endpoints.** MC-1 is assessed on seven substantive
  dimensions. Trigger the acquisition stress and watch the locus count
  drop to 5 while the endpoint count stays at 6 — the arithmetic by
  which plurality is usually lost.
- **Detection before breach.** Consent erosion (§7.5) fires on a rising
  trend in disengagement cost, before the absolute MC-4 threshold is
  crossed, because every individual increment is defensible.
- **Adversarial evidence.** Absorption Resistance is measured by
  attempted absorption and exercised exit, not by reading policy
  documents.
- **An unkind verifier.** A record that passes every structural check
  while corroborating nothing returns a note rather than a clean bill,
  per §7.4.

## Running it

No dependencies. Node 18 or later.

```bash
node server.js
# http://localhost:3000
```

Environment variables:

| Variable      | Default    | Meaning                            |
|---------------|------------|------------------------------------|
| `PORT`        | `3000`     | Listen port (Railway sets this)    |
| `INTERVAL_MS` | `4000`     | Observation interval               |
| `MODE`        | `autonomous` | `autonomous` or `oversight`      |
| `SEED`        | `20260730` | PRNG seed; a run is reproducible   |

## Deploying to Railway

1. Create a GitHub repo and upload every file in this folder to the
   **repo root** — flat, no subfolder.
2. In Railway, **New Project → Deploy from GitHub repo**, select it.
3. Railway reads `railway.json`, runs `node server.js`, and health-checks
   `/health`. No build step, no install step.
4. **Settings → Networking → Generate Domain.**

The epoch chain writes to `./data/epochs.jsonl`. Railway's filesystem is
ephemeral, so the chain resets on redeploy; the ledger detects a
read-only or unavailable filesystem and continues in memory. Attach a
volume mounted at `/app/data` to make it durable across deploys.

## Modes

**Autonomous** — the sentinel applies remediations as findings arrive.

**Human oversight** — the sentinel proposes and stops. Findings queue
for a person to approve or decline, and nothing changes until they do.
Declining is a real option: the finding stands unremediated and stays
visible.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Full snapshot: indicators, conditions, agents, pathologies |
| `/api/stream` | GET | Server-sent events, one frame per interval |
| `/api/epochs?limit=n` | GET | Recent chain records |
| `/api/chain/verify` | GET | Recompute every link from disk |
| `/api/mar` | GET | Records issued for the current epoch |
| `/api/mar/verify` | POST | Verify any submitted record |
| `/api/mode` | POST | `{"mode":"autonomous"\|"oversight"}` |
| `/api/approve`, `/api/reject` | POST | `{"key":"..."}` for a queued remediation |
| `/api/inject` | POST | `{"kind":"acquisition"}` and the other four stresses |
| `/draft` | GET | The Internet-Draft |

## Files

| File | Role |
|---|---|
| `ecology.js` | The observed ecology: participants, loci, lineages, couplings |
| `agents.js` | Eight agents — seven measure, one remediates |
| `ledger.js` | Hash-linked epoch chain and independent verification |
| `mar.js` | Attestation record issuance and verification |
| `server.js` | Runtime, SSE, JSON API, static serving |
| `index.html`, `app.js`, `styles.css` | The instrument's front end |

## A note on scope

The ecology is a reference model, not a survey of real systems, and it
is labelled as such in the footer. The agents, indicators, record
format, and chain are the parts meant to be reused against real
observations. No threshold MI is specified anywhere in the draft or the
instrument — publishing one would invite §7.4 faster than any adversary
could.
