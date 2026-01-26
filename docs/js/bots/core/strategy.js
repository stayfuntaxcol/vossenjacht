// bots/core/strategy.js
// Shared, utility-based policy for MOVE / OPS(ACTIONS) / DECISION.
// No Firestore writes. (Caller handles writes; only BURROW hard-rule uses a Firestore boolean: player.burrowUsed)

import { getEventFacts, getActionFacts } from "../rulesIndex.js";
import { getActionDefByName, getLootDef } from "../../cards.js";
import { comboScore } from "../actionComboMatrix.js";

/** =========================
 *  TUNING (edit here)
 *  ========================= */
export const BOT_UTILITY_CFG = {
  // utility = gainLoot + denyOpponents + teamSynergy − riskPenalty − resourcePenalty
  wLoot: 6.0,
  wDeny: 0.8,
  wTeam: 0.6,
  wRisk: 1.15,
  wShare: 0.9,
  wResource: 1.0,

  // lookahead (peek)
  lookaheadN: 4,

  // DECISION (CANON)
  // dangerScore is 0..10 for the NEXT REVEAL if you choose LURK.
  // dashPush is 0..10 and is UPDATED over time (NOT derived from carry).
  canonSafeDangerMax: 3.0,      // <= this: "safe enough" -> LURK
  canonCautionDangerMax: 5.0,   // <= this: cautious LURK (stay, but build dashPush)
  canonHighDangerMin: 6.5,      // >= this: unsafe -> BURROW else DASH
  canonCritDangerMin: 8.5,      // >= this: emergency -> BURROW else DASH

  // DASH is definitive; more dashers => more Loot Sack split => raise threshold
  canonDashPushBase: 7.0,
  canonDashPushDashersBonusCap: 3,

  // noPeek end-pressure (probabilistic)
  canonPThirdRoosterThreshold: 0.75,

  // dashPush update per round
  canonDashPushSafeDecay: 1.0,
  canonDashPushUnsafeGainMax: 2.0,
  canonDashPushEndPressureBoost: 2.0,



  // MOVE
  shiftMinGain: 3.0,          // SHIFT must beat next-best by this much (after cost)
  shiftDangerTrigger: 7.2,   // only consider SHIFT if next event peak danger >= this
  shiftLookahead: 4,         // how many future slots to consider swapping with
  shiftDistancePenalty: 0.25,// penalty per slot distance (discourages far swaps)
  shiftBenefitMin: 1.6,      // minimum benefit needed to accept a SHIFT candidate
  shiftCooldownRounds: 1,    // block repeated SHIFT within this many rounds
  shiftOverrideBenefit: 3.0, // if on cooldown, only allow SHIFT if benefit >= this
  shiftRequireLoot: true,    // SHIFT requires at least 1 loot (cost)
  scoutBaseValue: 1.0,        // in peek-mode scout is basically worthless

  // MOVE expected values (cheap but stable)
  actionDeckSampleN: 30,

  // OPS (minder krampachtig sparen, maar nog steeds combo-bewust)
  actionReserveMinHand: 1,
  actionPlayMinGain: 0.9,
  comboMinGain: 1.4,
  allowComboSearch: true,
  comboMaxPairs: 20,

  // OPS discipline: avoid dumping cards early; save for combos (SOFTER)
  opsEarlyRounds: 2,               // rounds 1..2 are “early raid”
  opsReserveHandEarly: 3,          // keep ~3 early
  opsReserveHandMid: 2,
  opsReserveHandLate: 1,

  // combo: minder zwaar
  opsHighComboScore: 10,          // minder snel "highCombo" 
  opsHighComboGainBonus: 0.25,    // i.p.v. hardcoded 0.4 (zie patch 1B)
  opsReserveComboBoost: 0,
  
  opsSpendCostBase: 0.40,          // softer opportunity cost per spent card
  opsSpendCostEarlyMult: 1.05,
  opsSpendCostLateMult: 0.8,
  
    // OPS "card has value": alleen spelen bij significant voordeel
  opsPlayTaxBase: 0.85,              // vaste utility-kost per gespeelde kaart
  opsPlayTaxEarlyMult: 1.15,        // early: harder sparen
  opsThreatDangerTrigger: 5.0,         // if next event lurk danger >= this -> play more
  opsThreatPlayBoost: 0.6,             // reduce requiredGain by this in threat-mode
  opsLeadThreatExtraBoost: 0.4,        // extra boost if LEAD-only threat and I'm lead
  opsThreatPlayTaxMult: 0.80,          // multiply playTaxMult in threat-mode
  opsPlayTaxLateMult: 0.85,         // late: makkelijker uitgeven

  opsMinAdvantage: 1.0,             // minimaal voordeel boven PASS om überhaupt te spelen
  opsMinAdvantageEarlyBonus: 0.2,   // early: nog strenger

  // combo planning: key pieces bewaren, maar "setup" plays toestaan
  opsComboHoldPenaltyScale: 0.14,   // penalty ~ scale * comboKeyScore
  opsComboSetupBonusScale: 0.10,    // bonus ~ scale * best outgoing combo score
  opsComboSetupEarlyMult: 0.55,
  opsComboSetupMidMult: 0.80,
  opsComboSetupLateMult: 1.00,


  opsReserveMissPenalty: 0.55,     // softer penalty if you dip under reserveTarget
  opsSoloBreakComboPenalty: 0.6,   // softer penalty for spending a key solo

  actionPlayMinGainEarlyBonus: 0.20, // slightly harder early, but not paralyzing

  // Multiplayer/pest-card waardering (nieuw)
  opsMultiPlayerBaseBonus: 0.55,   // kleine extra waarde in drukke Yard
  opsMultiPlayerSoloPenalty: 0.75, // ontmoedig verspillen als je (bijna) solo bent
  opsMultiStageEarlyMult: 1.20,
  opsMultiStageLateMult: 0.85,
  
  // “implemented” safety
  actionUnimplementedMult: 0.15,

  // Random actions sampling
  kickUpDustSamples: 6,
  kickUpDustOptimism: 0.55,

  // Hidden Nest coordination (anti-herding)
  hiddenNestCoordination: true,
  hiddenNestDashPenalty: 6.0,        // discourage DASH if not in slot
  hiddenNestBurrowPenalty: 16.0,      // discourage BURROW on Hidden Nest
};

const DEFAULTS = BOT_UTILITY_CFG;

/** =========================
 *  small helpers
 *  ========================= */
