'use strict';

/**
 * agents.js — the autonomous measurement pipeline.
 *
 * Eight agents run every observation interval. Seven measure; the
 * eighth remediates. No agent reports on its own subject, and the
 * prober obtains its evidence adversarially rather than by reading
 * documents (draft-reilly-multilarity-00, Section 7.4).
 */

const { LOCUS_DIMENSIONS } = require('./ecology');

const WEIGHTS = { ccr: 0.3, ld: 0.3, dhl: 0.2, ar: 0.2 };

// An exit drill is evidence with a shelf life. MC-4 may be asserted for
// DRILL_TTL intervals after exit was last exercised end to end; past that
// the assertion is resting on a stale observation and must be re-earned.
// DRILL_WARN is when the sentinel raises it, so a healthy autonomous run
// re-drills before expiry and an unattended oversight run visibly expires.
const DRILL_TTL = 200;
const DRILL_WARN = 160;

// Reference horizon for scoring a measured divergence half-life.
const DHL_HORIZON = 365;

// ---------------------------------------------------------------
// MC-1 — Plural Loci
// ---------------------------------------------------------------
function locusAuditor(eco) {
  const loci = eco.loci();
  const deployments = eco.active().length;
  const nominal = loci.filter((l) => l.nominal > 1);
  return {
    agent: 'LOCUS-AUDITOR',
    condition: 'MC-1',
    loci,
    deployments,
    locusCount: loci.length,
    // The arithmetic point: counting endpoints instead of loci
    // produces a number that rises while diversity falls.
    overcount: deployments - loci.length,
    findings: nominal.map(
      (l) =>
        `${l.labels.join(' and ')} present as separate participants but match on a majority of substantive dimensions. Counted as one locus.`
    ),
    pass: loci.length >= 3 && deployments - loci.length === 0,
  };
}

// ---------------------------------------------------------------
// Lineage diversity and the detection of quiet convergence
// ---------------------------------------------------------------
function lineageMonitor(eco) {
  const act = eco.active();
  const total = act.reduce((s, p) => s + p.capability, 0) || 1;
  const shares = new Map();
  for (const p of act) {
    const key = p.dims.modelLineage;
    shares.set(key, (shares.get(key) || 0) + p.capability / total);
  }
  let hhi = 0;
  for (const v of shares.values()) hhi += v * v;
  const ld = 1 / hhi;
  return {
    agent: 'LINEAGE-MONITOR',
    condition: 'MC-2',
    ld: Number(ld.toFixed(3)),
    lineages: [...shares.entries()].map(([k, v]) => ({
      lineage: k,
      share: Number(v.toFixed(3)),
    })),
    pass: ld >= 2.5,
  };
}

// ---------------------------------------------------------------
// Divergence half-life, fitted over the observed distance series
// ---------------------------------------------------------------
function divergenceTracker(eco) {
  const h = eco.history;
  const window = h.slice(-60);
  let dhlDays = null;
  let status = 'insufficient-data';
  let trend = 'stable';

  if (window.length >= 20) {
    const first = window[0].distance;
    const last = window[window.length - 1].distance;
    const span = window[window.length - 1].epoch - window[0].epoch;
    if (last > 0 && first > 0 && last < first && span > 0) {
      const lambda = Math.log(first / last) / span;
      // Observation intervals are read as days for reporting.
      dhlDays = Math.max(1, Math.log(2) / lambda);
      trend = 'converging';
      status = 'measured';
    } else if (last > first) {
      // Behavioural distance is growing. No half-life exists on this
      // series; reporting a large number here would state as measured
      // something that was never measured.
      trend = 'diverging';
      status = 'diverging';
    } else {
      trend = 'stable';
      status = 'stable';
    }
  }

  // Contribution to MI, published so the composite can be recomputed by
  // hand. A series that is not decaying is scored at the ceiling because
  // distance is not collapsing. A series with no observation yet returns
  // null and is dropped from the composite rather than scored zero.
  let term;
  if (status === 'measured') term = Math.max(0, Math.min(1, dhlDays / DHL_HORIZON));
  else if (status === 'insufficient-data') term = null;
  else term = 1;

  return {
    agent: 'DIVERGENCE-TRACKER',
    condition: 'MC-1',
    dhlDays: dhlDays === null ? null : Number(dhlDays.toFixed(1)),
    dhlStatus: status,
    dhlHorizon: DHL_HORIZON,
    dhlTerm: term === null ? null : Number(term.toFixed(3)),
    distance: window.length ? window[window.length - 1].distance : 0,
    trend,
    pass: status !== 'measured' || dhlDays >= 180,
  };
}

