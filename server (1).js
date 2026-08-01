'use strict';

/**
 * server.js — the autonomous runtime.
 *
 * Zero external dependencies: the instrument should not fail to start
 * because a registry was unreachable.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Ecology } = require('./ecology');
const { runPipeline } = require('./agents');
const { Ledger } = require('./ledger');
const mar = require('./mar');

const PORT = process.env.PORT || 3000;
const INTERVAL = Number(process.env.INTERVAL_MS || 4000);

const eco = new Ecology(Number(process.env.SEED || 20260730));
const ledger = new Ledger();

const state = {
  mode: process.env.MODE === 'oversight' ? 'oversight' : 'autonomous',
  pipeline: null,
  mars: [],
  queue: [],
  log: [],
  started: new Date().toISOString(),
};

const clients = new Set();

function logLine(agent, text) {
  state.log.unshift({ epoch: eco.epoch, ts: new Date().toISOString(), agent, text });
  if (state.log.length > 120) state.log.pop();
}

function tick() {
  eco.tick();
  const pipeline = runPipeline(eco, state.mode, state.queue);
  state.pipeline = pipeline;

  for (const a of pipeline.actions) {
    if (a.status === 'applied') {
      logLine('SENTINEL', `${a.name} (${a.pathology}) — ${a.result}`);
    } else {
      state.queue.push(a);
      logLine('SENTINEL', `${a.name} (${a.pathology}) — remediation queued for approval.`);
    }
  }

  if (eco.epoch % 6 === 0) {
    const failing = Object.entries(pipeline.conditions).filter(([, v]) => !v);
    logLine(
      'INDEXER',
      failing.length
        ? `MI ${pipeline.index.mi} · failing ${failing.map(([k]) => k).join(', ')}`
        : `MI ${pipeline.index.mi} · all five conditions holding`
    );
  }

  const record = ledger.commit({
    epoch: eco.epoch,
    // Capability moved to a log representation at this point in the run.
    // Records committed before the change keep schema 1 and verify byte
    // for byte under the original rules; the change is itself committed
    // rather than applied quietly to history.
    schema: 2,
    indicators: pipeline.index,
    conditions: pipeline.conditions,
    pathologies: pipeline.pathologies.map((p) => p.code),
    remediations: pipeline.actions.map((a) => ({ kind: a.kind, status: a.status })),
    loci: pipeline.agents[0].locusCount,
    deployments: pipeline.agents[0].deployments,
  });

  state.mars = mar.issue(eco, pipeline, ledger.head);
  broadcast(snapshot(record));
}

function snapshot(latestEpoch) {
  const p = state.pipeline;
  return {
    mode: state.mode,
    epoch: eco.epoch,
    started: state.started,
    ecology: eco.snapshot(),
    history: eco.history.slice(-160),
    index: p ? p.index : null,
    conditions: p ? p.conditions : null,
    agents: p ? p.agents : [],
    pathologies: p ? p.pathologies : [],
    queue: state.queue,
    log: state.log.slice(0, 24),
    chain: {
      head: ledger.head,
      count: ledger.count,
      persisted: ledger.persist,
      latest: latestEpoch ? { epoch: latestEpoch.epoch, hash: latestEpoch.hash } : null,
    },
    mars: state.mars,
  };
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        resolve({ __parseError: true, raw: data });
      }
    });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (p === '/health') return sendJSON(res, 200, { ok: true, epoch: eco.epoch });

  if (p === '/api/state') return sendJSON(res, 200, snapshot());

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/epochs') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 24), 300);
    return sendJSON(res, 200, { count: ledger.count, head: ledger.head, epochs: ledger.tail(limit) });
  }

  if (p === '/api/chain/verify') return sendJSON(res, 200, ledger.verify());

  if (p === '/api/mar') return sendJSON(res, 200, { records: state.mars });

  if (p === '/api/mar/verify' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) {
      return sendJSON(res, 400, {
        ok: false,
        checks: [{ name: 'parse', ok: false, note: 'Could not read the record as JSON.' }],
      });
    }
    const knownLoci = state.pipeline ? state.pipeline.agents[0].loci : [];
    return sendJSON(res, 200, mar.verify(body, { knownLoci }));
  }

  if (p === '/api/mode' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.mode !== 'autonomous' && body.mode !== 'oversight') {
      return sendJSON(res, 400, { error: 'mode must be "autonomous" or "oversight"' });
    }
    state.mode = body.mode;
    logLine('OPERATOR', `Mode set to ${state.mode}.`);
    broadcast(snapshot());
    return sendJSON(res, 200, { mode: state.mode });
  }

  if (p === '/api/approve' && req.method === 'POST') {
    const body = await readBody(req);
    const item = state.queue.find((q) => q.key === body.key);
    if (!item) return sendJSON(res, 404, { error: 'No queued remediation with that key.' });
    item.result = eco.applyRemediation({ kind: item.kind, target: item.target });
    item.status = 'applied';
    state.queue = state.queue.filter((q) => q.key !== item.key);
    logLine('OPERATOR', `Approved ${item.name} — ${item.result}`);
    broadcast(snapshot());
    return sendJSON(res, 200, item);
  }

  if (p === '/api/reject' && req.method === 'POST') {
    const body = await readBody(req);
    const item = state.queue.find((q) => q.key === body.key);
    if (!item) return sendJSON(res, 404, { error: 'No queued remediation with that key.' });
    state.queue = state.queue.filter((q) => q.key !== item.key);
    logLine('OPERATOR', `Declined ${item.name}. Finding stands unremediated.`);
    broadcast(snapshot());
    return sendJSON(res, 200, { declined: item.key });
  }

  if (p === '/api/inject' && req.method === 'POST') {
    const body = await readBody(req);
    const result = eco.inject(body.kind);
    logLine('STRESS', result);
    broadcast(snapshot());
    return sendJSON(res, 200, { kind: body.kind, result });
  }

  if (p === '/draft' || p === '/draft.txt') {
    return serveStatic(req, res, '/draft-reilly-multilarity-00.txt');
  }

  return serveStatic(req, res, p);
});

tick();
setInterval(tick, INTERVAL);

server.listen(PORT, () => {
  console.log(`multilarity-web4 listening on ${PORT} · mode=${state.mode} · interval=${INTERVAL}ms`);
});
