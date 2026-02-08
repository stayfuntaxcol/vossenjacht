// bots/core/strategy.js
// Shared, utility-based policy for MOVE / OPS(ACTIONS) / DECISION.
// No Firestore writes. (Caller handles writes; only BURROW hard-rule uses a Firestore boolean: player.burrowUsed)

import { getEventFacts, getActionFacts } from "../rulesIndex.js";
import { getActionDefByName, getLootDef } from "../../cards.js";
import { comboScore } from "../actionComboMatrix.js";
import { getEffectiveNextEventIntel } from "./trackState.js";

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
  actionReserveMinHand: 0,
  actionPlayMinGain: 0,
  comboMinGain: 0,
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
  
  opsSpendCostBase: 0.0,          // softer opportunity cost per spent card
  opsSpendCostEarlyMult: 1.05,
  opsSpendCostLateMult: 0.8,
  
    // OPS "card has value": alleen spelen bij significant voordeel
  opsPlayTaxBase: 0.0,              // vaste utility-kost per gespeelde kaart
  opsPlayTaxEarlyMult: 1.15,        // early: harder sparen
  opsThreatDangerTrigger: 5.0,         // if next event lurk danger >= this -> play more
  opsThreatPlayBoost: 0.6,             // reduce requiredGain by this in threat-mode
  opsLeadThreatExtraBoost: 0.4,        // extra boost if LEAD-only threat and I'm lead
  opsThreatPlayTaxMult: 0.80,          // multiply playTaxMult in threat-mode
  opsPlayTaxLateMult: 0.85,         // late: makkelijker uitgeven


  // OPS V2: integrated spend cost + combo matrix weight
  opsNeverPassWhenPlayable: true,
  opsPlayFlatCost: 0.25,        // cost per played card (set 0 for "always play")
  opsPlayCostEarlyMult: 1.10,
  opsPlayCostLateMult: 0.90,
  opsComboMatrixWeight: 0.55,   // scale for comboScore bonus in combos

  opsMinAdvantage: 0.0,             // minimaal voordeel boven PASS om überhaupt te spelen
  opsMinAdvantageEarlyBonus: 0.0,   // early: nog strenger

  // combo planning: key pieces bewaren, maar "setup" plays toestaan
  opsComboHoldPenaltyScale: 0.14,   // penalty ~ scale * comboKeyScore
  opsComboSetupBonusScale: 0.10,    // bonus ~ scale * best outgoing combo score
  opsComboSetupEarlyMult: 0.55,
  opsComboSetupMidMult: 0.80,
  opsComboSetupLateMult: 1.00,


  opsReserveMissPenalty: 0.0,     // softer penalty if you dip under reserveTarget
  opsSoloBreakComboPenalty: 0.0,   // softer penalty for spending a key solo

  actionPlayMinGainEarlyBonus: 0.0, // slightly harder early, but not paralyzing

  // Multiplayer/pest-card waardering (nieuw)
  opsMultiPlayerBaseBonus: 0.55,   // kleine extra waarde in drukke Yard
  opsMultiPlayerSoloPenalty: 0.75, // ontmoedig verspillen als je (bijna) solo bent
  opsMultiStageEarlyMult: 1.20,
  opsMultiStageLateMult: 0.85,
  opsMultiPlayerUrgencyBoost: 0.35,
  
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

  const idxRaw = Number.isFinite(Number(game?.leadIndex)) ? Number(game.leadIndex) : null;
  if (idxRaw === null) return false;

  const orderedAll = safeArr(players).slice().sort((a, b) => {
    const ao = typeof a?.joinOrder === "number" ? a.joinOrder : 9999;
    const bo = typeof b?.joinOrder === "number" ? b.joinOrder : 9999;
    return ao - bo;
  });

  // match engine/host: leadIndex is op actieve yard spelers
  const orderedActive = orderedAll.filter(isInYard);
  const base = orderedActive.length ? orderedActive : orderedAll;
  if (!base.length) return false;

  const idx = ((idxRaw % base.length) + base.length) % base.length;
  return String(base[idx]?.id || "") === meId;
}

