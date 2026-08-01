# Multilarity — log-space capability patch

Five files change. `mar.js`, `ledger.js`, `package.json`, `styles.css`, `README.md`
are untouched — do not re-upload them.

| file | changed lines | what changed |
|---|---|---|
| `ecology.js` | 84 | capability stored as `logCap`; `logSumExp` / `logShares` helpers; growth via `log1p`; history records decades and shares |
| `agents.js` | 23 | lineage and locus shares taken in log space; no linear totals anywhere |
| `app.js` | 63 | chart plots log₁₀ with `1e<n>` axis ticks; DHL card shows `∞` + its MI term; MI card publishes applied weights |
| `index.html` | 6 | plot header and DHL caption relabelled; canvas aria-label updated |
| `server.js` | 5 | commits `schema: 2` in each new epoch body |

---

## Before you deploy — check the volume

A redeploy restarts the container. On Railway a container filesystem is
ephemeral **unless a volume is mounted**, and the chain lives at
`data/epochs.jsonl` inside the app directory. If no volume is attached, the
redeploy silently discards all 22,000+ links and the chain restarts from
genesis.

In the Railway project, open the `multilarity-web4` service → **Variables /
Settings** → **Volumes**. If nothing is mounted at `/app/data`, add a volume
there first and redeploy once *before* uploading these files, so the existing
chain is written to durable storage. Confirm with:

    curl -s https://multilarity-web4-production.up.railway.app/api/chain/verify

If `checked` comes back at 22,000-plus after that redeploy, the chain survived
and you can proceed. If it comes back near zero, the old chain was already
ephemeral and this upload is the right moment to start a durable one.

## Upload steps

1. Go to `github.com/lawrencejohnreilly-creator/multilarity-web4`.
2. **Add file → Upload files.**
3. Drag in all five files at once: `ecology.js`, `agents.js`, `app.js`,
   `index.html`, `server.js`. GitHub replaces same-named files at the repo
   root; the flat layout is unchanged.
4. Commit message: `capability in log space — indicators are scale-invariant, schema 2`.
5. **Commit changes** directly to `main`.
6. Railway rebuilds automatically. Watch the deploy log for a clean start.

## After deploy — three checks

    curl -s .../api/state | grep -o '"schema":2'          # schema marker present
    curl -s .../api/chain/verify                          # ok:true, checked climbing
    curl -s .../api/state | grep -o '"log10Capability"'   # log fields emitted

Then load the page: the envelope should show five separated lines with
visibly different slopes instead of one curve above five flat ones, the axis
should read `1e165`-style ticks, and the DHL card should read `∞` with
`· term 1.00` in its subtitle rather than a bare dash.

## What did not change

The trajectory. Replaying the patched model from the same seed reproduces the
live run exactly — at epoch 22,000 it gives MI 0.200, CCR 1.000, LD 1.00,
AR 0.00, with Eridani at log₁₀ 165.4, matching what the site is showing now.
This is a change of representation, not of model. Verified to 500,000 epochs
(log₁₀ 3726) with no overflow and no NaN.

Old epoch records keep `schema` absent and verify byte-for-byte under the
original rules; only new bodies carry `schema: 2`. A mixed chain was tested
and verifies clean.

## Still open, not fixed here

- **AR has never been measured.** `drillAge` has equalled `epoch` for the
  whole run, so `AR 0.00` means "never asked", not "capturable". The
  `§7.5 exit-drill` item sitting in your approval queue is the first real
  MC-4 measurement available — approve it.
- **The sentinel is quiet.** No `SENTINEL` lines appear across epochs
  22014–22038 while four conditions fail. Worth confirming whether the mode
  toggle and the queue state agree.
- **MC-2's card text** names only provenance, but the verdict is also gated by
  `LINEAGE-MONITOR`. A reader seeing `6/6 clean` beside `MC-2 Not held` will
  read it as the instrument contradicting itself.
- **Agent-row colours.** `INDEXER` renders green at MI 0.200 while `LD 1.00`
  and `AR 0.00` render red. MI is the one that is floored.
