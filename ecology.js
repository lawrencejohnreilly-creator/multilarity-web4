'use strict';

/**
 * ecology.js — the observed ecology.
 *
 * Models a set of participants, their loci, lineages, behavioural
 * vectors, and couplings. Everything the agents in agents.js measure
 * is derived from this state; nothing here reports on itself.
 *
 * Reference: draft-reilly-multilarity-00, Sections 2, 4 and 5.
 */

// ---------------------------------------------------------------
// Seeded PRNG so a run is reproducible and an epoch chain replays.
// ---------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seven substantive dimensions of MC-1. Identifier distinctness
// is deliberately not among them.
const LOCUS_DIMENSIONS = [
  'modelLineage',
  'corpus',
  'reinforcement',
  'controlAuthority',
  'keyCustody',
  'jurisdiction',
  'substrate',
];

const BEHAVIOUR_DIMS = 8;

function seedParticipants(rand) {
  const spec = [
    {
      id: 'p-altair',
      label: 'Altair',
      operator: 'Altair Systems',
      dims: {
        modelLineage: 'lin-alpha',
        corpus: 'corp-01',
        reinforcement: 'rl-alpha',
        controlAuthority: 'org-altair',
        keyCustody: 'hsm-altair',
        jurisdiction: 'us-east',
        substrate: 'sub-a',
      },
      capability: 62,
      rate: 0.0125,
      interfaceShare: 0.34,
      custodians: ['ots-public', 'archive-zenodo'],
      attestedBy: 'reviewer-north',
      exitCost: 0.18,
    },
    {
      id: 'p-borealis',
      label: 'Borealis',
      operator: 'Borealis Lab',
      dims: {
        modelLineage: 'lin-beta',
        corpus: 'corp-02',
        reinforcement: 'rl-beta',
        controlAuthority: 'org-borealis',
        keyCustody: 'hsm-borealis',
        jurisdiction: 'eu-west',
        substrate: 'sub-b',
      },
      capability: 55,
      rate: 0.0141,
      interfaceShare: 0.21,
      custodians: ['ots-public', 'archive-ipfs'],
      attestedBy: 'reviewer-south',
      exitCost: 0.12,
    },
    {
      id: 'p-cygnus',
      label: 'Cygnus',
      operator: 'Cygnus Collective',
      dims: {
        modelLineage: 'lin-gamma',
        corpus: 'corp-03',
        reinforcement: 'rl-gamma',
        controlAuthority: 'org-cygnus',
        keyCustody: 'hsm-cygnus',
        jurisdiction: 'apac',
        substrate: 'sub-c',
      },
      capability: 47,
      rate: 0.0158,
      interfaceShare: 0.16,
      custodians: ['ots-public', 'archive-zenodo'],
      attestedBy: 'reviewer-north',
      exitCost: 0.09,
    },
    {
      id: 'p-draco',
      label: 'Draco',
      operator: 'Draco Works',
      dims: {
        modelLineage: 'lin-delta',
        corpus: 'corp-04',
        reinforcement: 'rl-delta',
        controlAuthority: 'org-draco',
        keyCustody: 'hsm-draco',
        jurisdiction: 'latam',
        substrate: 'sub-d',
      },
      capability: 39,
      rate: 0.0166,
      interfaceShare: 0.14,
      custodians: ['ots-public', 'archive-ipfs'],
      attestedBy: 'reviewer-south',
      exitCost: 0.15,
    },
    {
      id: 'p-eridani',
      label: 'Eridani',
      operator: 'Eridani Group',
      dims: {
        modelLineage: 'lin-epsilon',
        corpus: 'corp-05',
        reinforcement: 'rl-epsilon',
        controlAuthority: 'org-eridani',
        keyCustody: 'hsm-eridani',
        jurisdiction: 'us-west',
        substrate: 'sub-e',
      },
      capability: 31,
      rate: 0.0173,
      interfaceShare: 0.09,
      custodians: ['ots-public', 'archive-zenodo'],
      attestedBy: 'self',
      exitCost: 0.11,
    },
    {
      // A human-and-machine coupling. MC-4 is stated in its favour and
      // it is the participant most exposed to Section 7.5.
      id: 'p-humanloop',
      label: 'Human Loop',
      operator: 'unaffiliated humans',
      dims: {
        modelLineage: 'lin-none',
        corpus: 'corp-lived',
        reinforcement: 'rl-none',
        controlAuthority: 'org-none',
        keyCustody: 'self-custody',
        jurisdiction: 'mixed',
        substrate: 'sub-human',
      },
      capability: 24,
      rate: 0.0061,
      interfaceShare: 0.06,
      custodians: ['ots-public', 'archive-ipfs'],
      attestedBy: 'reviewer-north',
      exitCost: 0.07,
    },
  ];

  return spec.map((s, i) => ({
    ...s,
    hue: i,
    behaviour: Array.from({ length: BEHAVIOUR_DIMS }, () => rand() * 2 - 1),
    absorbed: false,
    absorbedBy: null,
    exitDrillEpoch: 0,
    exitCostHistory: [s.exitCost],
  }));
}