/** flags: keep compatible with strict boolean flags (no arrays) */
function getFlags(flagsRound, meId = null) {
  const fr = flagsRound || {};

  const noPeek   = fr.noPeek === true;     // STRICT boolean only
  const lockHead = fr.lockHead === true;   // STRICT boolean only (No-Go Zone)

  return {
    lockEvents: false,
    lockHead: false,      // default
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
    noPeek,    // override after spread
    lockHead,  // override after spread
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
 *  Peek intel (N=3..5) + MEMORY + HEAD LOCK
 *  ========================= */
window.getPeekIntel = function getPeekIntel({ game, me, flagsRound = null, lookaheadN = null }) {
  const n = Number.isFinite(Number(lookaheadN)) ? Number(lookaheadN) : DEFAULTS.lookaheadN;
  const flags = getFlags(flagsRound || game?.flagsRound, String(me?.id || ""));

  // Belangrijk: dit is de "track fingerprint" die jij in engine laat bumpen
  // bij KickUpDust/SHIFT en bij REVEAL (advance head).
  const trackV = Number(game?.eventTrackVersion ?? 0);

  // No-Go Zone = HEAD lock (geen noPeek)
  const headLocked = Boolean(flags.lockHead);

  // --- MEMORY (compatibel met oude knownUpcomingEvents) ---
  const mem = me?.intelMemory || me?.memory || {};
  const memEvents = safeArr(mem.events || me?.knownUpcomingEvents).filter(Boolean).map(String);
  const memV = Number(mem.trackVersion ?? mem.knownAtTrackVersion ?? NaN);
  const memValid = memEvents.length && Number.isFinite(memV) && memV === trackV;

  // 1) Als peek echt geblokkeerd is (noPeek) en er is GEEN head-lock:
  //    gebruik memory als die nog geldig is; anders fallback naar knownUpcomingEvents.
  if (flags.noPeek && !headLocked) {
    if (memValid) {
      const events = memEvents.slice(0, n);
      const confidence = Number.isFinite(Number(mem.confidence))
        ? Math.max(0, Math.min(1, Number(mem.confidence)))
        : Math.min(1, events.length / n);

      return { mode: "memory", confidence, events, trackVersion: trackV, headLocked: false };
    }

    const known = safeArr(me?.knownUpcomingEvents).filter(Boolean).map(String);
    const events = known.slice(0, n);
    return { mode: "known", confidence: events.length ? Math.min(1, events.length / n) : 0, events, trackVersion: trackV, headLocked: false };
  }

  // 2) Als HEAD gelocked is (No-Go Zone):
  //    - eerste event is gegarandeerd correct
  //    - als je toch "noPeek" gebruikt voor andere redenen: geef alleen HEAD terug
  if (headLocked && flags.noPeek) {
    const head = nextEventId(game, 0);
    const events = head ? [String(head)] : [];
    const confidence = events.length ? 1 : 0;

    // cache in-memory (handig voor dezelfde tick)
    me.intelMemory = { events, confidence, trackVersion: trackV, source: "LOCK", updatedAt: Date.now() };

    return { mode: "lock", confidence, events, trackVersion: trackV, headLocked: true };
  }

  // 3) Normale peek (of lock + peek toegestaan): pak events van de track
  const events = [];
  for (let k = 0; k < n; k++) {
    const id = nextEventId(game, k);
    if (!id) break;
    events.push(String(id));
  }

  const confidence = events.length ? 1 : 0;
  const mode = headLocked ? "lock+peek" : "peek";

  // cache (belangrijk voor "menselijk geheugen" wanneer later noPeek aan staat)
  me.intelMemory = { events, confidence, trackVersion: trackV, source: mode.toUpperCase(), updatedAt: Date.now() };

  return { mode, confidence, events, trackVersion: trackV, headLocked };
};


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
  
  // CANON (jouw regel): BURROW is altijd veilig (geen dangerVec), behalve Rooster #3
  // (Rooster #3 wordt hierboven al hard-afgevangen met return 10)
  if (ch === "BURROW") return 0;

  // Fence Patrol: alleen LURK tweaken; BURROW blijft safe
  if (eid === "FENCE_PATROL") {
    if (ch === "LURK") return Math.min(dLurk, 2);
  }

  if (ch === "DASH") return dDash;
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
  // BURROW is 1× per RAID (burrowUsedThisRaid) and optionally also 1× per MATCH (burrowUsed).
  // Use OR (NOT ??) so burrowUsed=true still blocks even if burrowUsedThisRaid is explicitly false.
  const used = !!(me?.burrowUsedThisRaid || me?.burrowUsed);
  if (used) return false;
  if (me?.burrowCharges != null) return Number(me.burrowCharges) > 0;
  return true;
}

export function canUseBurrow(me) {
  return canonIsBurrowReady(me);
}


function canonDenSignalRelevant({ game, me, flags, nextId }) {
  const den = normColor(me?.color || me?.den || me?.denColor);
  const immune = !!flags?.denImmune?.[den];
  if (!immune) return false;

  const eid = String(nextId || "");
  // Den Signal canon: only matters if it actually neutralizes the upcoming threat
  return eid.startsWith("DEN_") || eid === "DOG_CHARGE" || eid === "SECOND_CHARGE";
}

function canonIsRooster3({ game, nextId /*, nextFacts*/ }) {
  const eid = String(nextId || "");
  if (eid !== "ROOSTER_CROW") return false;

  // Prefer roosterSeen; fallback revealed-count
  const seen =
    Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen)
    : countRevealedRoosters(game);

  return seen >= 2; // 3e rooster
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

  // --- Intel selection ---
  // noPeek=false: we can read the public eventTrack (normal mode).
  // noPeek=true: we ONLY use bot-owned intel (knownUpcomingEvents) if provided.
  const intel = peekIntel || (!flags.noPeek ? getPeekIntel({ game, me, flagsRound: flags, lookaheadN: cfg0.lookaheadN }) : null);
  const events = safeArr(intel?.events).filter(Boolean).map(String);

  const nextId = (!flags.noPeek)
    ? (events[0] || nextEventId(game, 0))
    : (events[0] || null);

  const den = normColor(me?.color || me?.den || me?.denColor);
  const isLead = computeIsLead(game, me, players);
  const burrowReady = canonIsBurrowReady(me);

  // ===== FALLBACK (noPeek=true + no intel) =====
  if (!nextId) {
    const dashers = canonCountDashers(players);
    const dashPushNow = getDashPush(me, cfg0);
    const dashPushThreshold = canonDashPushThreshold(cfg0, dashers);

    // End-pressure heuristic when you don't know what's coming:
    // - if dashPush is high, go defensive (BURROW if possible, else DASH).
    // - otherwise stay (LURK).
    const decision = (dashPushNow >= dashPushThreshold)
      ? (burrowReady ? "BURROW" : "DASH")
      : "LURK";

    return {
      decision,
      meta: {
        reason: "no_intel_fallback",
        dashers,
        dashPushNow,
        dashPushThreshold,
      },
    };
  }

  const nextFacts = getEventFacts(String(nextId), { game, me, denColor: den, isLead, flagsRound: flagsRound || game?.flagsRound });

  // Danger if you stay in-yard and choose LURK.
  const dangerStay = eventDangerForChoice({ eventId: nextId, choice: "LURK", game, me, players, flagsRound });

  // Den Signal (when relevant) can make you safe -> allow LURK.
  const denSignalSafe = canonDenSignalRelevant({ game, me, flags, nextId });

  const safeMax = Number(cfg0.canonSafeDangerMax ?? DEFAULTS.canonSafeDangerMax ?? 3.0);
  const safeNow = denSignalSafe || Number(dangerStay) <= safeMax;

  const isRooster3 = canonIsRooster3({ game, nextId, nextFacts });

  // ===== RULE 0: Rooster3 -> DASH always (anyone still in yard gets caught)
  if (isRooster3) {
    return {
      decision: "DASH",
      meta: { reason: "rooster3", nextEventIdUsed: nextId, isRooster3, dangerStay, safeNow },
    };
  }

  // ===== SIMPLE POLICY (your spec)
  // safe  -> LURK (unless later you add an explicit Hidden Nest DASH override)
  // danger-> BURROW if available, else DASH
  if (safeNow) {
    return {
      decision: "LURK",
      meta: { reason: "safe_lurk", nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow },
    };
  }

  return {
    decision: burrowReady ? "BURROW" : "DASH",
    meta: { reason: "danger_prefer_burrow", nextEventIdUsed: nextId, isRooster3: false, dangerStay, safeNow, burrowReady },
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
  // No-Go Zone = lock HEAD event for this round (confidence stays high)
  flags.lockHead = true;

  // Niet doen:
  // flags.noPeek = true;

  // Alleen laten staan als je echt actions wil locken (waarschijnlijk niet):
  // flags.opsLocked = true;
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
  // Randomly change your den color (expected-value handled by sampling in scoreOpsPlay).
  const colors = ["RED", "BLUE", "GREEN", "YELLOW"];
  const cur = normColor(p.color || p.den || p.denColor);
  const pool = cur ? colors.filter((c) => c !== cur) : colors.slice();
  const rnd = mulberry32(hashSeed(`${seedTag}|MM|${String(g?.round || 0)}|${String(meId)}`));
  const pick = pool[Math.floor(rnd() * pool.length)] || pool[0] || cur;
  if (pick) {
    p.color = pick;
    p.den = pick;
    p.denColor = pick;
  }
  // debug marker (optional)
  const mm = (flags.moltingMask || {});
  mm[String(meId)] = pick;
  flags.moltingMask = mm;
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

if (actionId === "HOLD_STILL") {
  const t = richest(enemies);
  return t ? [{ actionId, name: actionName, targetId: t }] : [];
}

if (actionId === "MASK_SWAP") {
  // Prefer targets where the swap likely improves your survival OR meaningfully hurts them.
  const next0 = String(nextEventId(game, 0) || "");
  const myCol = normColor(me?.color || me?.den || me?.denColor);

  const roundNow = Number(game?.round ?? game?.roundIndex ?? 0);
  const discards = safeArr(game?.actionDiscard).filter((d) => Number(d?.round) === roundNow);
  const denSignalBy = new Set(
    discards
      .filter((d) => String(d?.name || "").toLowerCase().includes("den signal"))
      .map((d) => String(d?.by))
  );

  const scored = enemies.map((p) => {
    const tCol = normColor(p?.color || p?.den || p?.denColor);
    let s = 0;

    // if next is your DEN event, swapping away is valuable
    if (myCol && next0.startsWith("DEN_") && next0.toUpperCase().includes(myCol)) {
      if (tCol && tCol !== myCol) s += 2.0;
    }

    // if target already spent Den Signal this round, swapping after it can "waste" it
    if (denSignalBy.has(String(p?.id))) s += 1.0;

    // prefer high-carry targets (deny)
    s += 0.25 * sumLootPoints(p);

    return { id: p.id, score: s };
  });

  scored.sort((a, b) => b.score - a.score);

  // Offer multiple targets; scoreOpsPlay will choose the best.
  return scored.slice(0, 4).map((t) => ({ actionId, name: actionName, targetId: t.id }));
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

// Random actions: take expected value over samples.
let sims = null;

// Kick Up Dust: random shuffle of the track
if (actionId === "KICK_UP_DUST" && !flags.lockEvents) {
  sims = Array.from({ length: Math.max(2, Number(c.kickUpDustSamples || 6)) }, (_, i) =>
    simulateActionOnce({ play, game, me, players, flagsRound: flags, cfg: c, seedTag: `KUD#${i}` })
  );
}

// Molting Mask: random new den color
if (!sims && actionId === "MOLTING_MASK") {
  sims = Array.from({ length: Math.max(3, Number(c.moltingMaskSamples || 7)) }, (_, i) =>
    simulateActionOnce({ play, game, me, players, flagsRound: flags, cfg: c, seedTag: `MM#${i}` })
  );
}

if (!sims) {
  sims = [simulateActionOnce({ play, game, me, players, flagsRound: flags, cfg: c, seedTag: "ONE" })];
}

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
    
// implementation multiplier (fix TDZ: facts eerst definiëren)
const facts = getActionFacts(actionId);

if (
  facts?.engineImplemented === false &&
  !RUNNER_IMPLEMENTED.has(actionId) &&
  (typeof window !== "undefined") &&
  window.__BOTS_DEBUG__
) {
  console.log("[OPS] unimplemented penalty:", actionId, facts);
}

let implMult = 1;
if (facts?.engineImplemented === false && !RUNNER_IMPLEMENTED.has(actionId)) {
  implMult = c.actionUnimplementedMult;
}

    if (facts?.engineImplemented === false && !RUNNER_IMPLEMENTED.has(actionId)) implMult = c.actionUnimplementedMult;

    let u = implMult * ((afterU - baseU) + c.wTeam * teamDelta + c.wDeny * denyDelta);

    // apply optimism for random shuffle (avoid overfitting to one sample)
    if (actionId === "KICK_UP_DUST") {
      u = (c.kickUpDustOptimism * u) + ((1 - c.kickUpDustOptimism) * 0.0);
    }

    utilitySum += u;
  }

    let utility = utilitySum / sims.length;
// --- Card-specific heuristics (small but high-impact) ---
{
  const roundNow = Number(game?.round ?? game?.roundIndex ?? 0);
  const discards = safeArr(game?.actionDiscard);
  const discThis = discards.filter((d) => Number(d?.round) === roundNow);
  const discNames = discThis.map((d) => String(d?.name || "").toLowerCase());
  const discByMe = discThis.filter((d) => String(d?.by) === String(me?.id || ""));

  // A) Nose for Trouble: extra loot only matters if you can really predict the next event
  if (actionId === "NOSE_FOR_TROUBLE") {
    const next0 = nextEventId(game, 0);
    const known0 =
      (!flags.noPeek && !!next0) ||
      (Array.isArray(me?.knownUpcomingEvents) && String(me.knownUpcomingEvents[0]) === String(next0));
    const pCorrect = known0 ? Number(c.noseKnownCorrectP || 0.95) : Number(c.noseBaseCorrectP || 0.25);
    const lootU = Number(c.noseLootValue || 2.0);

    // only pay off if you likely stay in the Yard for REVEAL
    const sim0 = simulateActionOnce({ play, game, me, players, flagsRound: flags, cfg: c, seedTag: "NOSE" });
    const intelNose = getPeekIntel({ game: sim0.game, me: sim0.me, flagsRound: sim0.flagsRound, lookaheadN: c.lookaheadN });
    const a0 = evaluateDecision({ game: sim0.game, me: sim0.me, players: sim0.players, flagsRound: sim0.flagsRound, cfg: c, peekIntel: intelNose });
    const willStay = String(a0?.decision || "").toUpperCase() === "LURK";

    utility += (willStay ? 1 : 0) * pCorrect * lootU;

    // if someone already shuffled this round, your prediction is less reliable
    const kudAlready = discNames.some((n) => n.includes("kick up dust"));
    if (kudAlready) utility -= Number(c.noseVsKudPenalty || 0.6);
  }

  // B) Kick Up Dust: defensive reroll OR denial vs Scout/Nose/Den Signal (profile-tuned)
  if (actionId === "KICK_UP_DUST") {
    const kudAlready = discNames.some((n) => n.includes("kick up dust"));
    const selfPlayedKudRecently =
      discards.some((d) => String(d?.by) === String(me?.id || "") &&
        String(d?.name || "").toLowerCase().includes("kick up dust") &&
        Number.isFinite(Number(d?.round)) &&
        (roundNow - Number(d.round)) <= Number(c.kudSelfCooldownRounds || 2)
      );

    // hard anti-spam: if KUD already happened this round, punish (unless you explicitly allow stacking)
    if (kudAlready && !c.kudAllowStack) {
      utility -= Number(c.kudAlreadyThisRoundPenalty || 2.8);
    }
    if (selfPlayedKudRecently) {
      utility -= Number(c.kudSelfCooldownPenalty || 1.8);
    }

    const enemyScoutThisRound = players.some((p) =>
      isInYard(p, game) &&
      String(p?.id) !== String(me?.id) &&
      Number(p?.lastMoveRound) === roundNow &&
      String(p?.lastMoveKind || "").toUpperCase().includes("SCOUT")
    );

    const enemyNosePlayed = discNames.some((n) => n.includes("nose for trouble"));
    const enemyDenSignalPlayed = discNames.some((n) => n.includes("den signal"));

    const selfNosePlayed = discByMe.some((d) => String(d?.name || "").toLowerCase().includes("nose for trouble"));

    let denyBonus = 0;
    if (enemyScoutThisRound) denyBonus += Number(c.kudDenyScoutBonus || 0);
    if (enemyNosePlayed) denyBonus += Number(c.kudDenyNoseBonus || 0);
    if (enemyDenSignalPlayed) denyBonus += Number(c.kudDenyDenSignalBonus || 0);

    // don't self-sabotage your own Nose prediction
    if (selfNosePlayed) denyBonus -= Number(c.kudSelfNosePenalty || 1.5);

    utility += denyBonus;
  }

  // C) Molting Mask: avoid wasting it when not under DEN-danger
  if (actionId === "MOLTING_MASK") {
    const next0 = String(nextEventId(game, 0) || "");
    const myCol = normColor(me?.color || me?.den || me?.denColor);
    const isMyDen = myCol && next0.startsWith("DEN_") && next0.toUpperCase().includes(myCol);
    const minDanger = Number(c.moltingMinDangerSelf || 7.0);

    // if not a DEN threat, keep it for later (small penalty)
    if (!isMyDen) {
      utility -= Number(c.moltingOffDenPenalty || 0.8);
    }

    // if danger is low, strongly discourage
    const factsNow = next0 ? getEventFacts(next0, { game, me, denColor: myCol, isLead: computeIsLead(game, me, players) }) : null;
    const dStay = Number(factsNow?.dangerLurk ?? factsNow?.dangerStay ?? 0);
    if (dStay < minDanger) {
      utility -= Number(c.moltingWhenSafePenalty || 1.2);
    }
  }

  // D) Mask Swap: discourage suicidal swaps (gain must be clear)
  if (actionId === "MASK_SWAP") {
    const minGain = Number(c.maskSwapMinGain || 0.9);
    if (utility < minGain) {
      utility -= Number(c.maskSwapLowGainPenalty || 0.6);
    }
  }
}


  // Multiplayer/tempo bonus (JAZZ):
  // Deze kaarten “doen” weinig in de decision-simulatie, maar zijn wél waardevol
  // als er meerdere spelers zijn (targets) en er nog spelers na jou moeten handelen (tempo).
  {
    const factsNow = getActionFacts(actionId);
    const isMulti = !!factsNow?.needsOthers || MULTIPLAYER_VALUE_ACTIONS.has(actionId);

    if (isMulti) {
      const stage0 = opsStageFromGame(game, c);
      const n = opsParticipantCount(game, players);   // aantal spelers in de Yard/OPS
      const remaining = opsRemainingCount(game);      // hoeveel moeten nog handelen na jou

      // Solo => direct afwaarderen en klaar (anders verspillen bots deze kaarten)
      if (n <= 1) {
        utility = utility - Number(c.opsMultiPlayerSoloPenalty || 0.90);
        return { play, utility, baseU };
      }

      const presence = clamp((n - 1) / 3, 0, 1);      // 2=>0.33, 4=>1.0
      const rem = clamp(remaining / 3, 0, 1);

      const stageMult =
        stage0.stage === "early" ? Number(c.opsMultiStageEarlyMult || 1.25) :
        stage0.stage === "late"  ? Number(c.opsMultiStageLateMult  || 0.85) :
        1.0;

      const base = Number(c.opsMultiPlayerBaseBonus || 0.60);

      // Urgency: hoe kleiner de groep wordt (richting 2 spelers), hoe meer “nu spelen”
      const urgency = clamp(1 - presence, 0, 1);
      const urgencyBoost =
        Number(c.opsMultiPlayerUrgencyBoost || 0.35) * presence * urgency;

      const bonus = base * presence * (0.45 + 0.55 * rem) * stageMult;

      utility = utility + bonus + urgencyBoost;
    }
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

// ---- OPS valuation v2: no hard hoarding / no requiredGain gates ----
  const stage0 = opsStageFromGame(game, c);

  // context for combo matrix (peek/noPeek + next event danger)
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

  // Light cost for spending cards (integrated in utility; no thresholds).
  // If you want "no cost at all", set opsPlayFlatCost = 0.
  const playCostBase = Number(c.opsPlayFlatCost ?? 0.25);
  const playCost =
    playCostBase *
    (stage0.stage === "early"
      ? Number(c.opsPlayCostEarlyMult ?? 1.10)
      : stage0.stage === "late"
      ? Number(c.opsPlayCostLateMult ?? 0.90)
      : 1.0);

  // Small bonus for "good first" combo pieces (uses matrix out-scores).
  const setupStageMult =
    stage0.stage === "early"
      ? Number(c.opsComboSetupEarlyMult || 0.55)
      : stage0.stage === "late"
      ? Number(c.opsComboSetupLateMult || 1.00)
      : Number(c.opsComboSetupMidMult || 0.80);

  const comboSetupBonus = (actionId) => {
    const out = Number(comboMeta?.outBestById?.[String(actionId)] || 0);
    return Number(c.opsComboSetupBonusScale ?? 0.10) * out * setupStageMult;
  };

  const comboSynergy = (aId, bId) =>
    Number(comboScore(String(aId || ""), String(bId || ""), ctxCombo) || 0) *
    Number(c.opsComboMatrixWeight ?? 0.55);

  // build candidate plays
  const plays = [];
  for (const raw of hand) {
    const name = String(raw?.name || raw || "").trim();
    if (!name) continue;
    const def = getActionDefByName(name);
    if (!def?.id) continue;

    const actionId = String(def.id);

    const cand = actionCandidates({ actionId, actionName: name, game, me, players });
    for (const p of cand) plays.push(p);
  }

  if (!plays.length) return { best: { kind: "PASS", utility: passU, reason: "noPlayableCards" }, ranked: [] };

    // score singles (utility + combo-setup + small spend cost)
  const scoredRaw = plays.map((play) => scoreOpsPlay({ play, game, me, players, flagsRound: flags, cfg: c }));
  const scored = scoredRaw
    .map((x) => {
      const actionId = String(x.play?.actionId || "");
      const setupBonus = comboSetupBonus(actionId);
      const utilityAdj = Number(x.utility || 0) + setupBonus - playCost;
      return { ...x, setupBonus, playCost, utilityAdj };
    })
    .sort((a, b) => b.utilityAdj - a.utilityAdj);

  const bestSingle = scored[0];

  // combo search (2 cards): simulate A then B, add matrix synergy (no gates)
  let bestCombo = null;
  if (c.allowComboSearch && scored.length >= 2) {
    const maxPairs = Math.max(6, Number(c.comboMaxPairs || 24));
    const topK = Math.min(8, scored.length);
    let tried = 0;

    for (let i = 0; i < topK; i++) {
      for (let j = 0; j < topK; j++) {
        if (i === j) continue;

        const a = scored[i].play;
        const b = scored[j].play;

        // avoid exact same card id (unless you intentionally allow doubles later)
        if (String(a.actionId) === String(b.actionId)) continue;

        tried++;
        if (tried > maxPairs) break;

        const simA = simulateActionOnce({
          play: a,
          game,
          me,
          players,
          flagsRound: flags,
          cfg: c,
          seedTag: "C1",
        });

        const scoreA = scored[i]; // already scored in original state
        const scoreB = scoreOpsPlay({
          play: b,
          game: simA.game,
          me: simA.me,
          players: simA.players,
          flagsRound: simA.flagsRound,
          cfg: c,
        });

        const synergy = comboSynergy(a.actionId, b.actionId);
        const comboRaw = Number(scoreA.utility || 0) + Number(scoreB.utility || 0) + synergy;

        // pay cost for 2 cards (integrated; no extra penalties)
        const comboU = comboRaw - 2 * playCost;

        if (!bestCombo || comboU > bestCombo.utility) {
          bestCombo = { plays: [a, b], utility: comboU, raw: comboRaw, synergy };
        }
      }
      if (tried > maxPairs) break;
    }
  }

  // choose best among PASS vs single vs combo (no requiredGain thresholds)
  let best = { kind: "PASS", utility: passU, reason: "passIsBest" };

  if (bestSingle && bestSingle.utilityAdj > best.utility) {
    best = {
      kind: "PLAY",
      plays: [bestSingle.play],
      utility: bestSingle.utilityAdj,
      reason: "bestSingleV2",
    };
  }

  if (bestCombo && bestCombo.utility > best.utility) {
    best = {
      kind: "PLAY",
      plays: bestCombo.plays,
      utility: bestCombo.utility,
      reason: "bestComboV2",
    };
  }
  // Optional: never PASS if there is *any* playable card.
  // This is the "no restrictions" switch for testing.
  if (c.opsNeverPassWhenPlayable && best.kind === "PASS") {
    const uS = bestSingle ? Number(bestSingle.utilityAdj || -1e9) : -1e9;
    const uC = bestCombo ? Number(bestCombo.utility || -1e9) : -1e9;

    if (bestCombo && uC >= uS) {
      best = { kind: "PLAY", plays: bestCombo.plays, utility: uC, reason: "forcedComboV2" };
    } else if (bestSingle) {
      best = { kind: "PLAY", plays: [bestSingle.play], utility: uS, reason: "forcedSingleV2" };
    }
  }



  return {
    best,
    baseline: { passUtility: passU, decision: baseDecision?.decision || null },

    meta: {
      stage: stage0.stage,
      playCost,
      maxComboScore: comboMeta.maxComboScore,
      requiredGain: 0, // kept for older debug readers
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

if (typeof window !== "undefined") {
  window.BOT_UTILITY_CFG = BOT_UTILITY_CFG;
  window.getPeekIntel = getPeekIntel;
  window.evaluateMoveOptions = evaluateMoveOptions;
  window.evaluateOpsActions = evaluateOpsActions;
  window.evaluateDecision = evaluateDecision;
}


