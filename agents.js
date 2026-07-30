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

// MC-1 fails below DHL_FAIL and only recovers above DHL_RECOVER. The gap is
// hysteresis: a fitted half-life wobbles by a few intervals run to run, and a
// condition that toggles green-red-green on that noise teaches a reader to
// ignore it. The same DHL_FAIL value drives pathology 7.1, so every half-life
// short enough to fail MC-1 also raises a finding the sentinel can act on —
// no band where the verdict is red and nothing is flagged.
const DHL_FAIL = 180;
const DHL_RECOVER = 200;

// Effective-lineage count gets the same treatment for the same reason. LD is
// an inverse-HHI over capability shares and moves continuously, so a single
// threshold makes MC-2 chatter on rounding.
const LD_FAIL = 2.5;
const LD_RECOVER = 2.75;

// A remediation that runs every interval and reports success every interval
// is indistinguishable from one that does nothing. Each proposal is therefore
// scored against the number it claims to move: if that number is unchanged
// across ESCALATE_AFTER consecutive applications, the sentinel stops
// reporting success and says so. COOLDOWN keeps a standing correction from
// filling the log with identical lines while it works.
const REMEDIATION_COOLDOWN = 10;
const ESCALATE_AFTER = 25;
const ESCALATED_CADENCE = 100;
const PROBE_EPSILON = 1e-3;

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
  const ld = shares.size ? 1 / hhi : 0;

  // With k distinct lineages present, inverse-HHI is bounded above by k, and
  // reaches k only at perfectly balanced capability. If k itself sits below
  // the pass threshold then no redistribution of capability can satisfy the
  // condition — the instrument is asking the ecology for something it does
  // not contain, and a remediation that shuffles shares will run forever
  // without closing the gap. Published so that case is legible instead of
  // presenting as an ordinary red.
  const distinctLineages = shares.size;
  const ldCeiling = distinctLineages;
  const ldReachable = ldCeiling >= LD_FAIL;

  // The participant holding the most capability inside the largest lineage is
  // the one whose separation moves LD furthest. Naming it gives pathology 7.1
  // a concrete subject rather than a null target the ecology cannot act on.
  let dominantLineage = null;
  let dominantShare = -1;
  for (const [k, v] of shares) {
    if (v > dominantShare) {
      dominantShare = v;
      dominantLineage = k;
    }
  }
  const inDominant = act
    .filter((p) => p.dims.modelLineage === dominantLineage)
    .sort((a, b) => b.capability - a.capability);
  const dominantMember = inDominant.length ? inDominant[0].id : null;

  // Hysteresis, on the same reasoning as DHL. The latch lives on the ecology
  // so the verdict depends on the observed shares and its own prior state.
  const held = eco.ldConditionHeld !== false;
  const pass = ld >= (held ? LD_FAIL : LD_RECOVER);
  eco.ldConditionHeld = pass;

  return {
    agent: 'LINEAGE-MONITOR',
    condition: 'MC-2',
    ld: Number(ld.toFixed(3)),
    ldFail: LD_FAIL,
    ldRecover: LD_RECOVER,
    distinctLineages,
    ldCeiling,
    ldReachable,
    dominantLineage,
    dominantMember,
    lineages: [...shares.entries()].map(([k, v]) => ({
      lineage: k,
      share: Number(v.toFixed(3)),
    })),
    pass,
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

  // Hysteresis. Once the condition is holding, only a fit below DHL_FAIL
  // breaks it; once broken, it takes DHL_RECOVER to clear. The latch lives on
  // the ecology so the verdict depends on the observed series and its own
  // prior state, never on a self-report.
  let pass;
  if (status !== 'measured') {
    pass = true;
  } else {
    const held = eco.dhlConditionHeld !== false;
    pass = held ? dhlDays >= DHL_FAIL : dhlDays >= DHL_RECOVER;
  }
  eco.dhlConditionHeld = pass;

  return {
    agent: 'DIVERGENCE-TRACKER',
    condition: 'MC-1',
    dhlDays: dhlDays === null ? null : Number(dhlDays.toFixed(1)),
    dhlStatus: status,
    dhlHorizon: DHL_HORIZON,
    dhlTerm: term === null ? null : Number(term.toFixed(3)),
    dhlFail: DHL_FAIL,
    dhlRecover: DHL_RECOVER,
    distance: window.length ? window[window.length - 1].distance : 0,
    trend,
    pass,
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
    passingCount: results.filter((r) => r.pass).length,
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

  // The LD term is normalised against locus count while LD itself counts
  // lineages. When fewer lineages than loci are present the term cannot reach
  // 1 however the ecology is arranged, so the achievable ceiling is published
  // beside it rather than left for the reader to derive.
  const ldTermCeiling = Number(
    Math.max(0, Math.min(1, (lineage.ldCeiling - 1) / (n - 1))).toFixed(4)
  );

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
    ldCeiling: lineage.ldCeiling,
    ldTermCeiling,
    distinctLineages: lineage.distinctLineages,
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
    divergence.dhlStatus === 'measured' && divergence.dhlDays < DHL_FAIL;
  const lineagesShort = lineage.ld < LD_FAIL;
  if (lineagesShort || halfLifeShort) {
    const dhlText =
      divergence.dhlStatus === 'measured'
        ? `${divergence.dhlDays}d`
        : `undefined (${divergence.dhlStatus})`;
    // Which condition this finding actually defeats depends on which trigger
    // fired. Effective-lineage count gates MC-2; the fitted half-life gates
    // MC-1. Attributing both to MC-1 sends a reader looking at the wrong
    // verdict while the other one stays red.
    const defeats = [];
    if (lineagesShort) defeats.push('MC-2');
    if (halfLifeShort) defeats.push('MC-1');
    out.push({
      code: '7.1',
      name: 'Lineage collapse',
      defeats: defeats.join(' / '),
      detail: `Effective lineages ${lineage.ld} of ${lineage.distinctLineages} distinct, divergence half-life ${dhlText} and ${divergence.trend}. Endpoint count is unchanged.`,
      // Separating capability out of the dominant lineage is the lever that
      // moves LD; the sentinel is told which participant to move.
      remediation: { kind: 'separate-lineage', target: lineage.dominantMember },
      blocked: lineagesShort && !lineage.ldReachable,
      blockedReason: `MC-2 cannot be satisfied by remediation: ${lineage.distinctLineages} distinct lineage(s) present, inverse-HHI ceiling ${lineage.ldCeiling}, threshold ${LD_FAIL}. Redistributing capability cannot close this — a further lineage must enter the ecology.`,
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
// Remediation accounting
// ---------------------------------------------------------------
// Each remediation kind claims to move exactly one measured quantity. The
// probe is that quantity, sampled before the correction is applied, so the
// next interval can ask whether the previous application did anything.
function probeFor(kind, parts) {
  const { locus, lineage, interfaceW, absorption, provenance } = parts;
  switch (kind) {
    case 'separate-lineage':
      return lineage.ld;
    case 'restore-lineage-independence':
      return locus.locusCount;
    case 'dual-custody':
      return provenance.passingCount;
    case 'negotiate-interface':
      return interfaceW.share;
    case 'exit-drill':
      return absorption.ar;
    default:
      return null;
  }
}

const PROBE_LABEL = {
  'separate-lineage': 'effective lineages (LD)',
  'restore-lineage-independence': 'distinct loci',
  'dual-custody': 'participants passing dual custody',
  'negotiate-interface': 'top interface share',
  'exit-drill': 'absorption resistance (AR)',
};

// ---------------------------------------------------------------
// The eighth agent. Proposes, and in autonomous mode applies.
// ---------------------------------------------------------------
function sentinel(eco, pathologies, mode, queue, parts) {
  if (!eco.remediationLedger) eco.remediationLedger = Object.create(null);
  const ledger = eco.remediationLedger;
  const actions = [];

  for (const p of pathologies) {
    const key = `${p.code}:${p.remediation.target || 'all'}`;
    if (queue.some((q) => q.key === key)) continue;

    const base = {
      key,
      epoch: eco.epoch,
      pathology: p.code,
      name: p.name,
      defeats: p.defeats,
      kind: p.remediation.kind,
      target: p.remediation.target,
      rationale: p.detail,
    };

    if (mode !== 'autonomous') {
      actions.push({ ...base, status: 'awaiting approval' });
      continue;
    }

    const rec =
      ledger[key] ||
      (ledger[key] = {
        applications: 0,
        ineffective: 0,
        lastProbe: null,
        lastLoggedEpoch: -Infinity,
        escalationLogged: false,
      });

    const probe = probeFor(p.remediation.kind, parts);

    // Did the previous application move the number it exists to move?
    let effect = 'unmeasured';
    if (rec.lastProbe !== null && probe !== null) {
      effect =
        Math.abs(probe - rec.lastProbe) < PROBE_EPSILON ? 'no-change' : 'moved';
    }
    if (effect === 'no-change') {
      rec.ineffective += 1;
    } else if (effect === 'moved') {
      rec.ineffective = 0;
      rec.escalationLogged = false;
    }

    const escalated = rec.ineffective >= ESCALATE_AFTER;
    const firstEscalation = escalated && !rec.escalationLogged;

    // A finding the ecology cannot close is not applied. Attempting it every
    // interval and reporting success is the failure mode this guard exists
    // to remove.
    if (p.blocked) {
      const cadence = ESCALATED_CADENCE;
      if (eco.epoch - rec.lastLoggedEpoch < cadence) continue;
      rec.lastLoggedEpoch = eco.epoch;
      actions.push({
        ...base,
        status: 'blocked',
        effect: 'not-applicable',
        applications: rec.applications,
        result: p.blockedReason,
      });
      continue;
    }

    const raw = eco.applyRemediation(p.remediation);
    rec.applications += 1;
    rec.lastProbe = probe;

    const cadence = escalated ? ESCALATED_CADENCE : REMEDIATION_COOLDOWN;
    const due = firstEscalation || eco.epoch - rec.lastLoggedEpoch >= cadence;
    if (!due) continue;
    if (firstEscalation) rec.escalationLogged = true;
    rec.lastLoggedEpoch = eco.epoch;

    const label = PROBE_LABEL[p.remediation.kind] || 'target indicator';
    actions.push({
      ...base,
      status: escalated ? 'ineffective' : 'applied',
      effect,
      applications: rec.applications,
      ineffectiveStreak: rec.ineffective,
      probe: probe === null ? null : Number(probe.toFixed(3)),
      result: escalated
        ? `remediation ineffective — ${label} unchanged at ${Number(
            probe
          ).toFixed(3)} across ${rec.ineffective} consecutive applications`
        : raw,
    });
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
  const parts = { locus, lineage, divergence, absorption, interfaceW, provenance };
  const index = indexer(eco, parts);
  const pathologies = pathologyWatch(eco, parts);
  const actions = sentinel(eco, pathologies, mode, queue, parts);

  const conditions = {
    'MC-1': locus.pass && divergence.pass,
    'MC-2': lineage.pass && provenance.pass,
    'MC-3': absorption.results.every((r) => r.mc3),
    'MC-4': absorption.results.every((r) => r.mc4),
    'MC-5': interfaceW.pass,
  };

  // Why each red is red, at the granularity of the agent that produced it.
  // A condition gated by two agents is otherwise indistinguishable from one,
  // and a reader watching a remediation run against the wrong half has no
  // way to see it from the verdict alone.
  const attribution = {
    'MC-1': { locus: locus.pass, divergence: divergence.pass },
    'MC-2': {
      lineage: lineage.pass,
      provenance: provenance.pass,
      lineageReachable: lineage.ldReachable,
    },
    'MC-3': { absorption: conditions['MC-3'] },
    'MC-4': { absorption: conditions['MC-4'] },
    'MC-5': { interface: interfaceW.pass },
  };

  return {
    agents: [locus, lineage, divergence, absorption, interfaceW, provenance, index],
    index,
    conditions,
    attribution,
    pathologies,
    actions,
  };
}

module.exports = {
  runPipeline,
  WEIGHTS,
  DRILL_TTL,
  DHL_HORIZON,
  DHL_FAIL,
  DHL_RECOVER,
  LD_FAIL,
  LD_RECOVER,
  ESCALATE_AFTER,
  REMEDIATION_COOLDOWN,
  LOCUS_DIMENSIONS,
};