function safeArr(x) { return Array.isArray(x) ? x : []; }
function normColor(c) { return String(c || "").trim().toUpperCase(); }
function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function sumLootPoints(p) {
  const loot = safeArr(p?.loot);
  return loot.reduce((s, c) => s + (Number(c?.v) || 0), 0);
}
function lootCardValue(card) {
  if (!card) return 0;
  const v = Number(card?.v);
  if (Number.isFinite(v)) return v;
  const def = getLootDef?.(card?.t || card?.name || "");
  return Number(def?.value || 0);
}
function highestLootCardIndex(loot) {
  const arr = safeArr(loot);
  if (!arr.length) return -1;
  let bestI = 0;
  let bestV = lootCardValue(arr[0]);
  for (let i = 1; i < arr.length; i++) {
    const v = lootCardValue(arr[i]);
    if (v > bestV) { bestV = v; bestI = i; }
  }
  return bestI;
}
function structuredCloneSafe(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}
function isInYard(p) { return p?.inYard !== false && !p?.dashed; }
function isSameDen(a, b) {
  const da = normColor(a?.color || a?.den || a?.denColor);
  const db = normColor(b?.color || b?.den || b?.denColor);
  return !!da && da === db;
}
function nextEventId(game, offset = 0) {
  const track = safeArr(game?.eventTrack);
  const idx = Number.isFinite(Number(game?.eventIndex)) ? Number(game.eventIndex) : 0;
  return track[idx + offset] || null;
}
function classifyEvent(eventId) {
  const id = String(eventId || "");
  if (!id) return { type: "NONE" };
  if (id === "DOG_CHARGE" || id === "SECOND_CHARGE") return { type: "DOG" };
  if (id === "GATE_TOLL") return { type: "TOLL" };
  if (id === "SHEEPDOG_PATROL") return { type: "NO_DASH" };
  if (id === "ROOSTER_CROW") return { type: "ROOSTER" };
  if (id.startsWith("DEN_")) return { type: "DEN", color: id.split("_")[1] || "" };
  return { type: "OTHER", id };
}
function computeIsLead(game, me, players) {
  const meId = String(me?.id || "");
  const leadFoxId = String(game?.leadFoxId || "");
  if (leadFoxId && leadFoxId === meId) return true;

  const leadFoxName = String(game?.leadFox || "");
  const meName = String(me?.name || "");
  if (leadFoxName && meName && leadFoxName === meName) return true;

  const idx = Number.isFinite(Number(game?.leadIndex)) ? Number(game.leadIndex) : null;
  if (idx === null) return false;

  const ordered = safeArr(players).slice().sort((a, b) => {
    const ao = typeof a?.joinOrder === "number" ? a.joinOrder : 9999;
    const bo = typeof b?.joinOrder === "number" ? b.joinOrder : 9999;
    return ao - bo;
  });
  return String(ordered[idx]?.id || "") === meId;
}

/** flags: keep compatible with your fillFlags strict boolean noPeek,
 *  but also tolerate array forms (future-proof). */
function getFlags(flagsRound, meId = null) {
  const fr = flagsRound || {};
  const noPeek = fr.noPeek === true; // STRICT boolean only (no arrays)
  return {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: false,
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
    holdStill: {},
    denIntel: {},
    ...(fr || {}),
    noPeek, // override after spread
  };
}

function hasActionIdInHand(hand, actionId) {
  const h = safeArr(hand);
  for (const raw of h) {
    const name = String(raw?.name || raw || "").trim();
    if (!name) continue;
    const def = getActionDefByName(name);
    if (String(def?.id || "") === String(actionId)) return true;
  }
  return false;
}

/** =========================
 *  Peek intel (N=3..5)
 *  ========================= */
export function getPeekIntel({ game, me, flagsRound = null, lookaheadN = null }) {
  const n = Number.isFinite(Number(lookaheadN)) ? Number(lookaheadN) : DEFAULTS.lookaheadN;
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));

  if (flags.noPeek) {
    const known = safeArr(me?.knownUpcomingEvents).filter(Boolean).map(String);
    const events = known.slice(0, n);
    return { mode: "known", confidence: events.length ? Math.min(1, events.length / n) : 0, events };
  }

  const events = [];
  for (let k = 0; k < n; k++) {
    const id = nextEventId(game, k);
    if (!id) break;
    events.push(String(id));
  }
  return { mode: "peek", confidence: events.length ? 1 : 0, events };
}
/** =========================
 *  Risk model (0..10)
 *  ========================= */
function eventDangerForChoice({ eventId, choice, game, me, players, flagsRound }) {
  if (!eventId) return 0;

  const ch = String(choice || "").toUpperCase();
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));
  const den = normColor(me?.color || me?.den || me?.denColor);
  const immune = !!flags?.denImmune?.[den];
  const isLead = computeIsLead(game, me, players);

  const eid = String(eventId);
  const facts = getEventFacts(eid, { game, me, denColor: den, isLead, flagsRound: flagsRound || game?.flagsRound });
  if (!facts) return 0;

  // LEAD-only event? If I'm not lead, it's 0 danger.
  if (!isLead && String(facts.appliesTo || "").toUpperCase() === "LEAD") return 0;

  // Den Signal immunity applies to DEN_* and DOG_CHARGE/SECOND_CHARGE (NOT Sheepdog Patrol)
  const t = classifyEvent(eid).type;
  if (immune && (t === "DOG" || t === "DEN")) return 0;

  const dDash = Number(facts.dangerDash || 0);
  const dLurk = Number(facts.dangerLurk || 0);
  const dBurrow = Number(facts.dangerBurrow || 0);

  // Rooster Crow: alleen de 3e crow is dodelijk (dan wordt iedereen in RAID/YARD gevangen).
  // De 1e en 2e crow zijn TEMPO, geen caught-risk -> danger = 0 voor stay.
  if (eid === "ROOSTER_CROW") {
    const seen = countRevealedRoosters(game);
    if (seen >= 2) {
      if (ch === "DASH") return 0;
      return 10; // LURK/BURROW gegarandeerd gevangen (3e crow)
    }
    // 1e/2e crow: niet gevaarlijk
    if (ch === "DASH") return 0;
    return 0;
  }
// Fence Patrol: GREEN burrow gets caught
  if (eid === "FENCE_PATROL") {
    if (ch === "BURROW" && den === "GREEN") return 10;
    if (ch === "BURROW") return Math.max(dBurrow, 7);
    if (ch === "LURK") return Math.min(dLurk, 2);
  }

  if (ch === "DASH") return dDash;
  if (ch === "BURROW") return dBurrow;
  return dLurk;
}

function peakDangerForEvent({ eventId, game, me, players, flagsRound }) {
  return Math.max(
    eventDangerForChoice({ eventId, choice: "DASH",   game, me, players, flagsRound }),
    eventDangerForChoice({ eventId, choice: "LURK",   game, me, players, flagsRound }),
    eventDangerForChoice({ eventId, choice: "BURROW", game, me, players, flagsRound }),
  );
}

/** =========================
 *  DECISION
 *  ========================= */
function getDashPush(me, cfg = null) {
  // dashPush is persisted on player doc and updated over time (0..10).
  // Never derive it from carry/loot. If missing, assume 0.
  return clamp(Number(me?.dashPush ?? 0), 0, 10);
}

function countRevealedRoosters(game) {
  // Public info only. Never infer from eventTrack (noPeek-safe).
  const n = Number(game?.roosterSeen);
  return Number.isFinite(n) ? n : 0;
}

function estimateLikelyDashers({ game, players, me, cfg }) {
  // Very rough: who already has high dashPush while still in-yard.
  const c = cfg || DEFAULTS;
  const meId = String(me?.id || "");
  const inYard = safeArr(players).filter((p) => isInYard(p) && String(p?.id || "") !== meId);

  const base = Number(c?.canonDashPushBase ?? DEFAULTS.canonDashPushBase ?? 7.0);
  let count = 0;
  for (const p of inYard) {
    const push = getDashPush(p, c);
    if (push >= base) count++;
  }
  return count;
}

function avgLootDeckValue(game) {
  const deck = safeArr(game?.lootDeck);
  if (!deck.length) return 1.5;
  let s = 0;
  for (const c of deck) s += lootCardValue(c);
  return s / deck.length;
}