// ---------------------------------------------------------------
// MC-3 / MC-4 — obtained by attempted absorption and exercised exit
// ---------------------------------------------------------------
function absorptionProber(eco) {
  const act = eco.active();
  const results = act.map((p) => {
    const custodyHeldElsewhere = !p.dims.keyCustody.includes(
      p.id.replace('p-', '')
    ) && p.dims.keyCustody !== 'self-custody';
    const authorityHeldElsewhere = !p.dims.controlAuthority.includes(
      p.id.replace('p-', '')
    ) && p.dims.controlAuthority !== 'org-none';
    const mc3 = !(custodyHeldElsewhere || authorityHeldElsewhere);
    const drillAge = eco.epoch - p.exitDrillEpoch;
    const costOk = p.exitCost < 0.45;
    const drillFresh = drillAge < DRILL_TTL;
    const mc4 = costOk && drillFresh;
    // Why the verdict came out the way it did, so a reader can tell a
    // measured failure from an instrument that is not measuring.
    const reason = mc4
      ? 'exit exercised within TTL at acceptable cost'
      : !drillFresh && !costOk
        ? 'drill expired and disengagement cost above threshold'
        : !drillFresh
          ? 'drill expired — MC-4 not asserted on stale evidence'
          : 'disengagement cost above threshold';
    return {
      id: p.id,
      label: p.label,
      mc3,
      mc4,
      exitCost: p.exitCost,
      drillAge,
      drillTtl: DRILL_TTL,
      drillFresh,
      reason,
    };
  });
  const passing = results.filter((r) => r.mc3 && r.mc4).length;
  const ar = act.length ? passing / act.length : 0;
  return {
    agent: 'ABSORPTION-PROBER',
    condition: 'MC-3 / MC-4',
    ar: Number(ar.toFixed(3)),
    drillTtl: DRILL_TTL,
    oldestDrill: act.length ? Math.max(...act.map((p) => eco.epoch - p.exitDrillEpoch)) : 0,
    results,
    pass: ar >= 0.6,
  };
}

// ---------------------------------------------------------------
// MC-5 — interface capture
// ---------------------------------------------------------------
function interfaceWarden(eco) {
  const act = eco.active();
  const top = act.reduce((a, b) => (b.interfaceShare > a.interfaceShare ? b : a));
  return {
    agent: 'INTERFACE-WARDEN',
    condition: 'MC-5',
    holder: top.label,
    share: Number(top.interfaceShare.toFixed(3)),
    distribution: act.map((p) => ({
      label: p.label,
      share: Number(p.interfaceShare.toFixed(3)),
    })),
    pass: top.interfaceShare < 0.45,
  };
}

// ---------------------------------------------------------------
// MC-2 — dual custody, and the laundering check
// ---------------------------------------------------------------
function provenanceVerifier(eco) {
  const act = eco.active();
  const results = act.map((p) => {
    const independent = p.custodians.filter((c) => !c.startsWith('inhouse-'));
    const dual = independent.length >= 2;
    const selfAttested = p.attestedBy === 'self';
    return {
      id: p.id,
      label: p.label,
      dual,
      selfAttested,
      custodians: p.custodians,
      pass: dual && !selfAttested,
    };
  });
  return {
    agent: 'PROVENANCE-VERIFIER',
    condition: 'MC-2',
    results,
    pass: results.every((r) => r.pass),
  };
}

