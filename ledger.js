'use strict';

/**
 * ledger.js — the epoch chain.
 *
 * Each observation interval commits a hash-linked record of what the
 * agents measured. The chain is the site's answer to Section 7.3: a
 * later revision of an earlier finding cannot be made quietly, because
 * every subsequent commitment depends on it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GENESIS = '0'.repeat(64);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class Ledger {
  constructor(dir = path.join(__dirname, 'data')) {
    this.dir = dir;
    this.file = path.join(dir, 'epochs.jsonl');
    this.recent = [];
    this.count = 0;
    this.head = GENESIS;
    this.persist = true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) this.load();
    } catch (err) {
      // Read-only or ephemeral filesystem: hold the chain in memory.
      this.persist = false;
    }
  }

  load() {
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        this.count++;
        this.head = rec.hash;
        this.recent.push(rec);
      } catch (err) {
        break;
      }
    }
    if (this.recent.length > 300) this.recent = this.recent.slice(-300);
  }

  commit(body) {
    const record = {
      epoch: body.epoch,
      ts: new Date().toISOString(),
      prev: this.head,
      body,
    };
    record.hash = sha256(record.prev + canonical(record.body) + record.ts);
    this.head = record.hash;
    this.count++;
    this.recent.push(record);
    if (this.recent.length > 300) this.recent.shift();
    if (this.persist) {
      try {
        fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
      } catch (err) {
        this.persist = false;
      }
    }
    return record;
  }

  /**
   * Recompute every link from the stored record. Returns the first
   * epoch at which the chain fails, if any.
   */
  verify() {
    let prev = GENESIS;
    let checked = 0;
    let source = 'memory';
    let records = this.recent;

    if (this.persist && fs.existsSync(this.file)) {
      try {
        records = fs
          .readFileSync(this.file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        source = 'disk';
      } catch (err) {
        records = this.recent;
      }
    }

    for (const rec of records) {
      const expect = sha256(rec.prev + canonical(rec.body) + rec.ts);
      if (source === 'disk' && rec.prev !== prev && checked > 0) {
        return { ok: false, checked, failedAt: rec.epoch, reason: 'broken link' };
      }
      if (expect !== rec.hash) {
        return { ok: false, checked, failedAt: rec.epoch, reason: 'hash mismatch' };
      }
      prev = rec.hash;
      checked++;
    }
    return { ok: true, checked, source, head: this.head };
  }

  tail(limit = 24) {
    return this.recent.slice(-limit).reverse();
  }
}

module.exports = { Ledger, canonical, sha256, GENESIS };
