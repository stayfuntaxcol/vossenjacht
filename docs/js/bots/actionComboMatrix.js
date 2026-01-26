// js/bots/actionComboMatrix.js
// Action Combo Matrix V2.1 — fix requires + extra synergies
//
// Doel:
// - Data-only (makkelijk dagelijks uitbreiden)
// - Sparse matrix: alleen combos met echte synergy. Default = 0.
// - Scores per kennis-tier: NO_SCOUT / SOFT_SCOUT / HARD_SCOUT
//
// Kennis tiers (sluit aan op botHeuristics ctx):
// - NO_SCOUT: geen zekerheid over komende events
// - SOFT_SCOUT: 1 stuk zekerheid
// - HARD_SCOUT: meerdere posities bekend
//
// Belangrijk:
// - HOLD_STILL als eerste kaart is altijd “anti” (blokkeert nieuwe actions).
// - KICK_UP_DUST is BLOCKED_BY_LOCK (werkt niet als lockEvents actief is).
//
// Context (ctx) velden die we gebruiken:
// ctx = {
//   nextKnown: boolean,
//   knownUpcomingEvents: string[],
//   nextEventFacts: { dangerDash, dangerLurk, dangerBurrow } | null,
//   lockEventsActive: boolean,
//   opsLockedActive: boolean,
//   discardActionIds: string[],
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
  // CANON: "dangerNext" for OPS/action valuation must reflect STAY-risk,
  // not peak(DASH,LURK,BURROW). Peak breaks things like SHEEPDOG_PATROL
  // (where DASH is risky but LURK is safe).
  const f = ctx.nextEventFacts || null;
  if (!f) return 0;
  const lurk = Number(f.dangerLurk || 0);
  const burrow = Number(f.dangerBurrow || 0);

  // Staying risk: if BURROW is your lifeline, you still prefer to make LURK safe in OPS.
  // Use LURK-danger as primary driver; BURROW-danger only matters if it's worse than LURK.
  const stay = Math.max(0, lurk);
  const bur = Math.max(0, burrow);
  return stay;
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
  // INFO → COMMIT / DEFENSE / DENY
  // =========================
  SCENT_CHECK: {
    FOLLOW_THE_TAIL: {
      score: { NO_SCOUT: 8, SOFT_SCOUT: 9, HARD_SCOUT: 10 },
      notes: "Peek decision → copy decision. Beste 2-card combo als je dezelfde target pakt.",
    },
    DEN_SIGNAL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 7 },
      notes: "Peek decision → daarna Den Signal timen (jij/target kan blijven LURK’en).",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
    DEN_SIGNAL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Prediction (of extra scout-kennis) → Den Signal als safety-net.",
    },
    KICK_UP_DUST: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 5, HARD_SCOUT: 5 },
      requiresNot: ["LOCK_EVENTS_ACTIVE"],
      notes: "Als jij (denkt dat je) een dodelijke next event ziet: prediction → hail-mary chaos (swap).",
    },
    SCATTER: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      notes: "Prediction edge → deny scout zodat anderen minder kunnen reageren/valideren.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 4, HARD_SCOUT: 5 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
  // TRACK CHAOS → LOCK / FREEZE / DEN_SIGNAL / DENY
  // =========================
  KICK_UP_DUST: {
    BURROW_BEACON: {
      score: { NO_SCOUT: 9, SOFT_SCOUT: 9, HARD_SCOUT: 9 },
      requiresNot: ["LOCK_EVENTS_ACTIVE"],
      notes: "Shuffle future events → lock track zodat niemand terugdraait (top combo).",
    },
    DEN_SIGNAL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 5, HARD_SCOUT: 5 },
      notes: "Na chaos is er meer onzekerheid → Den Signal als brede bescherming.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 8, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
      requiresNot: ["OPS_LOCKED_ACTIVE"],
      notes: "Lock track → freeze actions (double lock). Sterk als je al voordeel hebt (knowledge).",
    },
    DEN_SIGNAL: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 6, HARD_SCOUT: 7 },
      notes: "Track vastzetten → daarna Den Signal kiezen (maximaliseer safeNow op een ‘vaste’ reveal).",
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
  // DEN / COLOR CHAOS → DEFENSE / LEAD / FREEZE
  // =========================
  MASK_SWAP: {
    DEN_SIGNAL: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      notes: "Na den shuffle → kies immunity kleur die jou/veel spelers helpt.",
    },
    ALPHA_CALL: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 4, HARD_SCOUT: 4 },
      notes: "Na den shuffle → lead opnieuw slim zetten (bijv. lead weg bij jou).",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 7 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
      requiresNot: ["OPS_LOCKED_ACTIVE"],
      notes: "Den change → freeze (anti-counter).",
    },
  },

  // =========================
  // DEFENSE → LOCK / FREEZE / DENY (winst locken)
  // =========================
  DEN_SIGNAL: {
    BURROW_BEACON: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresNot: ["LOCK_EVENTS_ACTIVE"],
      notes: "Eerst immunity zetten → daarna track locken zodat anderen niet kunnen ‘weg-swappen’.",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 7, HARD_SCOUT: 7 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
    ALPHA_CALL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 3, HARD_SCOUT: 3 },
      notes: "Als jij ‘veilig’ bent door Den Signal kun je agressiever lead sturen (situational).",
    },
  },

  // =========================
  // LEAD CONTROL → DEFENSE / FREEZE / DENY
  // =========================
  ALPHA_CALL: {
    DEN_SIGNAL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      notes: "Lead zetten → daarna Den Signal om de ‘nieuwe’ situatie te stabiliseren (situational).",
    },
    HOLD_STILL: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
  // PACK TINKER = DISCARD ENABLE (swap uit hand ↔ discard; daarna eventueel B spelen)
  // =========================
  PACK_TINKER: {
    HOLD_STILL: {
      score: { NO_SCOUT: 8, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      requiresDiscardHas: ["HOLD_STILL"],
      requiresNot: ["OPS_LOCKED_ACTIVE"],
      notes: "Swap Hold Still uit discard → speel direct als finisher (zeer sterk).",
    },
    DEN_SIGNAL: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 7, HARD_SCOUT: 8 },
      requiresDiscardHas: ["DEN_SIGNAL"],
      notes: "Swap Den Signal uit discard → direct defense.",
    },
    BURROW_BEACON: {
      score: { NO_SCOUT: 7, SOFT_SCOUT: 8, HARD_SCOUT: 8 },
      requiresDiscardHas: ["BURROW_BEACON"],
      notes: "Swap Burrow Beacon uit discard → direct lock events (sterk bij knowledge).",
    },
    KICK_UP_DUST: {
      score: { NO_SCOUT: 6, SOFT_SCOUT: 6, HARD_SCOUT: 7 },
      requiresDiscardHas: ["KICK_UP_DUST"],
      requiresNot: ["LOCK_EVENTS_ACTIVE"],
      notes: "Swap Kick Up Dust uit discard → direct chaos (hail-mary / emergency).",
    },
    MASK_SWAP: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresDiscardHas: ["MASK_SWAP"],
      notes: "Swap Mask Swap uit discard → direct den chaos.",
    },
    SCENT_CHECK: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      requiresDiscardHas: ["SCENT_CHECK"],
      notes: "Swap Scent Check uit discard → direct info.",
    },
    FOLLOW_THE_TAIL: {
      score: { NO_SCOUT: 5, SOFT_SCOUT: 6, HARD_SCOUT: 6 },
      requiresDiscardHas: ["FOLLOW_THE_TAIL"],
      notes: "Swap Follow the Tail uit discard → direct commit (ideal met info).",
    },
    SCATTER: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 6, HARD_SCOUT: 7 },
      requiresDiscardHas: ["SCATTER"],
      notes: "Swap Scatter uit discard → direct info denial (sterker met knowledge).",
    },
    NO_GO_ZONE: {
      score: { NO_SCOUT: 3, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresDiscardHas: ["NO_GO_ZONE"],
      notes: "Swap No-Go Zone uit discard → direct block scout spot.",
    },
    ALPHA_CALL: {
      score: { NO_SCOUT: 4, SOFT_SCOUT: 5, HARD_SCOUT: 6 },
      requiresDiscardHas: ["ALPHA_CALL"],
      notes: "Swap Alpha Call uit discard → direct lead control.",
    },
  },

  // =========================
  // DENY STACK (meestal klein / overkill)
  // =========================
  SCATTER: {
    HOLD_STILL: {
      score: { NO_SCOUT: 2, SOFT_SCOUT: 3, HARD_SCOUT: 4 },
      requiresNot: ["OPS_LOCKED_ACTIVE"],
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
      requiresNot: ["OPS_LOCKED_ACTIVE"],
      notes: "Kleine denial → daarna freeze actions.",
    },
    SCATTER: {
      score: { NO_SCOUT: 1, SOFT_SCOUT: 2, HARD_SCOUT: 2 },
      notes: "Overkill: beide zijn denial.",
    },
  },

  FOLLOW_THE_TAIL: {
    // Geen echte follow-ups die beter worden door Follow als eerste.
  },

  HOLD_STILL: {},
};

