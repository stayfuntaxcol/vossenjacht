// js/bots/actionComboMatrix.js
// Action Combo Matrix V2 — inclusief SCOUT/kennis tiers
//
// Doel:
// - Data-only (makkelijk dagelijks uitbreiden)
// - Sparse matrix: alleen combos met echte synergy. Default = 0.
// - Scores per kennis-tier: NO_SCOUT / SOFT_SCOUT / HARD_SCOUT
//
// Kennis tiers (sluit aan op botHeuristics ctx):
// - NO_SCOUT: geen zekerheid over komende events (ctx.nextKnown=false en knownUpcomingEvents<1)
// - SOFT_SCOUT: 1 stuk zekerheid (ctx.nextKnown=true of knownUpcomingEvents>=1)
// - HARD_SCOUT: meerdere posities bekend (knownUpcomingEvents>=2)
//
// Belangrijk: HOLD_STILL als eerste kaart is altijd “anti” (blokkeert nieuwe actions).
// (cards.js: "Vanaf nu mogen deze ronde geen nieuwe Action Cards meer worden gespeeld; alleen PASS.")
//
// Context (ctx) velden die we gebruiken:
// ctx = {
//   nextKnown: boolean,
//   knownUpcomingEvents: string[],
//   nextEventFacts: { dangerDash, dangerLurk, dangerBurrow } | null,
//   lockEventsActive: boolean,
//   opsLockedActive: boolean,
//   discardActionIds: string[],   // bv. game.actionDiscardPile mapped naar ids
//   isLast: boolean,
//   scoreBehind: number
// }

export const ACTION_IDS = [
  "SCATTER",
  "DEN_SIGNAL",
  "NO_GO_ZONE",
  "KICK_UP_DUST",
  "BURROW_BEACON",
  "MOLTING_MASK",
  "HOLD_STILL",
  "NOSE_FOR_TROUBLE",
  "SCENT_CHECK",
  "FOLLOW_THE_TAIL",
  "ALPHA_CALL",
  "PACK_TINKER",
  "MASK_SWAP",
];

export function scoutTierFromCtx(ctx = {}) {
  const knownN = Array.isArray(ctx.knownUpcomingEvents) ? ctx.knownUpcomingEvents.length : 0;
  if (knownN >= 2) return "HARD_SCOUT";
  if (ctx.nextKnown || knownN >= 1) return "SOFT_SCOUT";
  return "NO_SCOUT";
}

export function dangerNextFromCtx(ctx = {}) {
  const f = ctx.nextEventFacts || null;
  if (!f) return 0;
  return Math.max(f.dangerDash || 0, f.dangerLurk || 0, f.dangerBurrow || 0);
}

