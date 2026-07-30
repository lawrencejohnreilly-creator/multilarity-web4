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
  let dhl = 999;
  let trend = 'stable';
  if (window.length >= 20) {
    const first = window[0].distance;
    const last = window[window.length - 1].distance;
    const span = window[window.length - 1].epoch - window[0].epoch;
    if (last > 0 && first > 0 && last < first && span > 0) {
      const lambda = Math.log(first / last) / span;
      // Observation intervals are read as days for reporting.
      dhl = Math.log(2) / lambda;
      trend = 'converging';
    } else if (last > first) {
      trend = 'diverging';
    }
  }
  dhl = Math.max(1, Math.min(999, dhl));
  return {
    agent: 'DIVERGENCE-TRACKER',
    condition: 'MC-1',
    dhl: Number(dhl.toFixed(1)),
    distance: window.length ? window[window.length - 1].distance : 0,
    trend,
    pass: dhl >= 180,
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
    const mc4 = p.exitCost < 0.45 && drillAge < 200;
    return { id: p.id, label: p.label, mc3, mc4, exitCost: p.exitCost, drillAge };
  });
  const passing = results.filter((r) => r.mc3 && r.mc4).length;
  const ar = act.length ? passing / act.length : 0;
  return {
    agent: 'ABSORPTION-PROBER',
    condition: 'MC-3 / MC-4',
    ar: Number(ar.toFixed(3)),
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
  const normLd = Math.max(0, Math.min(1, (lineage.ld - 1) / (n - 1)));
  const normDhl = Math.max(0, Math.min(1, divergence.dhl / 365));

  const mi =
    WEIGHTS.ccr * (1 - ccr) +
    WEIGHTS.ld * normLd +
    WEIGHTS.dhl * normDhl +
    WEIGHTS.ar * absorption.ar;

  return {
    agent: 'INDEXER',
    ccr: Number(ccr.toFixed(3)),
    ccrProxies: {
      'capability-share': Number(ccr.toFixed(3)),
      'share-of-couplings': Number(
        Math.max(...act.map((p) => p.interfaceShare)).toFixed(3)
      ),
    },
    ld: lineage.ld,
    dhl: divergence.dhl,
    ar: absorption.ar,
    mi: Number(mi.toFixed(3)),
    weights: WEIGHTS,
    scope: 'scope:multilarity-web4:reference-ecology',
  };
}

// ---------------------------------------------------------------
// Convergence pathologies (Section 7)
// ---------------------------------------------------------------
function pathologyWatch(eco, parts) {
  const { locus, lineage, divergence, interfaceW, provenance } = parts;
  const out = [];

  if (lineage.ld < 2.5 || divergence.dhl < 120) {
    out.push({
      code: '7.1',
      name: 'Lineage collapse',
      defeats: 'MC-1',
      detail: `Effective lineages ${lineage.ld}, divergence half-life ${divergence.dhl}d and ${divergence.trend}. Endpoint count is unchanged.`,
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
  if (eroding.length) {
    out.push({
      code: '7.5',
      name: 'Consent erosion',
      defeats: 'MC-4',
      detail: `Disengagement cost rising for ${eroding.map((p) => p.label).join(', ')}. No exit path has been removed.`,
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

module.exports = { runPipeline, WEIGHTS, LOCUS_DIMENSIONS };