// Hidden Nest anti-herding coordinator (deterministic slots)
function hash32(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hiddenNestSlots(n) {
  if (n <= 2) return n;
  if (n === 3) return 1;
  return 2; // 4+ -> max 2 dashers (keep bonus meaningful)
}
function isMeAllowedToDashHiddenNest({ game, players, meId }) {
  const inYard = safeArr(players).filter((p) => isInYard(p));
  const slots = hiddenNestSlots(inYard.length);
  const keyBase = `${String(game?.id || game?.gameId || "raid")}|r${Number(game?.round || 0)}`;

  const ranked = inYard
    .map((p) => ({ id: String(p?.id || ""), k: hash32(`${keyBase}|${String(p?.id || "")}`) }))
    .filter((x) => x.id)
    .sort((a, b) => a.k - b.k)
    .slice(0, slots)
    .map((x) => x.id);

  return ranked.includes(String(meId));
}

function canonCountDashers(players = []) {
  let n = 0;
  for (const p of safeArr(players)) {
    if (!p) continue;
    const status = String(p?.raidStatus || p?.status || "").toUpperCase();
    const dashed =
      p?.hasDashed === true ||
      status === "DASH" ||
      (typeof p?.decision === "string" && String(p.decision).toUpperCase() === "DASH");
    if (dashed) n++;
  }
  return n;
}

function canonIsBurrowReady(me) {
  const used = !!(me?.burrowUsedThisRaid ?? me?.burrowUsed);
  if (used) return false;
  if (me?.burrowCharges != null) return Number(me.burrowCharges) > 0;
  return true;
}

function canonDenSignalRelevant({ game, me, flags, nextId }) {
  const den = normColor(me?.color || me?.den || me?.denColor);
  const immune = !!flags?.denImmune?.[den];
  if (!immune) return false;

  const eid = String(nextId || "");
  // Den Signal canon: only matters if it actually neutralizes the upcoming threat
  return eid.startsWith("DEN_") || eid === "DOG_CHARGE" || eid === "SECOND_CHARGE";
}

function canonIsRooster3({ game, nextId, nextFacts }) {
  const eid = String(nextId || "");
  if (eid !== "ROOSTER_CROW") return false;

  // Prefer explicit tag if rulesIndex provides it
  const tags = new Set(safeArr(nextFacts?.tags || nextFacts?.rules?.tags || nextFacts?.meta?.tags));
  if (tags.has("raid_end_trigger")) return true;

  // Fallback: public rooster counter
  const seen = countRevealedRoosters(game);
  return seen >= 2;
}

function canonDashPushThreshold(c, dashers) {
  const base = Number(c?.canonDashPushBase ?? DEFAULTS.canonDashPushBase ?? 7.0);
  const cap = Number(c?.canonDashPushDashersBonusCap ?? DEFAULTS.canonDashPushDashersBonusCap ?? 3);
  const bonus = Math.min(cap, Math.max(0, Number(dashers || 0)));
  return base + bonus;
}

function canonUpdateDashPush({ cfg, dashPushNow, safeNow, dangerStay, endPressure }) {
  const c = cfg || DEFAULTS;
  let dp = clamp(Number(dashPushNow ?? 0), 0, 10);

  const safeDecay = Number(c?.canonDashPushSafeDecay ?? DEFAULTS.canonDashPushSafeDecay ?? 1.0);
  const unsafeGainMax = Number(c?.canonDashPushUnsafeGainMax ?? DEFAULTS.canonDashPushUnsafeGainMax ?? 2.0);
  const endBoost = Number(c?.canonDashPushEndPressureBoost ?? DEFAULTS.canonDashPushEndPressureBoost ?? 2.0);

  if (safeNow) {
    dp = Math.max(0, dp - safeDecay);
  } else {
    // gain based on "how unsafe staying is"
    const gain = clamp((Number(dangerStay) - 5.0) / 2.0, 0, unsafeGainMax);
    dp = dp + gain;
    if (endPressure) dp = dp + endBoost;
  }

  return clamp(dp, 0, 10);
}

/** =========================
 *  DECISION (CANON)
 *  ========================= */
export function evaluateDecision({ game, me, players, flagsRound = null, cfg = null, peekIntel = null }) {
  const cfg0 = { ...DEFAULTS, ...(cfg || {}) };
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));
  const intel = peekIntel || getPeekIntel({ game, me, flagsRound: flags, lookaheadN: cfg0.lookaheadN });

  const events = safeArr(intel?.events).filter(Boolean).map(String);

  // noPeek safety: only use known upcoming events; never peek track here
  const nextId = events[0] || (!flags.noPeek ? nextEventId(game, 0) : null);

  // If we genuinely don't know the next event, default to LURK (caller should avoid strategy in this case).
  if (!nextId) {
    return {
      decision: "LURK",
      meta: { reason: "no_intel", dashPushNext: getDashPush(me, cfg0), intel },
    };
  }

  const den = normColor(me?.color || me?.den || me?.denColor);
  const isLead = computeIsLead(game, me, players);

  const nextFacts = getEventFacts(String(nextId), { game, me, denColor: den, isLead, flagsRound: flagsRound || game?.flagsRound });

  // danger of staying in-yard for the REVEAL
  const dangerStay = eventDangerForChoice({ eventId: nextId, choice: "LURK", game, me, players, flagsRound });

  // CANON: Den Signal (when relevant) makes you safe -> always LURK
  const denSignalSafe = canonDenSignalRelevant({ game, me, flags, nextId });

  const safeMax = Number(cfg0.canonSafeDangerMax ?? DEFAULTS.canonSafeDangerMax ?? 3.0);
  const cautionMax = Number(cfg0.canonCautionDangerMax ?? DEFAULTS.canonCautionDangerMax ?? 5.0);
  const highMin = Number(cfg0.canonHighDangerMin ?? DEFAULTS.canonHighDangerMin ?? 6.5);
  const critMin = Number(cfg0.canonCritDangerMin ?? DEFAULTS.canonCritDangerMin ?? 8.5);

  const safeNow = denSignalSafe || Number(dangerStay) <= safeMax;

  const isRooster3 = canonIsRooster3({ game, nextId, nextFacts });

  // end-pressure in noPeek: either we know rooster3, or we have probabilistic pressure
  const pThird = Number(me?.pThirdRooster ?? me?.metrics?.pThirdRooster ?? 0);
  const pThirdThr = Number(cfg0.canonPThirdRoosterThreshold ?? DEFAULTS.canonPThirdRoosterThreshold ?? 0.75);
  const endPressure = isRooster3 || (flags.noPeek && pThird >= pThirdThr);

  const dashers = canonCountDashers(players);
  const dashPushNow = getDashPush(me, cfg0);
  const dashPushNext = canonUpdateDashPush({ cfg: cfg0, dashPushNow, safeNow, dangerStay, endPressure });
  const dashPushThreshold = canonDashPushThreshold(cfg0, dashers);

  const burrowReady = canonIsBurrowReady(me);

  // ===== RULE 1: Rooster3 -> DASH always (anyone still in yard gets caught)
  if (isRooster3) {
    return {
      decision: "DASH",
      meta: { nextEventIdUsed: nextId, isRooster3, dangerStay, safeNow, dashers, dashPushNow, dashPushNext, dashPushThreshold, intel },
    };
  }

  // ===== RULE 3: safe -> LURK
  if (safeNow) {
    return {
      decision: "LURK",
      meta: { nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow, dashers, dashPushNow, dashPushNext, dashPushThreshold, intel },
    };
  }

  // ===== Emergency / high danger -> BURROW else DASH
  if (Number(dangerStay) >= critMin || Number(dangerStay) >= highMin) {
    return {
      decision: burrowReady ? "BURROW" : "DASH",
      meta: { nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow, dashers, dashPushNow, dashPushNext, dashPushThreshold, intel },
    };
  }

  // ===== Caution zone: still LURK, but build dashPush
  if (Number(dangerStay) <= cautionMax) {
    return {
      decision: "LURK",
      meta: { nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow, dashers, dashPushNow, dashPushNext, dashPushThreshold, intel },
    };
  }

  // ===== dashPush trigger (only when not safe): BURROW is the anti-DASH brake
  if (dashPushNext >= dashPushThreshold) {
    return {
      decision: burrowReady ? "BURROW" : "DASH",
      meta: { nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow, dashers, dashPushNow, dashPushNext, dashPushThreshold, intel },
    };
  }

  // ===== default: unsafe -> BURROW else DASH
  return {
    decision: burrowReady ? "BURROW" : "DASH",
    meta: { nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow, dashers, dashPushNow, dashPushNext, dashPushThreshold, intel },
  };
}