// ------------------------------------------------------------
// Anti-combo lijst (hard negatief) — voor evaluators
// ------------------------------------------------------------
export const ACTION_COMBO_NEG_V2 = [
  { a: "HOLD_STILL", b: "*", score: -10, notes: "Hold Still blokkeert verdere actions deze ronde." },

  { a: "BURROW_BEACON", b: "KICK_UP_DUST", score: -9, notes: "Kick Up Dust is BLOCKED_BY_LOCK (lockEvents actief)." },

  { a: "DEN_SIGNAL", b: "MOLTING_MASK", score: -6, notes: "Den Signal → daarna eigen den veranderen: je protection kan misvallen." },
  { a: "DEN_SIGNAL", b: "MASK_SWAP", score: -6, notes: "Den Signal → daarna den shuffle: protection wordt onbetrouwbaar." },
];

// ------------------------------------------------------------
// Helper: combo score A→B met ctx checks
// ------------------------------------------------------------
function condValue(cond, ctx) {
  if (cond === "LOCK_EVENTS_ACTIVE") return !!ctx.lockEventsActive;
  if (cond === "OPS_LOCKED_ACTIVE") return !!ctx.opsLockedActive;
  return false;
}

export function comboScore(aId, bId, ctx = {}) {
  if (!aId || !bId) return 0;

  // als ops al gelocked is: combos zijn feitelijk irrelevant (geen nieuwe actions)
  if (ctx.opsLockedActive) return 0;

  // hard neg: Hold Still blocks as opener
  if (aId === "HOLD_STILL") return -10;

  // apply neg list
  for (const neg of ACTION_COMBO_NEG_V2) {
    if (neg.a === aId && (neg.b === bId || neg.b === "*")) return neg.score;
  }

  const rec = ACTION_COMBO_MATRIX_V2?.[aId]?.[bId];
  if (!rec) return 0;

  // requires (NIEUW: dit ontbrak in V2)
  if (Array.isArray(rec.requires)) {
    for (const c of rec.requires) if (!condValue(c, ctx)) return 0;
  }

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

// ------------------------------------------------------------
// Build comboInfo from a hand (bestPair + per-card saveValue)
// Shape matches botPolicyCore.safeComboInfo()
// ------------------------------------------------------------
export function buildComboInfoFromHand(handActionIds = [], ctx = {}, opts = {}) {
  const idsRaw = Array.isArray(handActionIds) ? handActionIds : [];
  const ids = [...new Set(idsRaw.map((x) => String(x || "").trim()).filter(Boolean))];

  // init per-card partner score
  const bestPartnerScoreByActionId = {};
  for (const id of ids) bestPartnerScoreByActionId[id] = 0;

  let bestA = null;
  let bestB = null;
  let bestScore = -Infinity;
  let bestNotes = "";

  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const a = ids[i];
      const b = ids[j];

      const s = comboScore(a, b, ctx);

      // saveValue voor BEIDE kanten (opener én follow-up)
      if (s > (bestPartnerScoreByActionId[a] || 0)) bestPartnerScoreByActionId[a] = s;
      if (s > (bestPartnerScoreByActionId[b] || 0)) bestPartnerScoreByActionId[b] = s;

      if (s > bestScore) {
        bestScore = s;
        bestA = a;
        bestB = b;
        bestNotes = ACTION_COMBO_MATRIX_V2?.[a]?.[b]?.notes || "";
      }
    }
  }

  // Als er geen echte synergy is, zet bestPair "uit"
  if (!Number.isFinite(bestScore) || bestScore <= 0) {
    bestA = null;
    bestB = null;
    bestScore = 0;
    bestNotes = "";
  }

  const allowsDuplicatePair = (aId, bId, ctx2 = {}) => {
    const r1 = ACTION_COMBO_MATRIX_V2?.[aId]?.[bId];
    const r2 = ACTION_COMBO_MATRIX_V2?.[bId]?.[aId];
    // future-proof: je kunt later per combo `allowDuplicatePair:true` zetten
    return !!(r1?.allowDuplicatePair || r2?.allowDuplicatePair);
  };

  // optioneel: minimumscore afdwingen
  const minScore = Number.isFinite(Number(opts?.minScore)) ? Number(opts.minScore) : null;
  if (minScore != null && bestScore < minScore) {
    bestA = null;
    bestB = null;
    bestScore = 0;
    bestNotes = "";
  }

  return {
    bestPair: { a: bestA, b: bestB, score: bestScore, notes: bestNotes },
    bestPartnerScoreByActionId,
    allowsDuplicatePair,
  };
}