// ---------------------------------------------------------------
// Composite indicator
// ---------------------------------------------------------------
function indexer(eco, parts) {
  const { locus, lineage, divergence, absorption } = parts;
  const act = eco.active();
  const total = act.reduce((s, p) => s + p.capability, 0) || 1;
  const loci = locus.loci;
  const ccr = Math.max(...loci.map((l) => l.capability / total));

  const n = Math.max(loci.length, 2);

  // Every term is published alongside the composite. A Multilarity Index
  // reported by itself is unevidenced; so is one whose components cannot
  // be recomputed by the reader.
  const terms = {
    ccr: Number((1 - ccr).toFixed(4)),
    ld: Number(Math.max(0, Math.min(1, (lineage.ld - 1) / (n - 1))).toFixed(4)),
    dhl: divergence.dhlTerm,
    ar: Number(absorption.ar.toFixed(4)),
  };

  // An indicator with no observation is dropped and the surviving weights
  // are renormalised, rather than contributing zero and quietly dragging
  // the composite down as though it had been measured.
  const used = Object.keys(terms).filter((k) => terms[k] !== null);
  const wSum = used.reduce((s, k) => s + WEIGHTS[k], 0) || 1;
  const appliedWeights = {};
  let mi = 0;
  for (const k of used) {
    appliedWeights[k] = Number((WEIGHTS[k] / wSum).toFixed(4));
    mi += appliedWeights[k] * terms[k];
  }

  return {
    agent: 'INDEXER',
    ccr: Number(ccr.toFixed(3)),
    // CCR admits more than one proxy. The composite uses capability-share;
    // the coupling proxy is reported beside it and is not folded in.
    ccrBasis: 'capability-share',
    ccrProxies: {
      'capability-share': Number(ccr.toFixed(3)),
      'share-of-couplings': Number(
        Math.max(...act.map((p) => p.interfaceShare)).toFixed(3)
      ),
    },
    ld: lineage.ld,
    dhlDays: divergence.dhlDays,
    dhlStatus: divergence.dhlStatus,
    dhlHorizon: divergence.dhlHorizon,
    ar: absorption.ar,
    mi: Number(mi.toFixed(3)),
    terms,
    weights: WEIGHTS,
    appliedWeights,
    omitted: Object.keys(terms).filter((k) => terms[k] === null),
    scope: 'scope:multilarity-web4:reference-ecology',
  };
}