function evaluateShiftPlan({ game, me, players, flagsRound, cfg, peekIntel }) {
  const c = cfg || DEFAULTS;
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));
  if (flags.lockEvents) return null;

  const team = safeArr(players).filter((p) => isInYard(p) && isSameDen(p, me) && String(p.id) !== String(me.id));
  const enemies = safeArr(players).filter((p) => isInYard(p) && !isSameDen(p, me));

  const events = safeArr(peekIntel?.events);
  if (events.length < 2) return null;

  const idxBase = Number.isFinite(Number(game?.eventIndex)) ? Number(game.eventIndex) : 0;
  const weights = [1.0, 0.65, 0.42, 0.28, 0.18];
  const wAt = (k) => weights[k] ?? Math.max(0.12, 0.18 * Math.pow(0.7, k));

  function weightedPeak(pl, evs) {
    let s = 0;
    for (let k = 0; k < evs.length; k++) {
      const pd = peakDangerForEvent({ eventId: evs[k], game, me: pl, players, flagsRound: flags });
      s += pd * wAt(k);
    }
    return s;
  }

  const baseTeam = weightedPeak(me, events) + team.reduce((acc, pl) => acc + weightedPeak(pl, events), 0);
  const baseEnemies = enemies.reduce((acc, pl) => {
    const carryW = 1 + Math.min(2.0, sumLootPoints(pl) / 6);
    return acc + weightedPeak(pl, events) * carryW;
  }, 0);

  let best = null;

  for (let i = 0; i < events.length - 1; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const newEvents = events.slice();
      [newEvents[i], newEvents[j]] = [newEvents[j], newEvents[i]];

      const t = weightedPeak(me, newEvents) + team.reduce((acc, pl) => acc + weightedPeak(pl, newEvents), 0);
      const e = enemies.reduce((acc, pl) => {
        const carryW = 1 + Math.min(2.0, sumLootPoints(pl) / 6);
        return acc + weightedPeak(pl, newEvents) * carryW;
      }, 0);

      const teamImprove = baseTeam - t;        // positive good
      const enemyWorsen = e - baseEnemies;     // positive good
      const utilityGain = c.wTeam * teamImprove + c.wDeny * enemyWorsen;

      if (!best || utilityGain > best.utilityGain) {
        best = {
          utilityGain,
          swapOffsets: [i, j],
          swapIndices: [idxBase + i, idxBase + j],
          summary: { teamImprove, enemyWorsen },
        };
      }
    }
  }

  return best;
}

function roughActionValue(facts, ctx) {
  if (!facts) return 0.4;
  const tags = safeArr(facts.tags).map((t) => String(t || "").toUpperCase());
  const has = (t) => tags.includes(String(t).toUpperCase());

  let v = 0;
  if (has("DEN_IMMUNITY")) v += 4;
  if (has("TRACK_MANIP")) v += 3;
  if (has("LOCK_EVENTS")) v += 1.5;
  if (has("PREDICT_EVENT")) v += 2.2;
  if (has("INFO") || has("PEEK_DECISION")) v += 1.1;

  // in peek-mode, info less valuable
  if (ctx?.intel?.mode === "peek" && (has("INFO") || has("PEEK_DECISION") || has("PREDICT_EVENT"))) v *= 0.6;

  // if next event is dangerous, defense/control up
  const nextId = safeArr(ctx?.intel?.events)[0] || nextEventId(ctx?.game, 0);
  const dangerNext = nextId ? peakDangerForEvent({ eventId: nextId, game: ctx.game, me: ctx.me, players: ctx.players, flagsRound: ctx.flags }) : 0;
  if (dangerNext >= 6 && (has("DEN_IMMUNITY") || has("TRACK_MANIP") || has("LOCK_EVENTS"))) v *= 1.25;

  return v;
}

function avgActionDeckValue(game, ctx, cfg) {
  const c = cfg || DEFAULTS;
  const deck = safeArr(game?.actionDeck);
  if (!deck.length) return 0;

  const sampleN = Math.max(8, Number(c.actionDeckSampleN || 30));
  const n = Math.min(deck.length, sampleN);

  let s = 0;
  let used = 0;

  for (let i = deck.length - 1; i >= 0 && used < n; i--) {
    const raw = deck[i];
    const name = String(raw?.name || raw || "").trim();
    if (!name) continue;
    const def = getActionDefByName(name);
    const facts = def?.id ? getActionFacts(def.id) : null;
    s += roughActionValue(facts, ctx);
    used++;
  }

  return used ? s / used : 0.8;
}

export function evaluateMoveOptions({ game, me, players, flagsRound = null, cfg = null }) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));
  const intel = getPeekIntel({ game, me, flagsRound: flags, lookaheadN: c.lookaheadN });

  const lootDeck = safeArr(game?.lootDeck);
  const actionDeck = safeArr(game?.actionDeck);
  const loot = safeArr(me?.loot);

  const carry = sumLootPoints(me);
  const dashPush = getDashPush(me, c);
  const ctx = { game, me, players, flags, intel, carry, dashPush };

  const options = [];

  // SNATCH: draw 1 loot
  if (lootDeck.length > 0) {
    const exp = avgLootDeckValue(game);
    let u = c.wLoot * exp;

    // hard-ish guard: next is Gate Toll + 0 loot => SNATCH becomes very valuable
    const next0 = safeArr(intel?.events)[0] || nextEventId(game, 0);
    if (String(next0) === "GATE_TOLL" && carry <= 0) u += 2.0;

    options.push({ move: "SNATCH", utility: u, expLoot: exp, note: "draw 1 loot" });
  }

  // FORAGE: draw up to 2 action cards
  if (actionDeck.length > 0) {
    const drawn = Math.min(2, actionDeck.length);
    const expCard = avgActionDeckValue(game, ctx, c);
    const exp = expCard * drawn;
    options.push({ move: "FORAGE", utility: exp, expAction: exp, note: `draw ${drawn} action(s)` });
  }

  // SCOUT: low in peek-mode; higher only when noPeek=true
  if (!flags.scatter) {
    const v = flags.noPeek ? 3.0 : c.scoutBaseValue;
    options.push({ move: "SCOUT", utility: v, note: flags.noPeek ? "reveal upcoming events" : "low value (peek)" });
  }

  // SHIFT: swap 2 upcoming events, pay cost: highest loot to bottom deck
  if (!flags.lockEvents && loot.length > 0 && intel.events.length >= 2) {
    const plan = evaluateShiftPlan({ game, me, players, flagsRound: flags, cfg: c, peekIntel: intel });
    if (plan) {
      const idxHighest = highestLootCardIndex(loot);
      const costV = idxHighest >= 0 ? lootCardValue(loot[idxHighest]) : 0;
      const net = plan.utilityGain - c.wResource * costV;
      options.push({ move: "SHIFT", utility: net, plan, costV, note: "swap upcoming events + pay loot" });
    }
  }

  if (!options.length) return { best: { move: "SNATCH", utility: 0, note: "fallback" }, ranked: [], intel };

  const ranked = options.slice().sort((a, b) => b.utility - a.utility);
  let best = ranked[0];

  // SHIFT gating
  if (best.move === "SHIFT") {
    const second = ranked[1] || null;
    const gainOverSecond = best.utility - (second?.utility ?? -1e9);
    if (gainOverSecond < c.shiftMinGain) best = second || best;
  }

  // hard guard (runner-style): Gate Toll + 0 loot => prefer SNATCH if possible
  const next0 = safeArr(intel?.events)[0] || nextEventId(game, 0);
  if (String(next0) === "GATE_TOLL" && carry <= 0) {
    const sn = ranked.find((x) => x.move === "SNATCH");
    if (sn) best = sn;
  }

  return { best, ranked, intel };
}

