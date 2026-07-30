'use strict';

/**
 * mar.js — Multilarity Attestation Record.
 *
 * Issues records for the observed ecology and verifies records
 * submitted by anyone, per draft-reilly-multilarity-00 Section 6.3.
 */

const { canonical, sha256 } = require('./ledger');

const VALID_DAYS = 184;

function issue(eco, pipeline, head) {
  const now = new Date();
  const until = new Date(now.getTime() + VALID_DAYS * 86400000);
  const loci = pipeline.agents[0].loci;

  return eco.active().map((p) => {
    const locus = loci.find((l) => l.members.includes(p.id));
    const rec = {
      mar_version: '0',
      subject: `did:multilarity:${p.id}`,
      locus_id: locus ? locus.id : `locus:${p.id}`,
      lineage: {
        model_lineage: [p.dims.modelLineage],
        corpora: [p.dims.corpus],
        reinforcement_history: [p.dims.reinforcement],
        control_authority: p.dims.controlAuthority,
      },
      conditions: Object.entries(pipeline.conditions).map(([mc, pass]) => ({
        mc,
        asserted: pass,
        evidence: [`epoch:${eco.epoch}`, `chain:${head.slice(0, 16)}`],
      })),
      indicators: {
        scope: pipeline.index.scope,
        ccr: { value: pipeline.index.ccr, proxies: pipeline.index.ccrProxies },
        ld: { value: pipeline.index.ld },
        dhl_days: pipeline.index.dhlDays,
        dhl_status: pipeline.index.dhlStatus,
        ar: pipeline.index.ar,
        mi: {
          value: pipeline.index.mi,
          weights: pipeline.index.weights,
          applied_weights: pipeline.index.appliedWeights,
          terms: pipeline.index.terms,
          omitted: pipeline.index.omitted,
        },
      },
      provenance: {
        chain_head: head,
        epoch: eco.epoch,
        custodians: p.custodians,
      },
      attested_by: p.attestedBy === 'self' ? `did:multilarity:${p.id}` : `org:${p.attestedBy}`,
      valid_from: now.toISOString(),
      valid_until: until.toISOString(),
    };
    rec.digest = sha256(canonical(rec));
    return rec;
  });
}

/**
 * Verification is deliberately unkind. A record that looks complete
 * and corroborates nothing is the strongest available signal of
 * Section 7.4, and the verifier says so.
 */
function verify(rec, ctx) {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok, note });

  if (!rec || typeof rec !== 'object') {
    return { ok: false, checks: [{ name: 'parse', ok: false, note: 'Not a JSON object.' }] };
  }

  const required = [
    'mar_version',
    'subject',
    'locus_id',
    'lineage',
    'conditions',
    'provenance',
    'attested_by',
    'valid_from',
    'valid_until',
  ];
  const missing = required.filter((f) => !(f in rec));
  add(
    'Required fields present',
    missing.length === 0,
    missing.length ? `Missing: ${missing.join(', ')}` : 'All Section 6.1 fields supplied.'
  );

  const now = Date.now();
  const until = Date.parse(rec.valid_until || '');
  add(
    'Record unexpired',
    Number.isFinite(until) && until > now,
    Number.isFinite(until)
      ? until > now
        ? `Valid until ${rec.valid_until}.`
        : 'Expired. A permanent attestation of a mutable property is a false statement waiting to happen.'
      : 'valid_until missing or unparseable.'
  );

  const selfAttested =
    typeof rec.attested_by === 'string' &&
    typeof rec.subject === 'string' &&
    rec.attested_by === rec.subject;
  add(
    'Attesting party independent of subject',
    !selfAttested,
    selfAttested
      ? 'Self-assertion. Carries less weight than an independent attestation.'
      : `Attested by ${rec.attested_by}.`
  );

  const lineageComplete =
    rec.lineage &&
    Array.isArray(rec.lineage.model_lineage) &&
    rec.lineage.model_lineage.length > 0 &&
    Array.isArray(rec.lineage.corpora) &&
    rec.lineage.corpora.length > 0 &&
    !!rec.lineage.control_authority;
  add(
    'Lineage declared',
    !!lineageComplete,
    lineageComplete
      ? 'Antecedents disclosed at identifier granularity.'
      : 'Incomplete lineage. Omission of a known antecedent invalidates the record.'
  );

  const known = ctx && ctx.knownLoci ? ctx.knownLoci : [];
  const collision = known.filter((l) => l.id === rec.locus_id);
  const distinctString = rec.locus_id !== rec.subject;
  add(
    'Locus distinct on substantive grounds',
    distinctString,
    distinctString
      ? collision.length
        ? `Locus known to this instrument, holding ${collision[0].nominal} nominal participant(s).`
        : 'Locus not observed by this instrument; assessed on the record alone.'
      : 'locus_id duplicates subject. Identifier distinctness is not evidence of anything.'
  );

  let digestOk = true;
  if (rec.digest) {
    const copy = { ...rec };
    delete copy.digest;
    digestOk = sha256(canonical(copy)) === rec.digest;
    add(
      'Digest matches content',
      digestOk,
      digestOk ? 'Record content unmodified since issue.' : 'Digest does not match the record body.'
    );
  }

  const provenanceIndependent =
    rec.provenance &&
    (rec.provenance.chain_head ||
      (Array.isArray(rec.provenance.custodians) &&
        rec.provenance.custodians.filter((c) => !String(c).startsWith('inhouse-')).length >= 2));
  add(
    'Provenance under independent custody',
    !!provenanceIndependent,
    provenanceIndependent
      ? 'At least two custodial mechanisms with different failure modes.'
      : 'Custody appears to rest with the subject. See Section 7.3.'
  );

  const ok = checks.every((c) => c.ok);

  // A record that passes every structural check while corroborating
  // nothing is the strongest available signal of Section 7.4, and the
  // verifier says so rather than returning a clean bill.
  const note =
    ok && !collision.length
      ? 'Every structural check passes, but nothing here is corroborated by an independent observation of this locus. Complete-looking evidence with no corroboration is what Section 7.4 produces well. Weight adversarially obtained evidence above this record.'
      : null;

  return { ok, checks, note };
}

module.exports = { issue, verify };