// ------------------------------------------------------------
// Sparse combo matrix: A -> B
// score = { NO_SCOUT, SOFT_SCOUT, HARD_SCOUT }
// Optional fields:
// - requires: [ "COND", ... ]         (allemaal waar)
// - requiresNot: [ "COND", ... ]      (allemaal onwaar)
// - requiresDiscardHas: ["ACTION_ID"] (voor Pack Tinker enables)
// - notes: "..."                     (voor jou / future docs)
// ------------------------------------------------------------
export const ACTION_COMBO_MATRIX_V2 = {
  // =========================
  // INFO → COMMIT / DENY
  // =========================
  SCENT_CHECK: {
    FOLLOW_THE_TAIL: {
      score: { NO_SCOUT: 8, SOFT_SCOUT: 9, HARD_SCOUT: 10 },
      notes: "Peek decision → copy decision. Beste 2-card combo als je dezelfde target pakt.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      notes: "Peek → freeze actions zodat niemand jouw info-voordeel neutraliseert.",
    },
    SCATTER: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 8 },
      notes: "Peek → deny SCOUT (info advantage vasthouden).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      notes: "Peek → block 1 scout-positie (kleiner dan Scatter).",
    },
    ALPHA_CALL: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 4, HARD_SCOUT: 4 },
      notes: "Met info kun je lead slimmer verleggen (situational).",
    },
  },

  NOSE_FOR_TROUBLE: {
    // Nose is vaak “gok”, maar mét extra knowledge wordt hij betrouwbaarder.
    SCATTER: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Prediction edge → deny scout zodat anderen minder kunnen reageren/valideren.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Prediction edge → freeze actions (bescherm je voorsprong).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      notes: "Zwakkere deny variant na prediction.",
    },
    BURROW_BEACON: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      notes: "Lock events zodat anderen niet kunnen manipuleren nadat jij inzet op prediction.",
    },
  },

  // =========================
  // TRACK CHAOS → LOCK / FREEZE / DENY
  // =========================
  KICK_UP_DUST: {
    BURROW_BEACON: {
      score: { NO_SCOUT: 9, SOFT_SCOUT: 9, HARD_SCOUT: 9 },
      requiresNot: ["LOCK_EVENTS_ACTIVE"],
      notes: "Shuffle future events → lock track zodat niemand terugdraait (top combo).",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 8, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      notes: "Shuffle → freeze actions zodat niemand kan counteren in dezelfde ronde.",
    },
    SCATTER: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 7 },
      notes: "Shuffle → deny scout zodat niemand de nieuwe track kan ‘checken’ via SCOUT.",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      notes: "Shuffle → block 1 scout-positie.",
    },
    ALPHA_CALL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 3, HARD_SCOUT: 3 },
      notes: "Na chaos lead verleggen (situational).",
    },
  },

  BURROW_BEACON: {
    HOLD_STILL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 7, HARD_SCOUT: 8 },
      notes: "Lock track → freeze actions (double lock). Sterk als je al voordeel hebt (knowledge).",
    },
    SCATTER: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      notes: "Lock track → deny scout (bescherm je track-voordeel).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Lock track → block 1 scout-positie.",
    },
  },

  // =========================
  // DEN / COLOR CHAOS → DEFENSE / FREEZE
  // =========================
  MASK_SWAP: {
    DEN_SIGNAL: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      notes: "Na den shuffle → kies immunity kleur die jou/veel spelers helpt.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 7 },
      notes: "Na den shuffle → freeze actions zodat niemand countert met andere acties.",
    },
    SCATTER: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Na den shuffle → deny scout (klein).",
    },
  },

  MOLTING_MASK: {
    DEN_SIGNAL: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 7 },
      notes: "Eigen kleur verandert random → daarna immunity kiezen die bij nieuwe situatie past.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 5, HARD_SCOUT: 5 },
      notes: "Den change → freeze (anti-counter).",
    },
  },

  // =========================
  // DEFENSE → FREEZE / DENY (winst locken)
  // =========================
  DEN_SIGNAL: {
    HOLD_STILL: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 7 },
      notes: "Immunity neerzetten → freeze actions zodat niemand later nog ‘trucjes’ doet.",
    },
    SCATTER: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Als jij beschermd bent én je hebt knowledge, dan scout-deny is extra waardevol.",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      notes: "Kleinere scout-deny variant.",
    },
  },

  // =========================
  // LEAD CONTROL → FREEZE / DENY
  // =========================
  ALPHA_CALL: {
    HOLD_STILL: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      notes: "Lead zetten → freeze actions zodat niemand lead/counters kan spelen.",
    },
    SCATTER: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Lead zetten + info denial (situational).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      notes: "Lead zetten + block 1 scout-spot.",
    },
  },

  // =========================
  // PACK TINKER = DISCARD ENABLE (haal B uit discard → speel direct)
  // Let op: Pack Tinker zelf is utility. Synergy is vooral "fetch finisher".
  // =========================
  PACK_TINKER: {
    HOLD_STILL: {
      score: { NO_SCOUT: 8, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      requiresDiscardHas: ["HOLD_STILL"],
      notes: "Fetch Hold Still → speel direct als finisher (zeer sterk).",
    },
    DEN_SIGNAL: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 7, HARD_SCOUT: 8 },
      requiresDiscardHas: ["DEN_SIGNAL"],
      notes: "Fetch Den Signal → direct defense.",
    },
    BURROW_BEACON: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      requiresDiscardHas: ["BURROW_BEACON"],
      notes: "Fetch Burrow Beacon → direct lock events (sterk bij knowledge).",
    },
    KICK_UP_DUST: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 6, HARD_SCOUT: 7 },
      requiresDiscardHas: ["KICK_UP_DUST"],
      requiresNot: ["LOCK_EVENTS_ACTIVE"],
      notes: "Fetch Kick Up Dust → direct chaos (vooral hail-mary / emergency).",
    },
    MASK_SWAP: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresDiscardHas: ["MASK_SWAP"],
      notes: "Fetch Mask Swap → direct den chaos.",
    },
    SCENT_CHECK: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      requiresDiscardHas: ["SCENT_CHECK"],
      notes: "Fetch Scent Check → direct info.",
    },
    FOLLOW_THE_TAIL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      requiresDiscardHas: ["FOLLOW_THE_TAIL"],
      notes: "Fetch Follow the Tail → direct commit (ideal met info).",
    },
    SCATTER: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 6, HARD_SCOUT: 7 },
      requiresDiscardHas: ["SCATTER"],
      notes: "Fetch Scatter → direct info denial (sterker met knowledge).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresDiscardHas: ["NO_GO_ZONE"],
      notes: "Fetch No-Go Zone → direct block scout spot.",
    },
    ALPHA_CALL: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresDiscardHas: ["ALPHA_CALL"],
      notes: "Fetch Alpha Call → direct lead control.",
    },
  },

  // =========================
  // DENY STACK (meestal klein / overkill)
  // =========================
  SCATTER: {
    HOLD_STILL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      notes: "Deny scout → daarna freeze actions (situational).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 2, HARD_SCOUT: 2 },
      notes: "Overkill: beide zijn denial.",
    },
  },

  NO_GO_ZONE: {
    HOLD_STILL: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 2, HARD_SCOUT: 3 },
      notes: "Kleine denial → daarna freeze actions.",
    },
    SCATTER: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 2, HARD_SCOUT: 2 },
      notes: "Overkill: beide zijn denial.",
    },
  },

  // =========================
  // FOLLOW_THE_TAIL als opener (meestal niet)
  // =========================
  FOLLOW_THE_TAIL: {
    // Geen echte follow-ups die beter worden door Follow als eerste.
  },

  // HOLD_STILL: bewust leeg (anti-combo als opener)
  HOLD_STILL: {},
};

