// js/bots/core/metrics.js
// Pure metrics: carryValue + danger scoring (0–10) + uncertainty.
// GEEN Firestore calls.

import { getEventFacts as getEventFactsFromKit } from "../aiKit.js";

// ---------- tiny utils ----------
function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function clamp01(n) {
  return clamp(num(n, 0), 0, 1);
}
function round1(n) {
  return Math.round(num(n, 0) * 10) / 10;
}
function normColor(c) {
  return String(c || "").trim().toUpperCase();
}
function arr(x) {
  return Array.isArray(x) ? x : [];
}

const DEFAULT_CFG = {
  LOOKAHEAD_WEIGHTS: [0.72, 0.28],
  DANGER_HIGH_THRESHOLD: 7,
  CARRY_SCALE: 12,       // ~ CARRY_EXTREME
  LOSS_W: 0.6,           // carry -> danger severity multiplier
  UNCERTAINTY_W: 0.25,   // low confidence -> slightly more conservative
  OPS_LOCK_PENALTY: 0.4, // small bump if opsLocked (less flexibility)
};

// ---------- Carry ----------
function sumLootPoints(p) {
  const loot = arr(p?.loot);
  return loot.reduce((s, c) => {
    const raw = c?.v ?? c?.value ?? c?.points ?? c?.pts;
    const v = Number(raw);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
}

/**
 * computeCarryValue(p)
 * Rule: prefer loot[] points (single source of truth).
 * Fallback: eggs/hens/prize if loot[] ontbreekt.
 */
export function computeCarryValue(p, opts = {}) {
  const lootPts = sumLootPoints(p);
  if (lootPts > 0) return num(lootPts, 0);

  const eggV = Number.isFinite(opts.eggValue) ? opts.eggValue : 1;
  const henV = Number.isFinite(opts.henValue) ? opts.henValue : 2;
  const prizeV = Number.isFinite(opts.prizeValue) ? opts.prizeValue : 3;

  const eggs = num(p?.eggs, 0);
  const hens = num(p?.hens, 0);

  // prize kan bool of count zijn
  const prizeCount = Number.isFinite(Number(p?.prize)) ? num(p?.prize, 0) : (p?.prize ? 1 : 0);

  return eggs * eggV + hens * henV + prizeCount * prizeV;
}

// ---------- Event classification (light) ----------
function classifyEventId(eventId) {
  const id = String(eventId || "");
  if (!id) return { type: "NONE", id: "" };
  if (id === "DOG_CHARGE" || id === "SECOND_CHARGE") return { type: "DOG", id };
  if (id === "GATE_TOLL") return { type: "TOLL", id };
  if (id === "SHEEPDOG_PATROL") return { type: "NO_DASH", id };
  if (id === "ROOSTER_CROW") return { type: "ROOSTER", id };
  if (id.startsWith("DEN_")) return { type: "DEN", id, color: id.split("_")[1] || "" };
  return { type: "OTHER", id };
}

function isLeadOnlyEvent(eventId) {
  const id = String(eventId || "");
  return id === "SILENT_ALARM" || id === "MAGPIE_SNITCH";
}

function isNoPeekForPlayer(flagsRound, playerId) {
  const v = flagsRound?.noPeek;
  if (v === true) return true;

  // als iemand per ongeluk [] opslaat (truthy), behandel dat NIET als “noPeek actief”
  // (alleen lijst-modus als het echt IDs bevat)
  if (Array.isArray(v)) return v.includes(playerId);

  return false;
}

function isDenImmuneForColor(flagsRound, denColor) {
  const map = flagsRound?.denImmune || {};
  const k = normColor(denColor);
  return !!(k && map[k]);
}

// ---------- Facts getter with scoping + fallback ----------
function fallbackFacts(eventId, ctx) {
  const cls = classifyEventId(eventId);
  const lootPts = sumLootPoints(ctx.player);

  // defaults
  let out = { dangerDash: 0, dangerLurk: 0, dangerBurrow: 0, appliesToMe: true };

  if (cls.type === "DOG") {
    out = { dangerDash: 0, dangerLurk: 10, dangerBurrow: 0, appliesToMe: true };
  } else if (cls.type === "DEN") {
    const mine = normColor(cls.color) === normColor(ctx.denColor);
    out = { dangerDash: 0, dangerLurk: mine ? 10 : 0, dangerBurrow: 0, appliesToMe: mine };
  } else if (cls.type === "NO_DASH") {
    out = { dangerDash: 10, dangerLurk: 0, dangerBurrow: 0, appliesToMe: true };
  } else if (cls.type === "TOLL") {
    const stay = lootPts > 0 ? 4 : 10;
    out = { dangerDash: 0, dangerLurk: stay, dangerBurrow: stay, appliesToMe: true };
  } else if (eventId === "SILENT_ALARM") {
    out = { dangerDash: 0, dangerLurk: ctx.isLead ? 6 : 0, dangerBurrow: ctx.isLead ? 4 : 0, appliesToMe: !!ctx.isLead };
  } else if (eventId === "MAGPIE_SNITCH") {
    out = { dangerDash: 0, dangerLurk: ctx.isLead ? 10 : 0, dangerBurrow: 0, appliesToMe: !!ctx.isLead };
  }

  return out;
}

function getScopedEventFacts(eventId, ctx) {
  if (!eventId) return null;

  // 1) try your existing facts
  let f = null;
  try {
    f = typeof getEventFactsFromKit === "function" ? getEventFactsFromKit(eventId) : null;
  } catch {
    f = null;
  }

  // 2) fallback if missing
  if (!f) f = fallbackFacts(eventId, ctx);

  const cls = classifyEventId(eventId);

  let appliesToMe =
    typeof f.appliesToMe === "boolean"
      ? f.appliesToMe
      : (typeof f._appliesToMe === "boolean" ? f._appliesToMe : undefined);

  // DEN scoping
  if (cls.type === "DEN") {
    const mine = normColor(cls.color) === normColor(ctx.denColor);
    if (!mine) appliesToMe = false;
  }

  // lead-only scoping
  if (isLeadOnlyEvent(eventId) && !ctx.isLead) appliesToMe = false;

  // den immunity scoping
  const immune = isDenImmuneForColor(ctx.flagsRound, ctx.denColor);
  if (immune) {
    // immune neutraliseert DOG + eigen DEN
    if (cls.type === "DOG") appliesToMe = false;
    if (cls.type === "DEN" && normColor(cls.color) === normColor(ctx.denColor)) appliesToMe = false;
  }

  // Build normalized output
  let dangerDash = num(f.dangerDash, 0);
  let dangerLurk = num(f.dangerLurk, 0);
  let dangerBurrow = num(f.dangerBurrow, 0);

  // If it doesn't apply → zero danger vector
  if (appliesToMe === false) {
    dangerDash = 0;
    dangerLurk = 0;
    dangerBurrow = 0;
  }

  // holdStill: DASH effectively “not allowed” → treat as very risky
  const hs = ctx.flagsRound?.holdStill || {};
  if (ctx.playerId && hs[ctx.playerId] === true) {
    dangerDash = Math.max(dangerDash, 9);
  }

  // burrowUsed: treat BURROW as same safety as LURK (conservative)
  if (ctx.player?.burrowUsed) {
    dangerBurrow = dangerLurk;
  }

  return {
    eventId,
    dangerDash,
    dangerLurk,
    dangerBurrow,
    appliesToMe: (typeof appliesToMe === "boolean") ? appliesToMe : undefined,
  };
}

function peakDanger(f) {
  if (!f) return 0;
  return Math.max(num(f.dangerDash, 0), num(f.dangerLurk, 0), num(f.dangerBurrow, 0));
}

function stayDanger(f) {
  if (!f) return 0;
  const lurk = num(f.dangerLurk, 0);
  const burrow = num(f.dangerBurrow, 0);
  const dash = num(f.dangerDash, 0);

  if (lurk <= 0 && burrow <= 0) return Math.max(dash, lurk, burrow);
  return Math.min(lurk, burrow);
}

// Mirrors core-policy behavior: dangerEffective = dangerNext(stay) + roosterBonus (late only)
function computeDangerEffectiveLikeCore({ nextEventFacts, roosterSeen, postRooster2Window, cfg }) {
  const applies = (typeof nextEventFacts?.appliesToMe === "boolean")
    ? nextEventFacts.appliesToMe
    : (typeof nextEventFacts?._appliesToMe === "boolean" ? nextEventFacts._appliesToMe : undefined);

  if (applies === false) return 0;

  const dangerNext = stayDanger(nextEventFacts);
  const roosterBonus = (postRooster2Window && roosterSeen >= 2) ? num(cfg.ROOSTER_BONUS ?? 2, 2) : 0;
  return clamp(dangerNext + roosterBonus, 0, 20);
}

function bagCounts(list) {
  const m = new Map();
  for (const x of list) {
    const k = String(x || "");
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function removeOneFromBag(map, key) {
  const k = String(key || "");
  if (!k) return map;
  const out = new Map(map);
  const n = out.get(k) || 0;
  if (n <= 1) out.delete(k);
  else out.set(k, n - 1);
  return out;
}

function expectedVecFromBag(bag, ctx, cfg) {
  let total = 0;
  let dash = 0, lurk = 0, burrow = 0;
  let pDangerCount = 0;

  for (const [eventId, count] of bag.entries()) {
    const c = num(count, 0);
    if (c <= 0) continue;

    const f = getScopedEventFacts(eventId, ctx) || { dangerDash: 0, dangerLurk: 0, dangerBurrow: 0 };
    dash += c * num(f.dangerDash, 0);
    lurk += c * num(f.dangerLurk, 0);
    burrow += c * num(f.dangerBurrow, 0);

    if (peakDanger(f) >= cfg.DANGER_HIGH_THRESHOLD) pDangerCount += c;
    total += c;
  }

  if (total <= 0) {
    return { dash: 0, lurk: 0, burrow: 0, pDanger: 0, n: 0 };
  }

  return {
    dash: dash / total,
    lurk: lurk / total,
    burrow: burrow / total,
    pDanger: pDangerCount / total,
    n: total,
  };
}

/**
 * computeDangerMetrics({game, player, players, flagsRound, intel})
 * -> { dangerScore, dangerVec, dangerPeak, dangerStay, dangerEffective, nextEventIdUsed, pDanger, confidence, intel }
 */
export function computeDangerMetrics({ game, player, players = [], flagsRound = null, intel = {}, config = {} }) {
  const cfg = { ...DEFAULT_CFG, ...(config || {}) };

  const g = game || {};
  const p = player || {};
  const playerId = String(p.id || intel.playerId || "");
  const flags = flagsRound || g.flagsRound || {};

  const denColor = normColor(intel.denColor || p.color || p.den || p.denColor);
  const isLead = (typeof intel.isLead === "boolean") ? intel.isLead : (String(g.leadFoxId || "") === playerId);

  const noPeek = isNoPeekForPlayer(flags, playerId);
  const knownUpcoming = arr(p.knownUpcomingEvents);
  const knownUpcomingCount = knownUpcoming.length;

  const track = arr(g.eventTrack);
  const idx = Number.isFinite(Number(g.eventIndex)) ? Number(g.eventIndex) : 0;

  // event candidates
  const peek0 = track[idx] || null;
  const peek1 = track[idx + 1] || null;

  const next0 = noPeek ? (knownUpcoming[0] || null) : peek0;
  const next1 = noPeek ? (knownUpcoming[1] || null) : peek1;

  const nextKnown = !!next0;

  // remaining bag for probabilistic mode
  const remaining = track.slice(idx);
  const bag0 = bagCounts(remaining);
  const bag1 = next0 ? removeOneFromBag(bag0, next0) : bag0;

  const baseCtx = {
    player,
    playerId,
    denColor,
    isLead,
    flagsRound: flags,
  };

  // offset 0 vec
  let v0, pDanger0 = 0, n0 = 0;
  if (next0) {
    const f0 = getScopedEventFacts(next0, baseCtx);
    v0 = {
      dash: num(f0?.dangerDash, 0),
      lurk: num(f0?.dangerLurk, 0),
      burrow: num(f0?.dangerBurrow, 0),
    };
    pDanger0 = (f0 && peakDanger(f0) >= cfg.DANGER_HIGH_THRESHOLD) ? 1 : 0;
    n0 = 1;
  } else {
    const e0 = expectedVecFromBag(bag0, baseCtx, cfg);
    v0 = { dash: e0.dash, lurk: e0.lurk, burrow: e0.burrow };
    pDanger0 = e0.pDanger;
    n0 = e0.n;
  }

  // offset 1 vec
  let v1, pDanger1 = 0, n1 = 0;
  if (next1) {
    const f1 = getScopedEventFacts(next1, baseCtx);
    v1 = {
      dash: num(f1?.dangerDash, 0),
      lurk: num(f1?.dangerLurk, 0),
      burrow: num(f1?.dangerBurrow, 0),
    };
    pDanger1 = (f1 && peakDanger(f1) >= cfg.DANGER_HIGH_THRESHOLD) ? 1 : 0;
    n1 = 1;
  } else {
    const e1 = expectedVecFromBag(bag1, baseCtx, cfg);
    v1 = { dash: e1.dash, lurk: e1.lurk, burrow: e1.burrow };
    pDanger1 = e1.pDanger;
    n1 = e1.n;
  }

  const w0 = num(cfg.LOOKAHEAD_WEIGHTS?.[0], 0.72);
  const w1 = num(cfg.LOOKAHEAD_WEIGHTS?.[1], 0.28);

  const dangerVec = {
    dash: round1(w0 * v0.dash + w1 * v1.dash),
    lurk: round1(w0 * v0.lurk + w1 * v1.lurk),
    burrow: round1(w0 * v0.burrow + w1 * v1.burrow),
  };

  const dangerPeak = round1(Math.max(dangerVec.dash, dangerVec.lurk, dangerVec.burrow));
  const dangerStay = round1(Math.min(dangerVec.lurk, dangerVec.burrow));

  // carry & multipliers
  const carryValue = Number.isFinite(Number(intel.carryValue)) ? num(intel.carryValue, 0) : computeCarryValue(p);
  const lossMult = 1 + cfg.LOSS_W * clamp01(carryValue / cfg.CARRY_SCALE);

  const riskWeight = num(intel.riskWeight, 1); // pass in from preset/profile
  const riskMult = clamp(0.85 + 0.15 * riskWeight, 0.75, 1.3);

  // confidence
  let confidence = 1;
  if (!nextKnown) {
    const N = Math.max(1, remaining.length);
    confidence = clamp(0.2 + 0.6 * (1 / Math.sqrt(N)), 0.2, 0.8);
  } else if (noPeek && knownUpcomingCount === 1) {
    confidence = 0.85;
  } else if (noPeek && knownUpcomingCount >= 2) {
    confidence = 0.95;
  }

  const uncertaintyMult = 1 + cfg.UNCERTAINTY_W * (1 - confidence);

  const opsLockedPenalty = flags?.opsLocked ? cfg.OPS_LOCK_PENALTY : 0;

  const dangerScore = clamp(
    round1(dangerStay * lossMult * riskMult * uncertaintyMult + opsLockedPenalty),
    0,
    10
  );

  // dangerEffective (core-like): gebaseerd op stayDanger(nextEventFacts) + rooster bonus (late only)
  const nextEventFacts0 = next0 ? getScopedEventFacts(next0, baseCtx) : null;

  const roosterSeen = Number.isFinite(Number(g?.roosterSeen)) ? Number(g.roosterSeen) : 0;
  const postRooster2Window = roosterSeen >= 2;

  const dangerEffective = round1(
    computeDangerEffectiveLikeCore({
      nextEventFacts: nextEventFacts0,
      roosterSeen,
      postRooster2Window,
      cfg: { ROOSTER_BONUS: 2 },
    })
  );

  // blended pDanger
  const pDanger = round1(w0 * pDanger0 + w1 * pDanger1);

  return {
    dangerScore,
    dangerVec,
    dangerPeak,
    dangerStay,
    dangerEffective,
    nextEventIdUsed: next0 || null,
    pDanger,
    confidence: round1(confidence),
    intel: {
      denColor,
      isLead,
      noPeek,
      nextKnown,
      knownUpcomingCount,
      next0,
      next1,
      remainingN: remaining.length,
      lockEvents: !!flags?.lockEvents,
      scatter: !!flags?.scatter,
      opsLocked: !!flags?.opsLocked,
      denImmune: isDenImmuneForColor(flags, denColor),
      holdStill: !!(flags?.holdStill && playerId && flags.holdStill[playerId] === true),
      // passthrough (optioneel)
      scoutTier: intel.scoutTier ?? null,
    },
    // (optioneel) debug multipliers
    debug: {
      carryValue: round1(carryValue),
      lossMult: round1(lossMult),
      riskMult: round1(riskMult),
      uncertaintyMult: round1(uncertaintyMult),
      w0,
      w1,
      n0,
      n1,
    },
  };
}