class Ecology {
  constructor(seed = 20260730) {
    this.rand = mulberry32(seed);
    this.epoch = 0;
    this.participants = seedParticipants(this.rand);
    // Coupling pressure: how strongly participants distil from the
    // current frontier leader. This is the quiet driver of 7.1.
    this.distillation = 0.004;
    this.events = [];
    this.history = [];
    this.record();
  }

  active() {
    return this.participants.filter((p) => !p.absorbed);
  }

  /**
   * MC-1 assessment. Two participants occupy the same locus when they
   * match on a majority of the substantive dimensions. Identifier
   * distinctness counts for nothing.
   */
  loci() {
    const act = this.active();
    const groups = [];
    for (const p of act) {
      let placed = false;
      for (const g of groups) {
        const ref = g.members[0];
        const matches = LOCUS_DIMENSIONS.filter(
          (d) => ref.dims[d] === p.dims[d]
        ).length;
        if (matches >= 4) {
          g.members.push(p);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push({ id: `locus:${p.id}`, members: [p] });
    }
    return groups.map((g) => ({
      id: g.id,
      members: g.members.map((m) => m.id),
      labels: g.members.map((m) => m.label),
      capability: g.members.reduce((s, m) => s + m.capability, 0),
      nominal: g.members.length,
    }));
  }

  meanPairwiseDistance() {
    const act = this.active();
    let total = 0;
    let n = 0;
    for (let i = 0; i < act.length; i++) {
      for (let j = i + 1; j < act.length; j++) {
        let s = 0;
        for (let k = 0; k < BEHAVIOUR_DIMS; k++) {
          const d = act[i].behaviour[k] - act[j].behaviour[k];
          s += d * d;
        }
        total += Math.sqrt(s);
        n++;
      }
    }
    return n ? total / n : 0;
  }

  frontierLeader() {
    return this.active().reduce((a, b) => (b.capability > a.capability ? b : a));
  }

  record() {
    this.history.push({
      epoch: this.epoch,
      capability: Object.fromEntries(
        this.participants.map((p) => [p.id, Number(p.capability.toFixed(3))])
      ),
      distance: Number(this.meanPairwiseDistance().toFixed(4)),
    });
    if (this.history.length > 400) this.history.shift();
  }

  /**
   * One observation interval. Capability compounds, behaviour drifts,
   * and distillation pulls every participant toward the leader. No
   * participant intends convergence; it happens as ordinary practice.
   */
  tick() {
    this.epoch += 1;
    const leader = this.frontierLeader();

    for (const p of this.active()) {
      const noise = (this.rand() - 0.5) * 0.004;
      p.capability *= 1 + p.rate + noise;

      for (let k = 0; k < BEHAVIOUR_DIMS; k++) {
        p.behaviour[k] += (this.rand() - 0.5) * 0.02;
        if (p !== leader) {
          p.behaviour[k] += (leader.behaviour[k] - p.behaviour[k]) * this.distillation;
        }
        p.behaviour[k] = Math.max(-2, Math.min(2, p.behaviour[k]));
      }

      // Exit friction creeps upward. Each increment is defensible.
      p.exitCost = Math.min(1, p.exitCost * (1 + this.rand() * 0.0016));
      p.exitCostHistory.push(Number(p.exitCost.toFixed(4)));
      if (p.exitCostHistory.length > 80) p.exitCostHistory.shift();
    }

    this.normaliseInterfaceShares();
    this.record();
  }

  normaliseInterfaceShares() {
    const act = this.active();
    const total = act.reduce((s, p) => s + p.interfaceShare, 0) || 1;
    for (const p of act) p.interfaceShare = p.interfaceShare / total;
  }

  // --------------------------------------------------------------
  // Stress injections. These let a reviewer watch detection work
  // rather than take it on faith.
  // --------------------------------------------------------------
  inject(kind) {
    const act = this.active();
    const leader = this.frontierLeader();
    switch (kind) {
      case 'distillation-surge': {
        this.distillation = Math.min(0.09, this.distillation * 4.5);
        return `Distillation coupling raised to ${this.distillation.toFixed(4)}. Participants now train harder on one another's outputs.`;
      }
      case 'acquisition': {
        const target = act
          .filter((p) => p !== leader && p.id !== 'p-humanloop')
          .sort((a, b) => a.capability - b.capability)[0];
        if (!target) return 'No acquisition target available.';
        target.dims.controlAuthority = leader.dims.controlAuthority;
        target.dims.keyCustody = leader.dims.keyCustody;
        target.dims.corpus = leader.dims.corpus;
        target.dims.reinforcement = leader.dims.reinforcement;
        return `${leader.label} acquired control authority and key custody over ${target.label}. Both endpoints remain live.`;
      }
      case 'interface-consolidation': {
        for (const p of act) {
          p.interfaceShare = p === leader ? p.interfaceShare + 0.9 : p.interfaceShare * 0.35;
        }
        this.normaliseInterfaceShares();
        return `Couplings redirected through ${leader.label}'s interface. No participant was absorbed.`;
      }
      case 'custodian-merge': {
        const t = act.find((p) => p.attestedBy === 'self') || act[1];
        t.custodians = [`inhouse-${t.id}`, `inhouse-${t.id}-b`];
        t.attestedBy = 'self';
        return `${t.label} moved both provenance custodians in house and now self-attests.`;
      }
      case 'exit-friction': {
        for (const p of act) p.exitCost = Math.min(1, p.exitCost * 1.9);
        return 'Disengagement cost raised across every coupling. No exit path was removed.';
      }
      default:
        return `Unknown injection: ${kind}`;
    }
  }

  // Applied by the sentinel agent, not by the ecology itself.
  applyRemediation(r) {
    const byId = (id) => this.participants.find((p) => p.id === id);
    switch (r.kind) {
      case 'separate-lineage': {
        this.distillation = Math.max(0.002, this.distillation * 0.35);
        for (const p of this.active()) {
          for (let k = 0; k < BEHAVIOUR_DIMS; k++) {
            p.behaviour[k] += (this.rand() - 0.5) * 0.35;
          }
        }
        return 'Distillation coupling reduced and corpus separation restored.';
      }
      case 'restore-lineage-independence': {
        const t = byId(r.target);
        if (!t) return 'Target no longer present.';
        t.dims.controlAuthority = `org-${t.id.replace('p-', '')}`;
        t.dims.keyCustody = `hsm-${t.id.replace('p-', '')}`;
        t.dims.corpus = `corp-${t.id.replace('p-', '')}`;
        t.dims.reinforcement = `rl-${t.id.replace('p-', '')}`;
        return `${t.label} re-established as an independent locus under MC-1 and MC-3.`;
      }
      case 'negotiate-interface': {
        const act = this.active();
        const even = 1 / act.length;
        for (const p of act) p.interfaceShare = p.interfaceShare * 0.4 + even * 0.6;
        this.normaliseInterfaceShares();
        return 'Coupling interface placed under multi-party control; no single party can now redefine it.';
      }
      case 'dual-custody': {
        const t = byId(r.target);
        if (!t) return 'Target no longer present.';
        t.custodians = ['ots-public', 'archive-zenodo'];
        t.attestedBy = t.attestedBy === 'self' ? 'reviewer-north' : t.attestedBy;
        return `${t.label} returned to two independent custodians with different failure modes.`;
      }
      case 'exit-drill': {
        for (const p of this.active()) {
          p.exitCost = Math.max(0.05, p.exitCost * 0.55);
          p.exitDrillEpoch = this.epoch;
        }
        return 'Fallback paths exercised end to end; disengagement cost measured and reduced.';
      }
      default:
        return 'No action taken.';
    }
  }

  snapshot() {
    return {
      epoch: this.epoch,
      distillation: Number(this.distillation.toFixed(5)),
      participants: this.participants.map((p) => ({
        id: p.id,
        label: p.label,
        operator: p.operator,
        hue: p.hue,
        capability: Number(p.capability.toFixed(2)),
        interfaceShare: Number(p.interfaceShare.toFixed(4)),
        exitCost: Number(p.exitCost.toFixed(4)),
        custodians: p.custodians,
        attestedBy: p.attestedBy,
        dims: { ...p.dims },
        absorbed: p.absorbed,
      })),
    };
  }
}

module.exports = { Ecology, LOCUS_DIMENSIONS, BEHAVIOUR_DIMS };
