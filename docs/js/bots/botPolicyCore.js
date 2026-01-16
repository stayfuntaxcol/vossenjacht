// js/bots/botPolicyCore.js
// CORE Policy Engine (Spec v1)
// - Action economy: reserve / saveValue / 2nd action gating via combo
// - Carry & cashout gating
// - Rooster timing (danger bonus pas in postRooster2Window)
// - Anti-duplicate penalties (round + window + triple) met combo-exception
//
// Pure module: geen Firestore/DOM, alleen ctx + comboInfo + config -> result.

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function bool(x) {
  return !!x;
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function peakDanger(nextEventFacts) {
  if (!nextEventFacts) return 0;
  return Math.max(
    num(nextEventFacts.dangerDash, 0),
    num(nextEventFacts.dangerLurk, 0),
    num(nextEventFacts.dangerBurrow, 0)
  );
}

// Danger used for CASHOUT should reflect "stay risk" (best defensive option),
// not the peak across DASH/LURK/BURROW.
function stayDanger(nextEventFacts) {
  if (!nextEventFacts) return 0;
  const lurk = num(nextEventFacts.dangerLurk, 0);
  const burrow = num(nextEventFacts.dangerBurrow, 0);
  const dash = num(nextEventFacts.dangerDash, 0);

  // If both defensive values are 0, fall back to peak (legacy behavior).
  if (lurk <= 0 && burrow <= 0) {
    return Math.max(dash, lurk, burrow);
  }

  // Staying means you can pick the safer of LURK/BURROW.
  return Math.min(lurk, burrow);
}

function appliesToMeFromFacts(nextEventFacts) {
  if (!nextEventFacts) return undefined;
  if (typeof nextEventFacts.appliesToMe === "boolean") return nextEventFacts.appliesToMe;
  if (typeof nextEventFacts._appliesToMe === "boolean") return nextEventFacts._appliesToMe;
  return undefined;
}


// ---------- Defaults ----------
export const DEFAULT_CORE_CONFIG = {
  COMBO_THRESHOLD: 8,
  COMBO_THRESHOLD_HAILMARY: 7,
  SAVE_THRESHOLD: 8,

  RESERVE_EARLY: 3,
  RESERVE_LATE: 2,

  DUP_ROUND_PENALTY: 3,
  DUP_WINDOW_PENALTY: 2,
  DUP_TRIPLE_PENALTY: 8,

  DANGER_DASH_MIN: 7,
  HAILMARY_BEHIND: 6,

  CARRY_HIGH: 9,
  CARRY_EXTREME: 12,

  ROOSTER_BONUS: 2,

  // optional tuning knobs (safe defaults)
  LATE_GAME_ROUND: 5, // vanaf ronde 5 reserveLate
  RESERVE_PLAY_PENALTY: 2, // penalty op alle actions als spelen onder reserve zou duwen
  SAVE_PLAY_PENALTY: 3, // penalty als kaart "goud" is maar partner/condities ontbreken
  SAVE_ONLY_IF_NOT_IN_BESTPAIR: true, // gold-card penalty alleen als kaart niet in bestPair zit
  DUP_REDUCE_WHEN_COMBO_PRIMED: 0.5, // duplicate penalty factor (0..1) als kaart in bestPair + combo >= threshold

  // --- CashoutBias (continuous model) ---
  CASHOUT_BIAS_MIN: -4,
  CASHOUT_BIAS_MAX: 10,
  CASHOUT_CARRY_CENTER: 6,   // rond dit carry-niveau wordt DASH interessant
  CASHOUT_DANGER_CENTER: 5,  // rond dit dangerEffective-niveau wordt DASH interessant
  CASHOUT_CARRY_W: 0.9,
  CASHOUT_DANGER_W: 0.6,
  CASHOUT_LATE_BONUS: 1,     // extra druk in postRooster2Window
  CASHOUT_HERD_W: 1.0        // anti-herd: -1 per geplande dasher (max 3)
};

function mergeConfig(config) {
  return { ...DEFAULT_CORE_CONFIG, ...(config || {}) };
}

// ---------- Combo helpers ----------
function safeComboInfo(comboInfo) {
  const bestPair = comboInfo?.bestPair || { a: null, b: null, score: 0 };
  const bestPartnerScoreByActionId = comboInfo?.bestPartnerScoreByActionId || {};
  const allowsDuplicatePair =
    typeof comboInfo?.allowsDuplicatePair === "function"
      ? comboInfo.allowsDuplicatePair
      : () => false;

  return { bestPair, bestPartnerScoreByActionId, allowsDuplicatePair };
}

function isInBestPair(actionId, bestPair) {
  return !!actionId && (actionId === bestPair?.a || actionId === bestPair?.b);
}

// ---------- Core subcomputations ----------
function computeHailMary(ctx, cfg) {
  return bool(ctx?.isLast) || num(ctx?.scoreBehind, 0) >= num(cfg.HAILMARY_BEHIND, 6);
}

function computeLateGame(ctx, cfg) {
  const round = num(ctx?.round, 0);
  const lateByRound = round >= num(cfg.LATE_GAME_ROUND, 5);
  // postRooster2Window voelt als “late pressure”
  const lateByRooster = bool(ctx?.postRooster2Window);
  return lateByRound || lateByRooster;
}


function computeDangerEffective(ctx, cfg) {
  // If next event is targeted and does NOT apply to this bot (e.g., DEN_* mismatch, lead-only event),
  // then it should not push cashout.
  const applies = appliesToMeFromFacts(ctx?.nextEventFacts);
  if (applies === false) {
    return 0;
  }

  // Prefer explicit dangerNext provided by heuristics; otherwise derive from facts.
  // IMPORTANT: use stayDanger(), not peakDanger(), to avoid "auto-DASH" on events that are
  // dangerous only for one DEN color or can be safely mitigated by BURROW/LURK.
  const dangerNext = Number.isFinite(Number(ctx?.dangerNext))
    ? num(ctx.dangerNext, 0)
    : stayDanger(ctx?.nextEventFacts);

  const roosterSeen = num(ctx?.roosterSeen, 0);
  const postRooster2Window = bool(ctx?.postRooster2Window);

  const roosterBonus =
    postRooster2Window && roosterSeen >= 2 ? num(cfg.ROOSTER_BONUS, 0) : 0;

  return clamp(dangerNext + roosterBonus, 0, 20);
}

function computeEconomy(ctx, comboInfo, cfg, hailMary, lateGame) {
  const handActionIds = arr(ctx?.handActionIds).filter(Boolean);
  const handSize = Number.isFinite(Number(ctx?.handSize))
    ? num(ctx.handSize, handActionIds.length)
    : handActionIds.length;

  const actionsPlayedThisRound = num(ctx?.actionsPlayedThisRound, 0);

  const reserveTarget = lateGame ? num(cfg.RESERVE_LATE, 2) : num(cfg.RESERVE_EARLY, 3);

  const comboThreshold = hailMary ? num(cfg.COMBO_THRESHOLD_HAILMARY, 7) : num(cfg.COMBO_THRESHOLD, 8);
  const bestScore = num(comboInfo?.bestPair?.score, 0);

  const maxActionsAllowedThisTurn = bestScore >= comboThreshold ? 2 : 1;

  const denySecondAction =
    actionsPlayedThisRound >= 1 && maxActionsAllowedThisTurn < 2;

  const addToActionTotal = {};

  // Reserve penalty: als spelen je onder reserve duwt, penalize ALLE plays.
  // (botHeuristics kan dan PASS hoger laten eindigen.)
  const wouldDropBelowReserve = (handSize - 1) < reserveTarget;
  if (wouldDropBelowReserve && handActionIds.length) {
    const p = -Math.abs(num(cfg.RESERVE_PLAY_PENALTY, 2));
    for (const id of handActionIds) addToActionTotal[id] = (addToActionTotal[id] || 0) + p;
  }

  // SaveValue (gold) penalty per action
  const saveThreshold = num(cfg.SAVE_THRESHOLD, 8);
  const savePenalty = -Math.abs(num(cfg.SAVE_PLAY_PENALTY, 3));
  const bestPair = comboInfo?.bestPair || { a: null, b: null, score: 0 };
  const onlyIfNotInBestPair = bool(cfg.SAVE_ONLY_IF_NOT_IN_BESTPAIR);

  for (const id of handActionIds) {
    const saveValue = num(comboInfo?.bestPartnerScoreByActionId?.[id], 0);
    if (saveValue < saveThreshold) continue;

    // Simpele “partner ontbreekt” heuristiek:
    // - als id niet in bestPair, dan heeft hij blijkbaar nu geen perfecte partner.
    // - later kun je dit verfijnen met matrix-requires.
    const notInPair = !isInBestPair(id, bestPair);
    if (onlyIfNotInBestPair && !notInPair) continue;

    addToActionTotal[id] = (addToActionTotal[id] || 0) + savePenalty;
  }

  return {
    reserveTarget,
    maxActionsAllowedThisTurn,
    denySecondAction,
    addToActionTotal,
    comboThreshold,
  };
}

function countInArray(list, value) {
  let c = 0;
  for (const x of list) if (x === value) c++;
  return c;
}

function computeDuplicatePenalties(ctx, comboInfo, cfg, comboThreshold) {
  const handActionIds = arr(ctx?.handActionIds).filter(Boolean);

  const discardThisRound = arr(ctx?.discardThisRoundActionIds).filter(Boolean);
  const discardRecent = arr(ctx?.discardRecentActionIds).filter(Boolean);

  const bestPair = comboInfo?.bestPair || { a: null, b: null, score: 0 };
  const bestScore = num(bestPair?.score, 0);

  const addToActionTotal = {};

  // last-two for triple detection
  const last2 = discardRecent.slice(-2);

  for (const id of handActionIds) {
    let penalty = 0;

    // round duplicate
    if (discardThisRound.includes(id)) penalty += Math.abs(num(cfg.DUP_ROUND_PENALTY, 3));

    // window duplicate (>=2 times in recent window)
    if (countInArray(discardRecent, id) >= 2) penalty += Math.abs(num(cfg.DUP_WINDOW_PENALTY, 2));

    // triple in a row
    if (last2.length === 2 && last2[0] === id && last2[1] === id) {
      penalty += Math.abs(num(cfg.DUP_TRIPLE_PENALTY, 8));
    }

    if (penalty <= 0) continue;

    // Combo exception:
    // - if matrix says duplicates allowed for the active pair, then zero it
    // - else if combo is primed and this id is part of bestPair, reduce penalty
    const inPair = isInBestPair(id, bestPair);

    if (bestPair?.a && bestPair?.b && comboInfo?.allowsDuplicatePair(bestPair.a, bestPair.b, ctx)) {
      penalty = 0;
    } else if (inPair && bestScore >= comboThreshold) {
      const factor = clamp(num(cfg.DUP_REDUCE_WHEN_COMBO_PRIMED, 0.5), 0, 1);
      penalty = Math.round(penalty * factor);
    }

    if (penalty > 0) addToActionTotal[id] = (addToActionTotal[id] || 0) - penalty;
  }

  return { addToActionTotal };
}


function computeCashoutBias(ctx, dangerEffective, cfg, hailMary) {
  const carry = num(ctx?.carryValue, 0);
  const isExtreme = carry >= num(cfg.CARRY_EXTREME, 12);

  // extreme: always bank (maar hailMary dempt)
  if (isExtreme) {
    let b = 10;
    if (hailMary) b -= 3;
    return b;
  }

  const carryCenter = num(cfg.CASHOUT_CARRY_CENTER, 6);
  const dangerCenter = num(cfg.CASHOUT_DANGER_CENTER, 5);
  const carryW = num(cfg.CASHOUT_CARRY_W, 0.9);
  const dangerW = num(cfg.CASHOUT_DANGER_W, 0.6);

  // continu model
  let bias =
    (carry - carryCenter) * carryW +
    (dangerEffective - dangerCenter) * dangerW;

  // late pressure (optioneel)
  if (bool(ctx?.postRooster2Window)) {
    bias += num(cfg.CASHOUT_LATE_BONUS, 1);
  }

  // anti-herd (optioneel): hoe meer dashers al "in de planning", hoe minder aantrekkelijk
  const dashersPlanned = num(ctx?.dashersPlanned, num(ctx?.dashDecisionsSoFar, 0));
  const herdW = num(cfg.CASHOUT_HERD_W, 1.0);
  bias -= herdW * clamp(dashersPlanned, 0, 3);

  // hail-mary: blijf vechten, cashout minder aantrekkelijk
  if (hailMary) bias -= 3;

  bias = clamp(bias, num(cfg.CASHOUT_BIAS_MIN, -4), num(cfg.CASHOUT_BIAS_MAX, 10));
  return Math.round(bias);
}

// ---------- Main export ----------
export function evaluateCorePolicy(ctx, comboInfo, config) {
  const cfg = mergeConfig(config);
  const combo = safeComboInfo(comboInfo);

  const hailMary = computeHailMary(ctx, cfg);
  const lateGame = computeLateGame(ctx, cfg);

  const dangerEffective = computeDangerEffective(ctx, cfg);

  const eco = computeEconomy(ctx, combo, cfg, hailMary, lateGame);
  const dup = computeDuplicatePenalties(ctx, combo, cfg, eco.comboThreshold);

  // merge addToActionTotal maps (economy + duplicates)
  const addToActionTotal = {};
  for (const [k, v] of Object.entries(eco.addToActionTotal || {})) addToActionTotal[k] = (addToActionTotal[k] || 0) + num(v, 0);
  for (const [k, v] of Object.entries(dup.addToActionTotal || {})) addToActionTotal[k] = (addToActionTotal[k] || 0) + num(v, 0);

  const cashoutBias = computeCashoutBias(ctx, dangerEffective, cfg, hailMary);

  const result = {
    maxActionsAllowedThisTurn: eco.maxActionsAllowedThisTurn,
    reserveTarget: eco.reserveTarget,
    denySecondAction: eco.denySecondAction,

    dangerEffective,
    cashoutBias,

    addToActionTotal,
    denyActionIds: [],

    debug: ctx?.debug
      ? {
          hailMary,
          lateGame,
          carryValue: num(ctx?.carryValue, 0),
          dangerNext: Number.isFinite(Number(ctx?.dangerNext))
            ? num(ctx?.dangerNext, 0)
            : stayDanger(ctx?.nextEventFacts),
          roosterSeen: num(ctx?.roosterSeen, 0),
          postRooster2Window: bool(ctx?.postRooster2Window),
          comboBest: combo.bestPair,
          comboThresholdUsed: eco.comboThreshold,
        }
      : undefined,
  };

  return result;
}