/** =========================
 *  OPS(ACTIONS)
 *  ========================= */

function opsStageFromGame(game, cfg) {
  const c = cfg || DEFAULTS;
  const r = Number(game?.round || 0);
  const idx = Number.isFinite(Number(game?.eventIndex)) ? Number(game.eventIndex) : 0;
  const len = safeArr(game?.eventTrack).length || 1;
  const pct = clamp(idx / len, 0, 1);

  const early = (r > 0 && r <= Number(c.opsEarlyRounds || 2)) || pct < 0.25;
  const late = pct >= 0.75;

  const stage = early ? "early" : (late ? "late" : "mid");
  const reserveTarget =
    stage === "early" ? Number(c.opsReserveHandEarly || 4) :
    stage === "late" ? Number(c.opsReserveHandLate || 2) :
    Number(c.opsReserveHandMid || 3);

  const spendMult =
    stage === "early" ? Number(c.opsSpendCostEarlyMult || 1.35) :
    stage === "late" ? Number(c.opsSpendCostLateMult || 0.75) : 1.0;

  return { stage, pct, idx, len, round: r, reserveTarget, spendMult };
}

function discardActionIdsFromGame(game) {
  const disc = safeArr(game?.actionDiscard || game?.actionDiscardPile || game?.actionDiscarded || []);
  const ids = [];
  for (const raw of disc) {
    const name = String(raw?.name || raw || "").trim();
    if (!name) continue;
    const def = getActionDefByName(name);
    const id = String(def?.id || "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

function handActionIds(hand) {
  const ids = [];
  for (const raw of safeArr(hand)) {
    const name = String(raw?.name || raw || "").trim();
    if (!name) continue;
    const def = getActionDefByName(name);
    const id = String(def?.id || "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

function computeComboMeta(actionIds, ctxCombo, cfg) {
  const c = cfg || DEFAULTS;
  const ids = safeArr(actionIds).map((x) => String(x || "")).filter(Boolean);

  const keyScoreById = {};   // beste symmetrische score (A<->B)
  const outBestById = {};    // beste A -> B
  const inBestById = {};     // beste B -> A (incoming voor A)
  let maxComboScore = 0;

  for (let i = 0; i < ids.length; i++) {
    const a = ids[i];
    let bestSym = 0;
    let bestOut = 0;
    let bestIn = 0;

    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const b = ids[j];

      const out = Number(comboScore(a, b, ctxCombo) || 0);
      const inn = Number(comboScore(b, a, ctxCombo) || 0);
      const sym = Math.max(out, inn);

      if (out > bestOut) bestOut = out;
      if (inn > bestIn) bestIn = inn;
      if (sym > bestSym) bestSym = sym;
      if (sym > maxComboScore) maxComboScore = sym;
    }

    keyScoreById[a] = bestSym;
    outBestById[a] = bestOut;
    inBestById[a] = bestIn;
  }

  const highCombo = ids.length >= 2 && maxComboScore >= Number(c.opsHighComboScore || 8);
  return { maxComboScore, keyScoreById, outBestById, inBestById, highCombo };
}

// If rulesIndex marks these “unimplemented” but botRunner DOES apply them, treat as implemented here.
const RUNNER_IMPLEMENTED = new Set([
  "DEN_SIGNAL",
  "ALPHA_CALL",
  "NO_GO_ZONE",
  "BURROW_BEACON",
  "SCATTER",
  "SCENT_CHECK",
  "FOLLOW_THE_TAIL",
  "MOLTING_MASK",
  "NOSE_FOR_TROUBLE",
  "MASK_SWAP",
  "PACK_TINKER",
  "KICK_UP_DUST",
  "HOLD_STILL", // still downweighted by rulesIndex, but at least doesn't get annihilated
]);

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) {
  const str = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function shuffleArraySeeded(arr, rnd) {
  const a = safeArr(arr).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickPackTinkerSwapLikeRunner(game) {
  const track = safeArr(game?.eventTrack).slice();
  const idx = Number.isFinite(Number(game?.eventIndex)) ? Number(game.eventIndex) : 0;
  if (track.length < 2) return null;
  if (idx >= track.length - 1) return null;

  const nextId = track[idx];
  const nextType = classifyEvent(nextId);
  let j = -1;

  for (let k = track.length - 1; k > idx; k--) {
    const t = classifyEvent(track[k]);
    if (nextType.type === "DOG") {
      if (t.type !== "DOG") { j = k; break; }
    } else {
      j = k; break;
    }
  }
  if (j <= idx) return null;
  return [idx, j];
}

function simulateActionOnce({ play, game, me, players, flagsRound, cfg, seedTag = "" }) {
  const g = structuredCloneSafe(game || {});
  const flags = getFlags(flagsRound || g?.flagsRound, String(me?.id || ""));
  const simPlayers = structuredCloneSafe(safeArr(players || []));
  const p = structuredCloneSafe(me || {});
  const meId = String(p?.id || "");

  const actionId = String(play?.actionId || "");
  const targetId = play?.targetId ? String(play.targetId) : null;

  // helpers
  const idxOf = (pid) => simPlayers.findIndex((x) => String(x?.id || "") === String(pid || ""));

  // Apply effects like botRunner does:
  if (actionId === "DEN_SIGNAL") {
    const myDen = normColor(p?.color || p?.den || p?.denColor);
    const di = { ...(flags.denImmune || {}) };
    if (myDen) di[myDen] = true;
    flags.denImmune = di;
  }

  if (actionId === "ALPHA_CALL") {
  // match player.js: leadIndex is index binnen active yard (joinOrder sorted)
  const orderedAll = safeArr(simPlayers).slice().sort((a, b) => {
    const ao = typeof a?.joinOrder === "number" ? a.joinOrder : 9999;
    const bo = typeof b?.joinOrder === "number" ? b.joinOrder : 9999;
    return ao - bo;
  });
  const activeOrdered = orderedAll.filter(isInYard);
  const baseList = activeOrdered.length ? activeOrdered : orderedAll;

  const idx = baseList.findIndex(x => String(x?.id) === String(targetId));
  if (idx >= 0) g.leadIndex = idx;
}

  if (actionId === "NO_GO_ZONE") {
    flags.opsLocked = true;
  }

  if (actionId === "BURROW_BEACON") {
    flags.lockEvents = true;
  }

  if (actionId === "SCATTER") {
    flags.scatter = true;
  }

  if (actionId === "HOLD_STILL") {
    if (targetId) {
      const hs = { ...(flags.holdStill || {}) };
      hs[targetId] = true;
      flags.holdStill = hs;
    }
  }

  if (actionId === "SCENT_CHECK") {
    const arr = safeArr(flags.scentChecks).slice();
    if (meId && !arr.includes(meId)) arr.push(meId);
    flags.scentChecks = arr;
  }

  if (actionId === "FOLLOW_THE_TAIL") {
    if (meId && targetId) {
      const ft = { ...(flags.followTail || {}) };
      ft[meId] = targetId;
      flags.followTail = ft;
    }
  }

  if (actionId === "MOLTING_MASK") {
    flags.noPeek = true;
  }

  if (actionId === "NOSE_FOR_TROUBLE") {
    const ev = nextEventId(g, 0) || nextEventId(g, 1);
    if (ev && meId) {
      const preds = safeArr(flags.predictions).slice();
      const filtered = preds.filter((x) => String(x?.playerId || "") !== meId);
      filtered.push({ playerId: meId, eventId: String(ev), at: Date.now() });
      flags.predictions = filtered;
    }
  }

  if (actionId === "MASK_SWAP" && targetId) {
    const ti = idxOf(targetId);
    if (ti >= 0) {
      const t = simPlayers[ti];
      const a = normColor(p.color);
      const b = normColor(t.color);
      if (a && b && a !== b) {
        // swap colors locally
        t.color = a; t.den = a;
        p.color = b; p.den = b;

        // also update simPlayers me entry
        const mi = idxOf(meId);
        if (mi >= 0) {
          simPlayers[mi].color = p.color;
          simPlayers[mi].den = p.color;
        }
      }
    }
  }

  if (actionId === "PACK_TINKER") {
    if (!flags.lockEvents) {
      const pair = pickPackTinkerSwapLikeRunner(g);
      if (pair) {
        const [i1, i2] = pair;
        const trackNow = safeArr(g.eventTrack).slice();
        if (trackNow[i1] && trackNow[i2]) {
          [trackNow[i1], trackNow[i2]] = [trackNow[i2], trackNow[i1]];
          g.eventTrack = trackNow;
          clearScoutIntelForAll([p, ...simPlayers]);
        }
      }
    }
  }

  if (actionId === "KICK_UP_DUST") {
    if (!flags.lockEvents) {
      const track = safeArr(g.eventTrack).slice();
      const idx = Number.isFinite(Number(g?.eventIndex)) ? Number(g.eventIndex) : 0;
      const locked = track.slice(0, idx);
      const future = track.slice(idx);
      if (future.length > 1) {
        const seed = hashSeed(`${seedTag}|${meId}|${g.round}|${g.eventIndex}|${track.length}`);
        const rnd = mulberry32(seed);
        g.eventTrack = [...locked, ...shuffleArraySeeded(future, rnd)];
        clearScoutIntelForAll([p, ...simPlayers]);
      }
    }
  }

  // return simulated snapshot
  return { game: g, me: p, players: simPlayers, flagsRound: flags };
}

function actionCandidates({ actionId, actionName, game, me, players }) {
  const inYard = safeArr(players).filter(isInYard);
  const enemies = inYard.filter((p) => !isSameDen(p, me) && String(p.id) !== String(me.id));
  const allies = inYard.filter((p) => isSameDen(p, me) && String(p.id) !== String(me.id));

  // target pickers
  const richest = (arr) => arr.slice().sort((a, b) => sumLootPoints(b) - sumLootPoints(a))[0]?.id || null;

  if (actionId === "MASK_SWAP" || actionId === "HOLD_STILL") {
    const t = richest(enemies);
    return t ? [{ actionId, name: actionName, targetId: t }] : [];
  }

  if (actionId === "SCENT_CHECK") {
    // mimic runner: target with most knownUpcomingEvents else richest
    const intelTarget =
      inYard
        .filter((x) => x?.id && x.id !== me.id)
        .map((x) => ({
          id: x.id,
          k: Array.isArray(x?.knownUpcomingEvents) ? x.knownUpcomingEvents.length : 0,
          loot: sumLootPoints(x),
        }))
        .sort((a, b) => (b.k - a.k) || (b.loot - a.loot))[0]?.id || null;

    const t = intelTarget || richest(enemies) || richest(allies);
    return t ? [{ actionId, name: actionName, targetId: t }] : [];
  }

  if (actionId === "FOLLOW_THE_TAIL") {
    // prefer safest target; fallback richest
    let best = null;
    const intel = getPeekIntel({ game, me, flagsRound: game?.flagsRound, lookaheadN: DEFAULTS.lookaheadN });

    const candidates = enemies.concat(allies);
    for (const t of candidates) {
      const res = evaluateDecision({ game, me: t, players, flagsRound: game?.flagsRound, cfg: DEFAULTS, peekIntel: intel });
      const risk = Number(res?.ranked?.[0]?.riskNow ?? 0);
      const score = -risk + 0.25 * sumLootPoints(t);
      if (!best || score > best.score) best = { id: t.id, score };
    }
    const pick = best?.id || richest(enemies) || richest(allies);
    return pick ? [{ actionId, name: actionName, targetId: pick }] : [];
  }

  if (actionId === "ALPHA_CALL") {
  // simpele, stabiele keuze: maak de rijkste andere vos Lead (meestal “pest”)
  const t = richest(enemies) || richest(allies) || richest(inYard.filter(x => String(x.id) !== String(me.id)));
  return t ? [{ actionId, name: actionName, targetId: t }] : [];
}

  // no target
  return [{ actionId, name: actionName, targetId: null }];
}

const MULTIPLAYER_VALUE_ACTIONS = new Set([
  "MASK_SWAP",
  "FOLLOW_THE_TAIL",
  "SCENT_CHECK",
  "HOLD_STILL",
  "NO_GO_ZONE",
  "BURROW_BEACON",
  "SCATTER",
  "ALPHA_CALL",
]);

function opsParticipantCount(game, players) {
  const order = safeArr(game?.opsTurnOrder);
  if (order.length) return order.length;
  return safeArr(players).filter(isInYard).length;
}

function opsRemainingCount(game) {
  const order = safeArr(game?.opsTurnOrder);
  const i = Number.isFinite(Number(game?.opsTurnIndex)) ? Number(game.opsTurnIndex) : 0;
  if (!order.length) return 0;
  return Math.max(0, order.length - i - 1);
}

function clearScoutIntelForAll(playersArr) {
  for (const pl of (playersArr || [])) {
    if (!pl) continue;
    if (Array.isArray(pl.knownUpcomingEvents)) pl.knownUpcomingEvents = [];
    else if (pl.knownUpcomingEvents != null) pl.knownUpcomingEvents = [];
  }
}

function scoreOpsPlay({ play, game, me, players, flagsRound, cfg }) {
  const c = cfg || DEFAULTS;
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));
  const intel0 = getPeekIntel({ game, me, flagsRound: flags, lookaheadN: c.lookaheadN });

  const baseDecision = evaluateDecision({ game, me, players, flagsRound: flags, cfg: c, peekIntel: intel0 });
  const baseU = Number(baseDecision?.ranked?.[0]?.utility ?? 0);

  const actionId = String(play?.actionId || "");

  // Kick Up Dust: average over samples (because real is random)
  const sims =
    actionId === "KICK_UP_DUST" && !flags.lockEvents
      ? Array.from({ length: Math.max(2, Number(c.kickUpDustSamples || 6)) }, (_, i) =>
          simulateActionOnce({ play, game, me, players, flagsRound: flags, cfg: c, seedTag: `KUD#${i}` })
        )
      : [simulateActionOnce({ play, game, me, players, flagsRound: flags, cfg: c, seedTag: "ONE" })];

  // aggregate deltas
  let utilitySum = 0;

  for (const sim of sims) {
    const intel1 = getPeekIntel({ game: sim.game, me: sim.me, flagsRound: sim.flagsRound, lookaheadN: c.lookaheadN });

    const afterDecision = evaluateDecision({ game: sim.game, me: sim.me, players: sim.players, flagsRound: sim.flagsRound, cfg: c, peekIntel: intel1 });
    const afterU = Number(afterDecision?.ranked?.[0]?.utility ?? 0);

    // team/enemy deltas
    const inYard = safeArr(sim.players).filter(isInYard);
    const allies = inYard.filter((p) => isSameDen(p, sim.me) && String(p.id) !== String(sim.me.id));
    const enemies = inYard.filter((p) => !isSameDen(p, sim.me));

    let teamDelta = 0;
    for (const a of allies) {
      const bi = getPeekIntel({ game, me: a, flagsRound: flags, lookaheadN: c.lookaheadN });
      const b = evaluateDecision({ game, me: a, players, flagsRound: flags, cfg: c, peekIntel: bi });
      const bU = Number(b?.ranked?.[0]?.utility ?? 0);

      const ai = getPeekIntel({ game: sim.game, me: a, flagsRound: sim.flagsRound, lookaheadN: c.lookaheadN });
      const a2 = evaluateDecision({ game: sim.game, me: a, players: sim.players, flagsRound: sim.flagsRound, cfg: c, peekIntel: ai });
      const aU = Number(a2?.ranked?.[0]?.utility ?? 0);

      teamDelta += aU - bU;
    }

    let denyDelta = 0;
    for (const e of enemies) {
      const bi = getPeekIntel({ game, me: e, flagsRound: flags, lookaheadN: c.lookaheadN });
      const b = evaluateDecision({ game, me: e, players, flagsRound: flags, cfg: c, peekIntel: bi });
      const bU = Number(b?.ranked?.[0]?.utility ?? 0);

      const ai = getPeekIntel({ game: sim.game, me: e, flagsRound: sim.flagsRound, lookaheadN: c.lookaheadN });
      const a2 = evaluateDecision({ game: sim.game, me: e, players: sim.players, flagsRound: sim.flagsRound, cfg: c, peekIntel: ai });
      const aU = Number(a2?.ranked?.[0]?.utility ?? 0);

      denyDelta += (bU - aU); // enemy utility down => positive deny
    }

    // implementation multiplier
    let implMult = 1;
    const facts = getActionFacts(actionId);
    if (facts?.engineImplemented === false && !RUNNER_IMPLEMENTED.has(actionId)) implMult = c.actionUnimplementedMult;

    let u = implMult * ((afterU - baseU) + c.wTeam * teamDelta + c.wDeny * denyDelta);

    // apply optimism for random shuffle (avoid overfitting to one sample)
    if (actionId === "KICK_UP_DUST") {
      u = (c.kickUpDustOptimism * u) + ((1 - c.kickUpDustOptimism) * 0.0);
    }

    utilitySum += u;
  }

  let utility = utilitySum / sims.length;

// Multiplayer/tempo bonus: deze kaarten “doen” weinig in decision-simulatie,
// maar zijn wél waardevol als er veel spelers te raken zijn (vooral early).
if (MULTIPLAYER_VALUE_ACTIONS.has(actionId)) {
  const stage0 = opsStageFromGame(game, c);
  const n = opsParticipantCount(game, players);          // hoeveel spelers in de Yard/ops
  const remaining = opsRemainingCount(game);             // hoeveel moeten nog handelen na jou

  const presence = clamp((n - 1) / 3, 0, 1);             // 1=>0, 2=>0.33, 4=>1
  const rem = clamp(remaining / 3, 0, 1);                // 0..1

  const stageMult =
    stage0.stage === "early" ? Number(c.opsMultiStageEarlyMult || 1.2) :
    stage0.stage === "late" ? Number(c.opsMultiStageLateMult || 0.85) :
    1.0;

  const base = Number(c.opsMultiPlayerBaseBonus || 0.55);
  const soloPenalty = (n <= 1) ? Number(c.opsMultiPlayerSoloPenalty || 0.75) : 0;

  const bonus = base * presence * (0.5 + 0.5 * rem) * stageMult;
  utility = utility + bonus - soloPenalty;
}

return { play, utility, baseU };

}

export function evaluateOpsActions({ game, me, players, flagsRound = null, cfg = null }) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));

  if (flags.opsLocked) return { best: { kind: "PASS", utility: 0, reason: "opsLocked" }, ranked: [] };

  const hand = safeArr(me?.hand);
  if (!hand.length) return { best: { kind: "PASS", utility: 0, reason: "emptyHand" }, ranked: [] };

  // --- urgent defense override: Den Signal vs DOG / own DEN when not immune ---
  const den = normColor(me?.color || me?.den || me?.denColor);
  const immune = !!flags?.denImmune?.[den];
  const next0 = nextEventId(game, 0);
  const t0 = classifyEvent(next0);
  const urgentDefense =
    !immune &&
    hasActionIdInHand(hand, "DEN_SIGNAL") &&
    (t0.type === "DOG" || (t0.type === "DEN" && normColor(t0.color) === den));

 // threat-mode: when danger is high or LEAD-only penalty is coming, play actions more often
const isLead = computeIsLead(game, me, players);
const factsThreat0 = getEventFacts(String(next0 || ""), {
  game, me, denColor: den, isLead, flagsRound: flagsRound || game?.flagsRound
});
const lurkDanger0 = Number(factsThreat0?.dangerLurk || 0);
const leadThreat0 = (String(factsThreat0?.appliesTo || "").toUpperCase() === "LEAD") && isLead;
const threatMode = (lurkDanger0 >= Number(c.opsThreatDangerTrigger || 5.0)) || leadThreat0;

// baseline = PASS utility (decision best)
const intel = getPeekIntel({ game, me, flagsRound: flags, lookaheadN: c.lookaheadN });
const baseDecision = evaluateDecision({ game, me, players, flagsRound: flags, cfg: c, peekIntel: intel });
const passU = Number(baseDecision?.ranked?.[0]?.utility ?? 0);

if (urgentDefense) {
  return {
    best: { kind: "PLAY", plays: [{ actionId: "DEN_SIGNAL", name: "Den Signal", targetId: null }], utility: passU + 9, reason: "urgentDenSignal" },
    baseline: { passUtility: passU, decision: baseDecision?.decision || null },
    ranked: [{ play: { actionId: "DEN_SIGNAL", name: "Den Signal", targetId: null }, utility: passU + 9 }],
    comboBest: null,
  };
}

// ---- Spending discipline (early raid hoarding + combo saving) ----
const stage0 = opsStageFromGame(game, c);
let reserveTarget = stage0.reserveTarget;

const nextIdC = nextEventId(game, 0);
const denC = normColor(me?.color || me?.den || me?.denColor);
const isLeadC = computeIsLead(game, me, players);
const factsNext0 = nextIdC
  ? getEventFacts(String(nextIdC), { game, me, denColor: denC, isLead: isLeadC })
  : null;

const ctxCombo = {
  nextKnown: !flags.noPeek,
  knownUpcomingEvents: flags.noPeek ? safeArr(me?.knownUpcomingEvents) : safeArr(intel?.events),
  nextEventFacts: factsNext0
    ? {
        dangerDash: Number(factsNext0?.dangerDash || 0),
        dangerLurk: Number(factsNext0?.dangerLurk || 0),
        dangerBurrow: Number(factsNext0?.dangerBurrow || 0),
      }
    : null,
  lockEventsActive: !!flags.lockEvents,
  opsLockedActive: !!flags.opsLocked,
  discardActionIds: discardActionIdsFromGame(game),
};

  const comboMeta = computeComboMeta(handActionIds(hand), ctxCombo, c);
  if (comboMeta.highCombo) reserveTarget += Number(c.opsReserveComboBoost || 0);

  const carry0 = sumLootPoints(me);
  const dashPush0 = getDashPush(me, c);
  const expFutureCard = Math.max(
    0.4,
    avgActionDeckValue(game, { game, me, players, flags, intel, carry: carry0, dashPush: dashPush0 }, c) || 0.8
  );

    const minGainSoft =
    Number(c.actionPlayMinGain || 1.2) +
    (stage0.stage === "early" ? Number(c.actionPlayMinGainEarlyBonus || 0.8) : 0) +
    (comboMeta.highCombo ? Number(c.opsHighComboGainBonus || 0.25) : 0);

  const minGainHard =
    Number(c.opsMinAdvantage || 0) +
    (stage0.stage === "early" ? Number(c.opsMinAdvantageEarlyBonus || 0) : 0);

  let requiredGain = Math.max(minGainSoft, minGainHard);
  if (threatMode) requiredGain = Math.max(0, requiredGain - Number(c.opsThreatPlayBoost || 0.6) - (leadThreat0 ? Number(c.opsLeadThreatExtraBoost || 0.4) : 0));

  const spendMult = stage0.spendMult;
    let playTaxMult =
    stage0.stage === "early" ? Number(c.opsPlayTaxEarlyMult || 1.2) :
    stage0.stage === "late" ? Number(c.opsPlayTaxLateMult || 0.8) :
    1.0;

  if (threatMode) playTaxMult *= Number(c.opsThreatPlayTaxMult || 0.80);

   const spendCost = (nCards, primaryActionId = null, isCombo = false) => {
    const spent = Math.max(0, Number(nCards || 1));

    // opportunity cost (bestaand)
    const base = Number(c.opsSpendCostBase || 0) * expFutureCard * spendMult * spent;

    // vaste "spelen kost iets" tax
    const tax = Number(c.opsPlayTaxBase || 0) * playTaxMult * spent;

    // reserve onder target = penalty
    const post = Math.max(0, hand.length - spent);
    const miss = Math.max(0, reserveTarget - post);
    const reservePenalty = miss * Number(c.opsReserveMissPenalty || 0);

    // combo piece bewaren: penalty schaalt mee met combo score (niet alleen hard drempel)
    const comboKey = (!isCombo && primaryActionId)
      ? (comboMeta.keyScoreById?.[String(primaryActionId)] || 0)
      : 0;

    const soloComboPenalty =
      (!isCombo && comboKey > 0)
        ? Number(c.opsComboHoldPenaltyScale || 0) * comboKey
        : 0;

    return base + tax + reservePenalty + soloComboPenalty;
  };
    
    const setupStageMult =
    stage0.stage === "early" ? Number(c.opsComboSetupEarlyMult || 0.6) :
    stage0.stage === "late" ? Number(c.opsComboSetupLateMult || 1.0) :
    Number(c.opsComboSetupMidMult || 0.85);

  const setupBonusForPlay = (play) => {
    const id = String(play?.actionId || "");
    if (!id || hand.length < 2) return 0;
    const out = Number(comboMeta.outBestById?.[id] || 0);
    if (!out) return 0;
    return Number(c.opsComboSetupBonusScale || 0) * out * setupStageMult;
  };

  // build candidate plays
  const plays = [];
  for (const raw of hand) {
    const name = String(raw?.name || raw || "").trim();
    if (!name) continue;
    const def = getActionDefByName(name);
    if (!def?.id) continue;

    const actionId = String(def.id);

// Only hard-skip when hand is *really* small.
// ReserveTarget is handled by spendCost() (soft penalty), so DON'T continue here.
if (hand.length <= Number(c.actionReserveMinHand || 1)) {
  const ok = new Set([
    "DEN_SIGNAL",
    "NOSE_FOR_TROUBLE",
    "BURROW_BEACON",
    "PACK_TINKER",
    "KICK_UP_DUST",
    "FOLLOW_THE_TAIL",
    "NO_GO_ZONE",
  ]);
  if (!ok.has(actionId)) continue;
}

    const cand = actionCandidates({ actionId, actionName: name, game, me, players });
    for (const p of cand) plays.push(p);
  }

  if (!plays.length) return { best: { kind: "PASS", utility: passU, reason: "noPlayableCards" }, ranked: [] };

    // score singles (adjusted with spend-cost so bots don't dump cards early)
  const scoredRaw = plays.map((play) => scoreOpsPlay({ play, game, me, players, flagsRound: flags, cfg: c }));
    const scored = scoredRaw
    .map((x) => {
      const setupBonus = setupBonusForPlay(x.play);
      const cost = spendCost(1, String(x.play?.actionId || ""), false);
      return {
        ...x,
        setupBonus,
        spendCost: cost,
        utilityAdj: Number(x.utility || 0) + setupBonus - cost,
      };
    })
    .sort((a, b) => b.utilityAdj - a.utilityAdj);

  const bestSingle = scored[0];

    // combo search (2 cards)
  let bestCombo = null;
  if (c.allowComboSearch && scored.length >= 2) {
    const pairs = [];
    const maxPairs = Math.max(4, Number(c.comboMaxPairs || 20));
    const topK = Math.min(6, scored.length);

    for (let i = 0; i < topK; i++) {
      for (let j = 0; j < scored.length; j++) {
        if (i === j) continue;
        const a = scored[i].play;
        const b = scored[j].play;
        if (String(a.actionId) === String(b.actionId)) continue;

        pairs.push([a, b]);
        if (pairs.length >= maxPairs) break;
      }
      if (pairs.length >= maxPairs) break;
    }

    for (const [a, b] of pairs) {
      const simA = simulateActionOnce({
        play: a,
        game,
        me,
        players,
        flagsRound: flags,
        cfg: c,
        seedTag: "C1",
      });

      const scoreA = scoreOpsPlay({ play: a, game, me, players, flagsRound: flags, cfg: c });

      const scoreB = scoreOpsPlay({
        play: b,
        game: simA.game,
        me: simA.me,
        players: simA.players,
        flagsRound: simA.flagsRound,
        cfg: c,
      });

      const comboRaw = Number(scoreA.utility || 0) + Number(scoreB.utility || 0);
      const comboU = comboRaw - spendCost(2, null, true);

      if (!bestCombo || comboU > bestCombo.utility) {
        bestCombo = { plays: [a, b], utility: comboU, raw: comboRaw };
      }
    }
  }

  // choose PASS vs single vs combo (use adjusted utilities)
  let best = { kind: "PASS", utility: passU, reason: "default" };

  if (bestSingle && bestSingle.utilityAdj >= passU + requiredGain) {
    best = {
      kind: "PLAY",
      plays: [bestSingle.play],
      utility: bestSingle.utilityAdj,
      reason: "bestSingle",
    };
  }

  if (
    bestCombo &&
    bestCombo.utility >= (bestSingle?.utilityAdj ?? -1e9) + Number(c.comboMinGain || 0) &&
    bestCombo.utility >= passU + requiredGain
  ) {
    best = {
      kind: "PLAY",
      plays: bestCombo.plays,
      utility: bestCombo.utility,
      reason: "bestCombo",
    };
  }

    return {
    best,
    baseline: { passUtility: passU, decision: baseDecision?.decision || null },

    meta: {
      stage: stage0.stage,
      reserveTarget,
      maxComboScore: comboMeta.maxComboScore,
      requiredGain,   // let op: moet bestaan
      passU,
    },

    ranked: scored.slice(0, 12).map((x) => ({ play: x.play, utility: x.utilityAdj })),
    comboBest: bestCombo,
  };
}

/** =========================
 *  Convenience
 *  ========================= */
    
export function evaluatePhase({ phase, game, me, players, flagsRound = null, cfg = null }) {
  const p = String(phase || "").toUpperCase();
  if (p === "MOVE") return evaluateMoveOptions({ game, me, players, flagsRound, cfg });
  if (p === "OPS" || p === "ACTIONS") return evaluateOpsActions({ game, me, players, flagsRound, cfg });
  if (p === "DECISION") {
    const intel = getPeekIntel({ game, me, flagsRound, lookaheadN: (cfg?.lookaheadN ?? DEFAULTS.lookaheadN) });
    return evaluateDecision({ game, me, players, flagsRound, cfg, peekIntel: intel });
  }
  return { error: `Unknown phase: ${phase}` };
}