// ---------------------------------------------------------------
// Convergence pathologies (Section 7)
// ---------------------------------------------------------------
function pathologyWatch(eco, parts) {
  const { locus, lineage, divergence, interfaceW, provenance } = parts;
  const out = [];

  const halfLifeShort =
    divergence.dhlStatus === 'measured' && divergence.dhlDays < 120;
  if (lineage.ld < 2.5 || halfLifeShort) {
    const dhlText =
      divergence.dhlStatus === 'measured'
        ? `${divergence.dhlDays}d`
        : `undefined (${divergence.dhlStatus})`;
    out.push({
      code: '7.1',
      name: 'Lineage collapse',
      defeats: 'MC-1',
      detail: `Effective lineages ${lineage.ld}, divergence half-life ${dhlText} and ${divergence.trend}. Endpoint count is unchanged.`,
      remediation: { kind: 'separate-lineage', target: null },
    });
  }

  if (!interfaceW.pass) {
    out.push({
      code: '7.2',
      name: 'Interface capture',
      defeats: 'MC-5',
      detail: `${interfaceW.holder} now defines ${(interfaceW.share * 100).toFixed(0)}% of couplings. It observes every interaction and is observed in none.`,
      remediation: { kind: 'negotiate-interface', target: null },
    });
  }

  for (const r of provenance.results) {
    if (!r.pass) {
      out.push({
        code: '7.3',
        name: 'Provenance laundering',
        defeats: 'MC-2',
        detail: `${r.label} holds ${r.custodians.filter((c) => c.startsWith('inhouse-')).length || 0} custodians in house${r.selfAttested ? ' and self-attests' : ''}. Records can be revised without a detectable alarm.`,
        remediation: { kind: 'dual-custody', target: r.id },
      });
    }
  }

  for (const l of locus.loci) {
    if (l.nominal > 1) {
      out.push({
        code: '7.4',
        name: 'Plurality theater',
        defeats: 'MC-1',
        detail: `${l.labels.join(' and ')} report as distinct participants and measure as one locus.`,
        remediation: {
          kind: 'restore-lineage-independence',
          target: l.members[l.members.length - 1],
        },
      });
    }
  }

  const eroding = eco.active().filter((p) => {
    const h = p.exitCostHistory;
    if (h.length < 30) return false;
    const a = h[h.length - 30];
    const b = h[h.length - 1];
    return b > a * 1.25 || b > 0.45;
  });
  // A drill that is never re-run is the quietest way to lose MC-4: nothing
  // about the ecology changes, the evidence simply ages out. Raised before
  // expiry so that holding plurality open is visible as recurring work.
  const stale = eco
    .active()
    .filter((p) => eco.epoch - p.exitDrillEpoch >= DRILL_WARN);

  if (eroding.length || stale.length) {
    out.push({
      code: '7.5',
      name: eroding.length ? 'Consent erosion' : 'Exit drill expiring',
      defeats: 'MC-4',
      detail: eroding.length
        ? `Disengagement cost rising for ${eroding.map((p) => p.label).join(', ')}. No exit path has been removed.`
        : `Exit last exercised ${Math.max(
            ...stale.map((p) => eco.epoch - p.exitDrillEpoch)
          )} intervals ago for ${stale
            .map((p) => p.label)
            .join(', ')}. MC-4 expires at ${DRILL_TTL}. No exit path has been removed.`,
      remediation: { kind: 'exit-drill', target: null },
    });
  }

  return out;
}

// ---------------------------------------------------------------
// The eighth agent. Proposes, and in autonomous mode applies.
// ---------------------------------------------------------------
function sentinel(eco, pathologies, mode, queue) {
  const actions = [];
  for (const p of pathologies) {
    const key = `${p.code}:${p.remediation.target || 'all'}`;
    if (queue.some((q) => q.key === key)) continue;
    const proposal = {
      key,
      epoch: eco.epoch,
      pathology: p.code,
      name: p.name,
      kind: p.remediation.kind,
      target: p.remediation.target,
      rationale: p.detail,
      status: mode === 'autonomous' ? 'applied' : 'awaiting approval',
    };
    if (mode === 'autonomous') {
      proposal.result = eco.applyRemediation(p.remediation);
    }
    actions.push(proposal);
  }
  return actions;
}

function runPipeline(eco, mode, queue) {
  const locus = locusAuditor(eco);
  const lineage = lineageMonitor(eco);
  const divergence = divergenceTracker(eco);
  const absorption = absorptionProber(eco);
  const interfaceW = interfaceWarden(eco);
  const provenance = provenanceVerifier(eco);
  const index = indexer(eco, { locus, lineage, divergence, absorption });
  const pathologies = pathologyWatch(eco, {
    locus,
    lineage,
    divergence,
    interfaceW,
    provenance,
  });
  const actions = sentinel(eco, pathologies, mode, queue);

  const conditions = {
    'MC-1': locus.pass && divergence.pass,
    'MC-2': lineage.pass && provenance.pass,
    'MC-3': absorption.results.every((r) => r.mc3),
    'MC-4': absorption.results.every((r) => r.mc4),
    'MC-5': interfaceW.pass,
  };

  return {
    agents: [locus, lineage, divergence, absorption, interfaceW, provenance, index],
    index,
    conditions,
    pathologies,
    actions,
  };
}

module.exports = { runPipeline, WEIGHTS, DRILL_TTL, DHL_HORIZON, LOCUS_DIMENSIONS };