// ------------------------------------------------------------
// Anti-combo lijst (hard negatief) — voor evaluators
// ------------------------------------------------------------
export const ACTION_COMBO_NEG_V2 = [
  { a: "HOLD_STILL", b: "*", score: -10, notes: "Hold Still blokkeert verdere actions deze ronde." },

  { a: "BURROW_BEACON", b: "KICK_UP_DUST", score: -9, notes: "Kick Up Dust is BLOCKED_BY_LOCK (lockEvents actief)." },

  { a: "DEN_SIGNAL", b: "MOLTING_MASK", score: -6, notes: "Den Signal → daarna kleur wijzigen: je protection kan misvallen." },
  { a: "DEN_SIGNAL", b: "MASK_SWAP", score: -6, notes: "Den Signal → daarna den shuffle: protection wordt onbetrouwbaar." },
];

// ------------------------------------------------------------
// Helper: combo score A→B met ctx checks
// ------------------------------------------------------------
function condValue(cond, ctx) {
  // cond strings: "LOCK_EVENTS_ACTIVE", "OPS_LOCKED_ACTIVE"
  if (cond === "LOCK_EVENTS_ACTIVE") return !!ctx.lockEventsActive;
  if (cond === "OPS_LOCKED_ACTIVE") return !!ctx.opsLockedActive;
  return false;
}

export function comboScore(aId, bId, ctx = {}) {
  if (!aId || !bId) return 0;

  // hard neg: Hold Still blocks
  if (aId === "HOLD_STILL") return -10;

  // apply neg list
  for (const neg of ACTION_COMBO_NEG_V2) {
    if (neg.a === aId && (neg.b === bId || neg.b === "*")) return neg.score;
  }

  const rec = ACTION_COMBO_MATRIX_V2?.[aId]?.[bId];
  if (!rec) return 0;

  // requiresNot
  if (Array.isArray(rec.requiresNot)) {
    for (const c of rec.requiresNot) if (condValue(c, ctx)) return 0;
  }

  // requiresDiscardHas
  if (Array.isArray(rec.requiresDiscardHas) && rec.requiresDiscardHas.length) {
    const disc = Array.isArray(ctx.discardActionIds) ? ctx.discardActionIds : [];
    const ok = rec.requiresDiscardHas.some((need) => disc.includes(need));
    if (!ok) return 1; // mini-score: Pack Tinker kan nog steeds hand verbeteren
  }

  // score per tier
  const tier = scoutTierFromCtx(ctx);
  const base = rec.score?.[tier] ?? rec.score?.NO_SCOUT ?? 0;

  // kleine situational boost: hoge dangerNext maakt “freeze/defense/lock” iets waardevoller
  const danger = dangerNextFromCtx(ctx);
  let bonus = 0;
  if (danger >= 7 && (bId === "HOLD_STILL" || bId === "DEN_SIGNAL" || bId === "BURROW_BEACON")) bonus += 1;

  // hail-mary boost: als last/behind, chaos combos iets waardevoller
  if ((ctx.isLast || (ctx.scoreBehind || 0) >= 6) && (aId === "PACK_TINKER" || aId === "KICK_UP_DUST")) bonus += 1;

  return base + bonus;
}
