// js/bots/botRunner.js
// Autonomous bots for VOSSENJACHT (smart OPS flow + threat-aware decisions)

import { getEventFacts, getActionFacts } from "./aiKit.js";
import { getActionDefByName } from "../cards.js";
import { comboScore } from "./actionComboMatrix.js";
import {
  rankActions,
  scoreActionFacts,
  presetFromDenColor,
  BOT_PRESETS,
  pickActionOrPass, // ✅ toevoegen
  recommendDecision,
} from "./botHeuristics.js";

import {
  BOT_UTILITY_CFG,
  evaluateMoveOptions,
  evaluateOpsActions,
  evaluateDecision,
} from "./core/strategy.js";

import { computeDangerMetrics, computeCarryValue, computeCarryValueRec } from "./core/metrics.js";

import {
  doc,
  getDoc,
  getDocs,
  collection,
  addDoc,
  onSnapshot,
  updateDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

/** Tuning */
const BOT_TICK_MS = 700;
const BOT_DEBOUNCE_MS = 150;
const LOCK_MS = 1800;

// UI pacing: played Action Cards must stay visible (face-up) on the Discard Pile
const OPS_DISCARD_VISIBLE_MS = 3100;

// DISC mapping per Den kleur
const DISC_BY_DEN = { RED: "D", YELLOW: "I", GREEN: "S", BLUE: "C" };

// Kleine, “stabiele” overrides (geen spikes)
// =============================
// JAZZ settings (utility layer)
// =============================

const JAZZ_UTILITY_OVERRIDES = {
  D: { // RED: agressiever, sneller spelen
    wRisk: 1.00,
    wDeny: 0.95,
    opsPlayTaxBase: 0.68,
    opsMinAdvantage: 0.92,
    opsReserveHandEarly: 2,
    opsSpendCostBase: 0.32,
  },
  I: { // YELLOW: speelser, vaker tempo/control
    wRisk: 1.08,
    opsPlayTaxBase: 0.70,
    opsMinAdvantage: 0.90,
    opsReserveHandEarly: 2,
    opsSpendCostBase: 0.34,
    kickUpDustOptimism: 0.65,
  },
  S: { // GREEN: defensiever, maar niet “op slot”
    wRisk: 1.20,
    opsPlayTaxBase: 0.78,
    opsMinAdvantage: 1.05,
    opsReserveHandEarly: 2,
    opsReserveHandMid: 2,
    opsSpendCostBase: 0.38,
  },
  C: { // BLUE: analytisch, iets hogere drempel maar wel spelend
    wRisk: 1.25,
    opsPlayTaxBase: 0.76,
    opsMinAdvantage: 1.02,
    opsSpendCostBase: 0.36,
    kickUpDustOptimism: 0.52,
    opsHighComboScore: 10,
  },
};

// behoud je bestaande naam, zodat rest van je code niet hoeft te wijzigen
const DISC_UTILITY_OVERRIDES = JAZZ_UTILITY_OVERRIDES;

function cfgForBot(botLike) {
  const den = String(botLike?.color || botLike?.denColor || botLike?.den || "").toUpperCase();
  const disc = DISC_BY_DEN[den] || "S";
  return { ...BOT_UTILITY_CFG, ...(DISC_UTILITY_OVERRIDES[disc] || {}) };
}

/** Bot name pool (player cards exist for these) */
const BOT_NAME_POOL = [
  "Astronaut",
  "Starwalker",
  "Prowler",
  "Empress",
  "Kiss",
  "Max",
  "Prince",
  "Monroe",
];

/** ===== small helpers ===== */
function normColor(c) {
  return String(c || "").trim().toUpperCase();
}

// Alleen overrides (strategy.js merged dit over BOT_UTILITY_CFG heen)
// Alleen overrides (strategy.js merged dit over BOT_UTILITY_CFG heen)
// CANON: geen carry/rooster/panic-cashout bias in config. DASH/BURROW/LURK worden bepaald in strategy.js.
// =============================
// JAZZ settings (strategy/OPS layer)
// =============================

const JAZZ_STRATEGY_OVERRIDES = {
  D: {
    wLoot: 6.2,
    wRisk: 0.95,
    wTeam: 0.45,
    wShare: 0.55,
    wDeny: 0.75,
    wResource: 0.35,

    lookaheadN: 4,

    // SHIFT (laat staan zoals jij het had; we buffen OPS i.p.v. SHIFT te nerfen)
    shiftMinGain: 3.2,
    shiftDangerTrigger: 7.8,
    shiftLookahead: 4,
    shiftDistancePenalty: 0.28,
    shiftBenefitMin: 2.0,
    shiftCooldownRounds: 2,
    shiftOverrideBenefit: 3.6,

    // OPS card play (meer “jazz”: vaker iets durven spelen)
    actionDeckSampleN: 28,
    actionReserveMinHand: 1,
    actionPlayMinGain: 0.62,
    comboMinGain: 0.88,
    allowComboSearch: true,
    comboMaxPairs: 26,

    opsEarlyRounds: 2,
    opsReserveHandEarly: 2,
    opsReserveHandMid: 1,
    opsReserveHandLate: 0,

    opsPlayTaxBase: 0.68,
    opsPlayTaxEarlyMult: 1.02,
    opsPlayTaxLateMult: 0.82,

    opsSpendCostBase: 0.34,
    opsSpendCostEarlyMult: 1.00,
    opsSpendCostLateMult: 0.80,

    opsMinAdvantage: 0.92,
    opsMinAdvantageEarlyBonus: 0.10,

    // Threat-mode OPS (als het gevaarlijk wordt: spelen!)
    opsThreatDangerTrigger: 5.2,
    opsThreatPlayBoost: 0.85,
    opsLeadThreatExtraBoost: 0.65,
    opsThreatPlayTaxMult: 0.72,
  },

  I: {
    wLoot: 6.6,
    wRisk: 1.05,
    wTeam: 0.60,
    wShare: 0.95,
    wDeny: 0.95,
    wResource: 0.45,

    lookaheadN: 4,

    // SHIFT
    shiftMinGain: 3.0,
    shiftDangerTrigger: 7.4,
    shiftLookahead: 4,
    shiftDistancePenalty: 0.26,
    shiftBenefitMin: 1.8,
    shiftCooldownRounds: 2,
    shiftOverrideBenefit: 3.2,

    // OPS card play
    actionDeckSampleN: 30,
    actionReserveMinHand: 1,
    actionPlayMinGain: 0.60,
    comboMinGain: 0.86,
    allowComboSearch: true,
    comboMaxPairs: 30,

    opsEarlyRounds: 2,
    opsReserveHandEarly: 2,
    opsReserveHandMid: 1,
    opsReserveHandLate: 0,

    opsPlayTaxBase: 0.70,
    opsPlayTaxEarlyMult: 1.02,
    opsPlayTaxLateMult: 0.84,

    opsSpendCostBase: 0.36,
    opsSpendCostEarlyMult: 1.00,
    opsSpendCostLateMult: 0.82,

    opsMinAdvantage: 0.90,
    opsMinAdvantageEarlyBonus: 0.10,

    // Threat-mode OPS
    opsThreatDangerTrigger: 5.0,
    opsThreatPlayBoost: 0.90,
    opsLeadThreatExtraBoost: 0.60,
    opsThreatPlayTaxMult: 0.74,
  },

  S: {
    wLoot: 5.5,
    wRisk: 1.30,
    wTeam: 0.85,
    wShare: 1.20,
    wDeny: 0.65,
    wResource: 0.55,

    lookaheadN: 4,

    // SHIFT
    shiftMinGain: 3.4,
    shiftDangerTrigger: 7.0,
    shiftLookahead: 4,
    shiftDistancePenalty: 0.30,
    shiftBenefitMin: 2.2,
    shiftCooldownRounds: 3,
    shiftOverrideBenefit: 3.4,

    // OPS card play
    actionDeckSampleN: 26,
    actionReserveMinHand: 1,
    actionPlayMinGain: 0.70,
    comboMinGain: 0.95,
    allowComboSearch: true,
    comboMaxPairs: 22,

    opsEarlyRounds: 2,
    opsReserveHandEarly: 2,
    opsReserveHandMid: 2,
    opsReserveHandLate: 1,

    opsPlayTaxBase: 0.78,
    opsPlayTaxEarlyMult: 1.05,
    opsPlayTaxLateMult: 0.90,

    opsSpendCostBase: 0.40,
    opsSpendCostEarlyMult: 1.02,
    opsSpendCostLateMult: 0.90,

    // ✅ DIT was jouw “handrem”: 1.45 -> 1.05
    opsMinAdvantage: 1.05,
    opsMinAdvantageEarlyBonus: 0.10,

    // Threat-mode OPS
    opsThreatDangerTrigger: 4.8,
    opsThreatPlayBoost: 0.95,
    opsLeadThreatExtraBoost: 0.70,
    opsThreatPlayTaxMult: 0.78,
  },

  C: {
    wLoot: 5.9,
    wRisk: 1.18,
    wTeam: 0.60,
    wShare: 0.95,
    wDeny: 0.80,
    wResource: 0.85,

    lookaheadN: 5,

    // SHIFT
    shiftMinGain: 3.0,
    shiftDangerTrigger: 7.6,
    shiftLookahead: 5,
    shiftDistancePenalty: 0.26,
    shiftBenefitMin: 1.9,
    shiftCooldownRounds: 2,
    shiftOverrideBenefit: 3.2,

    // OPS card play
    actionDeckSampleN: 30,
    actionReserveMinHand: 1,
    actionPlayMinGain: 0.66,
    comboMinGain: 0.92,
    allowComboSearch: true,
    comboMaxPairs: 26,

    opsEarlyRounds: 2,
    opsReserveHandEarly: 2,
    opsReserveHandMid: 1,
    opsReserveHandLate: 0,

    opsPlayTaxBase: 0.76,
    opsPlayTaxEarlyMult: 1.03,
    opsPlayTaxLateMult: 0.86,

    opsSpendCostBase: 0.38,
    opsSpendCostEarlyMult: 1.00,
    opsSpendCostLateMult: 0.84,

    // ✅ DIT was jouw “handrem”: 1.38 -> 1.02
    opsMinAdvantage: 1.02,
    opsMinAdvantageEarlyBonus: 0.10,

    // Threat-mode OPS
    opsThreatDangerTrigger: 5.1,
    opsThreatPlayBoost: 0.85,
    opsLeadThreatExtraBoost: 0.65,
    opsThreatPlayTaxMult: 0.76,
  },
};

// behoud je bestaande naam, zodat rest van je code niet hoeft te wijzigen
const DISC_STRATEGY_OVERRIDES = JAZZ_STRATEGY_OVERRIDES;

function getStrategyCfgForBot(botOrPlayer, game = null) {
  const den = normColor(botOrPlayer?.color || botOrPlayer?.den || botOrPlayer?.denColor);
  const disc = DISC_BY_DEN[den] || null;

  const base = (disc && DISC_STRATEGY_OVERRIDES[disc]) ? DISC_STRATEGY_OVERRIDES[disc] : null;

  // Optional per-RAID overrides via Firestore game document:
  // game.botDiscProfiles = { D:{...}, I:{...}, S:{...}, C:{...} }
  const fromGame =
    (disc && game && game.botDiscProfiles && typeof game.botDiscProfiles === "object")
      ? (game.botDiscProfiles[disc] || game.botDiscProfiles[String(disc).toUpperCase()] || null)
      : null;

  if (!base && !fromGame) return null;

  const merged = { ...(base || {}), ...(fromGame || {}) };

  // CANON guard: blokkeer legacy keys die DASH/BURROW/LURK zouden kunnen vervuilen
  const FORBIDDEN = new Set(["dashPushScale", "dashPushThreshold", "panicStayRisk", "panicDashStayRisk", "panicDashSafeDashRisk", "panicDashCarryMin", "suicideMargin", "burrowMinSafetyGain", "burrowMaxExtraCost", "burrowAlreadyUsedPenalty", "roosterEarlyDashPenalty", "roosterEarlyBurrowPenalty", "roosterEarlyLurkBonus", "roosterLateDashBonus", "roosterLateStayPenalty", "dashBeforeBurrowPenalty", "panicLurkPenalty", "panicBurrowBonus"]);
  for (const k of Object.keys(merged)) {
    if (FORBIDDEN.has(k)) delete merged[k];
    // extra safety: alle keys die met 'panic' of 'rooster' beginnen zijn legacy
    if (/^(panic|rooster)/i.test(k)) delete merged[k];
  }

  return merged;
}

function extractIntelForDenShare({ game, player }) {
  const idx = Number.isFinite(Number(game?.eventIndex)) ? Number(game.eventIndex) : null;
  if (idx === null) return null;

  const known = Array.isArray(player?.knownUpcomingEvents)
    ? player.knownUpcomingEvents.filter(Boolean).map((x) => String(x))
    : [];

  if (!known.length) return null;

  const events = known.slice(0, 2);
  const confidence = events.length >= 2 ? 0.75 : 0.6;

  return { events, atEventIndex: idx, confidence };
}

function mergeDenIntel(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;

  // andere eventIndex -> vervang
  if (Number(prev.atEventIndex) !== Number(next.atEventIndex)) return next;

  // zelfde index: hou “beste”
  const prevC = Number(prev.confidence || 0);
  const nextC = Number(next.confidence || 0);

  const prevKey = Array.isArray(prev.events) ? prev.events.join("|") : "";
  const nextKey = Array.isArray(next.events) ? next.events.join("|") : "";

  if (nextKey && nextKey !== prevKey) return { ...prev, ...next };
  if (nextC >= prevC) return { ...prev, ...next };
  return prev;
}

function shuffleArray(arr) {
  const a = Array.isArray(arr) ? [...arr] : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isActiveRaidStatus(status) {
  return status === "raid" || status === "round";
}

function isGameFinished(game) {
  return !game || game.status === "finished" || game.phase === "END";
}

function isInYard(p) {
  return p?.inYard !== false && !p?.dashed;
}

function sumLootPoints(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.reduce((s, c) => s + (Number(c?.v) || 0), 0);
}

function computeIsLeadForPlayer(game, me, players) {
  const myId = String(me?.id || "");

  const leadId = String(game?.leadFoxId || "");
  if (leadId && myId && leadId === myId) return true;

  const leadName = String(game?.leadFox || "");
  if (leadName && String(me?.name || "") && leadName === String(me.name)) return true;

  const idxRaw = Number.isFinite(Number(game?.leadIndex)) ? Number(game.leadIndex) : null;
  if (idxRaw === null) return false;

  const orderedAll = Array.isArray(players)
    ? [...players].sort((a, b) => (a?.joinOrder ?? 9999) - (b?.joinOrder ?? 9999))
    : [];

  // ✅ match host.js: leadIndex is op “actieve yard spelers”
  const orderedActive = orderedAll.filter(isInYard);
  const base = orderedActive.length ? orderedActive : orderedAll;
  if (!base.length) return false;

  const idx = ((idxRaw % base.length) + base.length) % base.length;
  return String(base[idx]?.id || "") === myId;
}

async function logBotDecision(db, gameId, payload) {
  try {
    if (!db || !gameId) return;
    await addDoc(collection(db, "games", gameId, "actions"), {
      kind: "BOT_DECISION",
      at: Date.now(),
      createdAt: serverTimestamp(),
      ...payload,
    });
  } catch (e) {
    console.warn("[BOT_LOG] failed", e);
  }
}

async function countBotActionsThisRoundFallback({ db, gameId, botId, roundNum }) {
  // Alleen gebruiken als je later game.actionDiscard niet meer bijhoudt
  if (!db || !gameId || !botId) return 0;

  try {
    const { collection, getDocs, query, where } = await import(
      "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js"
    );

    const q = query(
      collection(db, "games", gameId, "actions"),
      where("by", "==", botId),
      where("round", "==", roundNum)
    );
    const snap = await getDocs(q);
    return snap.size || 0;
  } catch (e) {
    console.warn("[BOTS] actions fallback failed:", e);
    return 0;
  }
}

function handToActionIds(hand) {
  const arr = Array.isArray(hand) ? hand : [];
  const ids = [];

  for (const c of arr) {
    const handKey = String(c?.name || c || "").trim();
    const rawId = String(c?.id || c?.actionId || "").trim();
    const key = rawId || handKey;
    if (!key) continue;

    if (/^[A-Z0-9_]+$/.test(key) && key.includes("_")) { ids.push(key); continue; }

    const def = handKey ? getActionDefByName(handKey) : null;
    const id = String(def?.id || "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

// ================================
// Metrics (centralized + loggable)
// ================================
function buildBotMetricsForLog({ game, bot, players, flagsRoundOverride = null, extraIntel = {} }) {
  const denColor = normColor(bot?.color || bot?.den || bot?.denColor);
  const presetKey = presetFromDenColor(denColor);
  const riskWeight = Number(BOT_PRESETS?.[presetKey]?.weights?.risk ?? 1);

  const isLead = computeIsLeadForPlayer(game, bot, players || []);

  const flags = flagsRoundOverride || fillFlags(game?.flagsRound);

  // carryValue blijft 1 source of truth: deze helper
  const carryValue = computeCarryValue(bot);
  const carryRecObj = computeCarryValueRec({ game, player: bot, players: players || [], mode: "publicSafe" });
  const carryValueRec = Number(carryRecObj?.carryValueRec || 0);

  const danger = computeDangerMetrics({
    game,
    player: bot,
    players: players || [],
    flagsRound: flags,
    intel: {
      denColor,
      presetKey,
      riskWeight,
      isLead,

      // CANON: danger/caught-risk is not scaled by carry/loot
      carryValue: 0,
      carryValueExact: 0,
      carryValueRec: 0,

      ...(extraIntel || {}),
    },
  });

   const dvIn = (danger?.dangerVec && typeof danger.dangerVec === "object") ? danger.dangerVec : null;

  // CANON: BURROW heeft geen dangerVec (altijd veilig)
  const dv = dvIn ? { ...dvIn, burrow: 0, BURROW: 0, dangerBurrow: 0, burrowRisk: 0 } : null;

  const lurkRisk = Number(dv?.lurk ?? dv?.LURK ?? NaN);
  const dashRisk = Number(dv?.dash ?? dv?.DASH ?? NaN);

  const dangerStayFix = Number.isFinite(lurkRisk) ? lurkRisk : (danger?.dangerStay ?? 0);
  const dangerEffectiveFix = Number.isFinite(lurkRisk) ? lurkRisk : (danger?.dangerEffective ?? 0);

  const dangerPeakFix =
    (Number.isFinite(dashRisk) || Number.isFinite(lurkRisk))
      ? Math.max(Number.isFinite(dashRisk) ? dashRisk : 0, Number.isFinite(lurkRisk) ? lurkRisk : 0)
      : (danger?.dangerPeak ?? 0);

  return {
    carryValue,
    carryValueRec,
    carryRecDebug: carryRecObj?.debug ?? null,
    lootLen: Array.isArray(bot?.loot) ? bot.loot.length : 0,
    lootSample: Array.isArray(bot?.loot) ? bot.loot.slice(0, 3) : [],
    dangerScore: danger?.dangerScore ?? 0,
    dangerVec: dv,
    dangerPeak: dangerPeakFix,
    dangerStay: dangerStayFix,
    dangerEffective: dangerEffectiveFix,
    nextEventIdUsed: danger?.nextEventIdUsed ?? null,
    pDanger: danger?.pDanger ?? 0,
    confidence: danger?.confidence ?? 0,
    intel: danger?.intel ?? null,
    debug: danger?.debug ?? null,
  };

}


// ================================
// Heuristics/Strategies ctx builder
// ================================
function peakDanger(f) {
  if (!f) return 0;
  return Math.max(Number(f.dangerDash || 0), Number(f.dangerLurk || 0), Number(f.dangerBurrow || 0));
}

function buildRevealedDenMap(game) {
  const out = {};
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];
  const n = Math.min(track.length, rev.length);

  for (let i = 0; i < n; i++) {
    if (rev[i] !== true) continue;
    const id = String(track[i] || "");
    if (id.startsWith("DEN_")) out[id.slice(4).toUpperCase()] = true;
  }
  return out;
}

// Belangrijk: Rooster-gevaar pas opvoeren NA de 2e rooster die echt REVEALED is.
// We baseren dit op eventRevealed (en vallen terug op game.roosterSeen als dat ontbreekt).
function countRevealedRoosters(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];
  const n = Math.min(track.length, rev.length);

  let c = 0;
  for (let i = 0; i < n; i++) {
    if (rev[i] === true && String(track[i]) === "ROOSTER_CROW") c++;
  }
  if (c === 0 && Number.isFinite(Number(game?.roosterSeen))) c = Number(game.roosterSeen);
  return c;
}
function buildBotCtxForHeuristics({
  game,
  bot,
  players,
  handNames,
  handIds,
  actionsPlayedThisRoundOverride, // optioneel
}) {
  const denColor = normColor(bot?.color || bot?.den || bot?.denColor);
  const round = Number.isFinite(Number(game?.round)) ? Number(game.round) : 0;

  // --- discard (zichtbaar) ---
  const disc = Array.isArray(game?.actionDiscard) ? game.actionDiscard : [];
  const discThisRound = disc.filter((x) => Number(x?.round || 0) === round);

  const botPlayedThisRound = discThisRound.filter((x) => x?.by === bot?.id);
  const actionsPlayedThisRound =
    Number.isFinite(Number(actionsPlayedThisRoundOverride))
      ? Number(actionsPlayedThisRoundOverride)
      : botPlayedThisRound.length;

  // map discard item -> actionId (id als het al lijkt op ACTION_ID, anders via naam)
  const toActionId = (x) => {
    const rawId = String(x?.id || x?.actionId || x?.key || "").trim();
    if (rawId && /^[A-Z0-9_]+$/.test(rawId) && rawId.includes("_")) return rawId;

    const nm = String(x?.name || "").trim();
    if (!nm) return null;
    const def = getActionDefByName(nm);
    return def?.id || null;
  };

  const discardThisRoundActionIds = discThisRound.map(toActionId).filter(Boolean);

  const discardRecentActionIds = [...disc]
    .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0))
    .slice(-10)
    .map(toActionId)
    .filter(Boolean);

  const discardActionIds = [
    ...(Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile : []),
    ...disc.map((x) => x?.name),
  ]
    .map((x) => (typeof x === "string" ? (getActionDefByName(x)?.id || x) : x))
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  // --- scout knowledge ---
  const knownUpcomingEvents = Array.isArray(bot?.knownUpcomingEvents)
    ? bot.knownUpcomingEvents.filter(Boolean)
    : [];
  const knownUpcomingCount = knownUpcomingEvents.length;

  const scoutTier =
    knownUpcomingCount >= 2
      ? "HARD_SCOUT"
      : knownUpcomingCount === 1
      ? "SOFT_SCOUT"
      : "NO_SCOUT";


  // --- next event facts (respect noPeek) ---
  const flags = fillFlags(game?.flagsRound);
  const noPeek = !!flags.noPeek;
  const nextKnown = !noPeek || knownUpcomingCount > 0;
  const nextId = nextKnown ? (noPeek ? (knownUpcomingEvents[0] || null) : getNextEventId(game)) : null;
  const isLead = computeIsLeadForPlayer(game, bot, players || []);
const revealedRoosters = countRevealedRoosters(game);

const nextFacts = nextId ? getEventFacts(nextId, {
  game,
  me: bot,
  denColor,
  isLead,
  flagsRound: game?.flagsRound || null,
  lootLen: Array.isArray(bot?.loot) ? bot.loot.length : 0,
  carryExact: computeCarryValue(bot),
  roosterSeen: Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : revealedRoosters,
}) : null;

  const dangerNext = peakDanger(nextFacts);

  // --- follow-tail hints (v1 simple) ---
  const ps = Array.isArray(players) ? players : [];
  const candidates = ps.filter((pl) => pl?.id && pl.id !== bot?.id && isInYard(pl));
  const sameDenCandidates = candidates.filter(
    (pl) => normColor(pl?.color || pl?.den || pl?.denColor) === denColor
  );

  const bestFollowTarget = sameDenCandidates[0] || candidates[0] || null;
  const bestFollowTargetDen = bestFollowTarget
    ? normColor(bestFollowTarget?.color || bestFollowTarget?.den || bestFollowTarget?.denColor)
    : null;

  const revealedDenEventsByColor = buildRevealedDenMap(game);

  const ctx = {
    round,
    phase: String(game?.phase || ""),
    botId: bot?.id || null,
    denColor,

    handActionNames: Array.isArray(handNames) ? handNames : [],
    handActionIds: Array.isArray(handIds) ? handIds : [],
    handSize: Array.isArray(handIds) ? handIds.length : 0,

    actionsPlayedThisRound,
    discardActionIds,
    discardThisRoundActionIds,
    discardRecentActionIds,

    nextEventId: nextId,
    nextEventFacts: nextFacts,
    dangerNext,

    scoutTier,

    nextKnown,

    roosterSeen: Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : revealedRoosters,
    postRooster2Window: revealedRoosters >= 2,

    revealedDenEventsByColor,

    hasEligibleFollowTarget: !!bestFollowTarget,
    bestFollowTargetIsSameDen: !!bestFollowTargetDen && bestFollowTargetDen === denColor,
    bestFollowTargetDenRevealed: !!bestFollowTargetDen && revealedDenEventsByColor[bestFollowTargetDen] === true,
  };

  // handHas_* flags voor strategies
  const idsSet = new Set(Array.isArray(handIds) ? handIds : []);
  for (const id of idsSet) ctx["handHas_" + id] = true;

  return ctx;
}

// 0..100 (grof, maar werkt goed)
function computeHandStrength({ game, bot }) {
  const ids = handToActionIds(bot?.hand);
  const denColor = normColor(bot?.color || bot?.den || bot?.denColor);
  const presetKey = presetFromDenColor(denColor);
  if (!ids.length) return { score: 0, ids: [], top: null };

  const handNames = (Array.isArray(bot?.hand) ? bot.hand : [])
    .map((c) => String(c?.name || c || "").trim())
    .filter(Boolean);

  const ctx = buildBotCtxForHeuristics({
    game,
    bot,
    players: [], // strength score heeft geen targets nodig
    handNames,
    handIds: ids,
  });

  // ranked (CORE + strategies modifiers zitten nu in rankActions)
  const ranked = rankActions(ids, { presetKey, denColor, game, me: bot, ctx });
  const topIds = ranked.slice(0, 2).map((x) => x.id);

  // basis raw score op top-2
  let raw = 0;
  for (const id of topIds) {
    const s = scoreActionFacts(id, { presetKey, denColor, game, me: bot, ctx });
    if (!s) continue;
    raw +=
      (s.controlScore || 0) +
      (s.infoScore || 0) +
      (s.lootScore || 0) +
      (s.tempoScore || 0) -
      (s.riskScore || 0);
  }
  // context: als next event gevaarlijk is, wil je liever een sterke hand
  const flags0 = fillFlags(game?.flagsRound);
  const noPeek0 = !!flags0.noPeek;
  const known0 = Array.isArray(bot?.knownUpcomingEvents) ? bot.knownUpcomingEvents.filter(Boolean) : [];
  const nextEvent0 = noPeek0 ? (known0[0] || null) : getNextEventId(game);
  const isLead0 = String(game?.leadFoxId || game?.leadFox || "") === String(bot?.id || "");
  const f = nextEvent0 ? getEventFacts(nextEvent0, { game, me: bot, denColor, isLead: isLead0 }) : null;
  const dangerPeak = peakDanger(f);

  // schaal en clamp
  let score = Math.round(Math.max(0, Math.min(100, raw * 5)));

  // bij hoog danger: iets strenger
  if (dangerPeak >= 7) score = Math.max(0, score - 10);

  return { score, ids, top: topIds[0] || null };
}

function avgLootValueFromDeck(lootDeck) {
  const arr = Array.isArray(lootDeck) ? lootDeck : [];
  if (!arr.length) return 1.2; // fallback
  const sum = arr.reduce((s, c) => s + (Number(c?.v) || 0), 0);
  return Math.max(0.8, sum / arr.length);
}

function countFutureRoosters(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;
  const future = track.slice(Math.max(0, idx));
  return future.filter((id) => id === "ROOSTER_CROW").length;
}

function estimateRoundsLeft(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;
  const remainingEvents = Math.max(0, track.length - idx);

  // rooster eindigt bij 3e crow; we schatten “druk” op basis van roosterSeen + future roosters
  const roosterSeen = Number(game?.roosterSeen || 0);
  const futureRoosters = countFutureRoosters(game);
  const roostersLeft = Math.max(0, 3 - roosterSeen);

  // simpele schatting: als er nog roosters zijn, raid stopt grofweg binnen remainingEvents,
  // maar de “deadline” wordt sneller naarmate roosterSeen hoger is.
  const pressure = 1 + roosterSeen * 0.35; // later = meer druk
  return Math.max(1, Math.round(Math.min(remainingEvents, 6) / pressure));
}

function survivalProbNextEvent({ eventId, decision, myColor, immune, isLead, lootPts }) {
  const id = String(eventId || "");

  // default: veilig
  let survive = 1;

  if (id.startsWith("DEN_")) {
    const color = id.slice(4).toUpperCase();
    if (color === myColor && !immune) {
      // DEN pakt jouw kleur, behalve BURROW of DASH
      survive = (decision === "BURROW" || decision === "DASH") ? 1 : 0;
    }
    return survive;
  }

  if (id === "DOG_CHARGE" || id === "SECOND_CHARGE") {
    if (immune) return 1;
    // DOG pakt iedereen behalve BURROW (en DASH is ook “safe” in engine)
    return (decision === "BURROW" || decision === "DASH") ? 1 : 0;
  }

  if (id === "SHEEPDOG_PATROL") {
    // PATROL pakt DASHERS
    return decision === "DASH" ? 0 : 1;
  }

  if (id === "GATE_TOLL") {
    // DASH wordt geskipt; anders moet je 1 loot hebben
    if (decision === "DASH") return 1;
    return lootPts > 0 ? 1 : 0;
  }

  if (id === "MAGPIE_SNITCH") {
    if (!isLead) return 1;
    // lead wordt gepakt tenzij BURROW of DASH
    return (decision === "BURROW" || decision === "DASH") ? 1 : 0;
  }

  if (id === "SILENT_ALARM") {
    // engine doet nu niks, maar strategisch is dit “lead-penalty”.
    // We modelleren risico als “scoreverlies”, niet survival.
    return 1;
  }

  return survive;
}

function silentAlarmPenalty({ eventId, decision, isLead, lootPts }) {
  if (String(eventId || "") !== "SILENT_ALARM") return 0;
  if (!isLead) return 0;

  // jouw kaarttekst: lead moet 2 loot afleggen of verliest lead
  // model: als je blijft (LURK/BURROW) betaal je gemiddeld 1.6 punten “penalty”.
  // DASH ontwijkt penalty (want je bent weg).
  if (decision === "DASH") return 0;
  if (lootPts >= 2) return 2.0;
  return 1.2; // als je weinig hebt, penalty “lead loss” ≈ minder erg dan 2 loot
}

function expectedSackShareNow({ game, players }) {
  const sack = Array.isArray(game?.sack) ? game.sack : [];
  const sackValue = sack.reduce((s, c) => s + (Number(c?.v) || 0), 0);
  if (!sack.length) return 0;

  // grof: deel door (dashersAlready + 1). (Later: betere voorspelling)
  const dashersAlready = (players || []).filter((pl) => pl?.dashed && pl?.inYard !== false).length;
  const divisor = Math.max(1, dashersAlready + 1);
  return sackValue / divisor;
}

function countDashDecisions(players) {
  return (players || []).filter((x) => isInYard(x) && x?.decision === "DASH").length;
}

function hiddenNestBonusCards(totalDashers) {
  if (totalDashers <= 1) return 3;
  if (totalDashers === 2) return 2;
  if (totalDashers === 3) return 1;
  return 0; // 4+ => niets
}

function trackProgress01(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;
  const denom = Math.max(1, track.length - 1);
  return Math.max(0, Math.min(1, idx / denom)); // 0..1
}

// --- deterministic selection helpers (prevents bot herding on congestion events) ---
function stableHash32(str) {
  // FNV-1a 32-bit
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hiddenNestDashTargetTotal(game, eligibleCount) {
  const prog = trackProgress01(game); // 0..1
  if (eligibleCount <= 2) return 1;
  // early track: usually better to keep tempo; later: 2 dashers is sweet spot
  return prog < 0.45 ? 1 : 2;
}

function pickHiddenNestDashSet({ game, gameId, players }) {
  const list = Array.isArray(players) ? players : [];

  const eligibleAll = list.filter((x) => isInYard(x));
  const eligibleUndecided = eligibleAll.filter((x) => !x?.decision);

  const alreadyDash = eligibleAll.filter((x) => x?.decision === "DASH");
  const dashSet = new Set(alreadyDash.map((x) => x.id));

  const targetTotal = hiddenNestDashTargetTotal(game, eligibleAll.length);

  // if already overcrowded (humans/bots), no more slots
  const remainingSlots = Math.max(0, targetTotal - dashSet.size);
  if (remainingSlots <= 0) {
    return { dashSet, targetTotal, remainingSlots };
  }

  // Color bias: determines *who* gets the limited dash slots (not how many).
  // Negative bias => more likely to be selected as dasher.
  const biasByPreset = {
    RED: -0.15,
    YELLOW: -0.08,
    BLUE: -0.05,
    GREEN: 0.05,
  };

  const seedBase = `${String(gameId || "")}|${Number(game?.round || 0)}|${Number(game?.eventIndex || 0)}|HIDDEN_NEST`;

  const ranked = eligibleUndecided
    .map((pl) => {
      const den = normColor(pl?.color || pl?.den || pl?.denColor);
      const preset = presetFromDenColor(den);
      const u = stableHash32(`${seedBase}|${pl.id}`) / 4294967296; // 0..1
      const bias = biasByPreset[preset] ?? 0;
      return { id: pl.id, key: u + bias, preset, den };
    })
    .sort((a, b) => a.key - b.key);

  for (let i = 0; i < Math.min(remainingSlots, ranked.length); i++) {
    dashSet.add(ranked[i].id);
  }

  return { dashSet, targetTotal, remainingSlots };
}

function nextEventId(game, offset = 0) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;
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

function fillFlags(flagsRound) {
  const fr = flagsRound || {};
  const noPeek = fr.noPeek === true; // STRICT boolean only (prevents [] -> true)

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


function getNextEventId(game) {
  if (Array.isArray(game.eventTrack) && typeof game.eventIndex === "number") {
    return game.eventTrack[game.eventIndex] || null;
  }
  return game.currentEventId || null;
}


function toActionId(nameOrId) {
  const n = String(nameOrId || "").trim();
  if (!n) return null;
  const def = getActionDefByName(n);
  return def?.id || null;
}

function buildBotCtx({ game, bot, players, handActionIds, handActionKeys, nextEventFacts, isLast, scoreBehind }) {
  const round = Number.isFinite(game?.round) ? game.round : 0;
  const phase = String(game?.phase || "");
  const denColor = normColor(bot?.color || bot?.den || bot?.denColor);

  // --- discard arrays (visible to all bots) ---
  const actionDiscard = Array.isArray(game?.actionDiscard) ? game.actionDiscard : [];
  const discardThisRound = actionDiscard.filter((x) => Number(x?.round) === round);
  const discardThisRoundActionIds = discardThisRound
    .map((x) => toActionId(x?.name))
    .filter(Boolean);

  const discardRecentActionIds = [...actionDiscard]
    .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0))
    .slice(-10)
    .map((x) => toActionId(x?.name))
    .filter(Boolean);

  const discardActionIds = [
    ...actionDiscard.map((x) => toActionId(x?.name)),
    ...(Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile.map((x) => toActionId(x)) : []),
  ].filter(Boolean);

  // --- den events revealed knowledge ---
  const revealedDenEventsByColor = { RED: false, GREEN: false, BLUE: false, YELLOW: false };
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];
  for (let i = 0; i < Math.min(track.length, rev.length); i++) {
    if (!rev[i]) continue;
    const eid = String(track[i] || "");
    if (eid.startsWith("DEN_")) {
      const c = normColor(eid.slice(4));
      if (c && c in revealedDenEventsByColor) revealedDenEventsByColor[c] = true;
    }
  }

  // --- scout (v1: meestal leeg; later vullen vanuit intel) ---
  const knownUpcomingEvents = Array.isArray(bot?.knownUpcomingEvents) ? bot.knownUpcomingEvents : [];
  const knownUpcomingCount = knownUpcomingEvents.length;
  const scoutTier = knownUpcomingCount >= 2 ? "HARD_SCOUT" : knownUpcomingCount >= 1 ? "SOFT_SCOUT" : "NO_SCOUT";
  const nextKnown = knownUpcomingCount >= 1;

  // --- dangerNext (0..10) ---
  const dangerNext = nextEventFacts
    ? Math.max(
        Number(nextEventFacts.dangerDash || 0),
        Number(nextEventFacts.dangerLurk || 0),
        Number(nextEventFacts.dangerBurrow || 0)
      )
    : 0;

  // --- rooster timing (v1) ---
  const roosterSeen = Number.isFinite(game?.roosterSeen) ? game.roosterSeen : 0;
  const postRooster2Window = roosterSeen >= 2;
  const rooster2JustRevealed = false; // later netjes als je reveal-moment flagt

  // --- flags ---
  const lockEventsActive = !!game?.flagsRound?.lockEvents;
  const opsLockedActive = !!game?.flagsRound?.opsLocked;

  // --- carry (exact + relative) ---
  const carryValueExact = computeCarryValue(bot);
  const carryRecObj = computeCarryValueRec({ game, player: bot, players: players || [], mode: "publicSafe" });
  const carryValueRec = Number(carryRecObj?.carryValueRec || 0);
  const carryValue = carryValueRec;// cashout core uses this


  // --- follow target hints (simple v1) ---
  const list = Array.isArray(players) ? players : [];
  const candidates = list.filter((p) => p?.id && p.id !== bot?.id && !p?.caught);
  const sameDenTargets = candidates.filter((p) => normColor(p?.den || p?.denColor || p?.color) === denColor);
  const denRevealedTargets = candidates.filter((p) => {
    const c = normColor(p?.den || p?.denColor || p?.color);
    return !!revealedDenEventsByColor[c];
  });

  const eligible = [...new Map([...sameDenTargets, ...denRevealedTargets].map((p) => [p.id, p])).values()];
  const hasEligibleFollowTarget = eligible.length > 0;

  // pick best eligible target by carry/score
  const best = eligible
    .map((p) => ({
      p,
      v: Number.isFinite(Number(p?.score)) ? Number(p.score) : computeCarryValue(p),
    }))
    .sort((a, b) => b.v - a.v)[0]?.p;

  const bestFollowTargetIsSameDen = best ? normColor(best?.den || best?.denColor || best?.color) === denColor : false;
  const bestFollowTargetDenRevealed = best
    ? !!revealedDenEventsByColor[normColor(best?.den || best?.denColor || best?.color)]
    : false;

  // --- ctx base ---
  const ctx = {
    phase,
    round,
    botId: bot?.id,
    denColor,
    carryValue,
    carryValueExact,
    carryValueRec,
    carryRecDebug: carryRecObj?.debug ?? null,
    lootLen: Array.isArray(bot?.loot) ? bot.loot.length : 0,
    lootSample: Array.isArray(bot?.loot) ? bot.loot.slice(0, 3) : [],
    isLast: !!isLast,
    scoreBehind: Number(scoreBehind || 0),

    handActionKeys: handActionKeys || [],
    handActionIds: handActionIds || [],
    handSize: Array.isArray(handActionIds) ? handActionIds.length : 0,

    actionsPlayedThisRound: Number(bot?.actionsPlayedThisRound || 0), // als je dit al bijhoudt; anders later uit discard per bot
    discardActionIds,
    discardThisRoundActionIds,
    discardRecentActionIds,

    nextKnown,
    knownUpcomingEvents,
    knownUpcomingCount,
    scoutTier,
    nextEventFacts: nextEventFacts || null,
    dangerNext,

    roosterSeen,
    rooster2JustRevealed,
    postRooster2Window,

    lockEventsActive,
    opsLockedActive,

    revealedDenEventsByColor,

    sameDenTargetsCount: sameDenTargets.length,
    hasEligibleFollowTarget,
    bestFollowTargetIsSameDen,
    bestFollowTargetDenRevealed,
  };

  // dynamic handHas_* flags
  const set = new Set(handActionIds || []);
  for (const id of set) ctx["handHas_" + id] = true;

  return ctx;
}
// =====================================================
// Pick best Action Card for BOT (OPS phase)
// - builds rich ctx for botHeuristics (CORE + strategies)
// - chooses targets for cards that need it
// - anti-duplicate (self + global singleton per round)
// - logs ranked choices to games/{gameId}/actions (BOT_DECISION)
// =====================================================

async function pickBestActionFromHand({ db, gameId, game, bot, players }) {
  // helper: convert discard item -> actionId (hoisted)
  function toActionId(x) {
    const rawId = String(x?.id || x?.actionId || x?.key || "").trim();
    if (rawId && /^[A-Z0-9_]+$/.test(rawId) && rawId.includes("_")) return rawId;

    const nm = String(x?.name || "").trim();
    if (!nm) return null;

    const def = getActionDefByName(nm);
    return def?.id ? String(def.id) : null;
  }

  try {
    const hand = Array.isArray(bot?.hand) ? bot.hand : [];
    if (!hand.length) return null;
   
    const handNames = hand
    .map((c) => String(c?.name || c || "").trim())
    .filter(Boolean);

    // map hand -> entries with BOTH:
    // - actionId (canonical)
    // - handToken (the actual thing that exists in hand for removal)
    const entries = hand
      .map((c) => {
        const rawId = String(c?.id || c?.actionId || c?.key || "").trim();
        const nm = String(c?.name || (typeof c === "string" ? c : "") || "").trim();
        const key = rawId || nm;
        if (!key) return null;

        // if already an ID
        if (/^[A-Z0-9_]+$/.test(key) && key.includes("_")) {
          return {
            actionId: key,
            displayName: nm || key,
            handToken: nm || key, // keep removable token
          };
        }

        // resolve name -> id via cards.js defs
        const def = getActionDefByName(key);
        if (!def?.id) return null;

        return {
          actionId: String(def.id).trim(),
          displayName: String(def.name || key).trim(),
          handToken: nm || String(def.name || key).trim(),
        };
      })
      .filter(Boolean);

    const ids = entries.map((e) => e.actionId).filter(Boolean);
    if (!ids.length) return null;

    const denColor = normColor(bot?.color || bot?.den || bot?.denColor);
    const presetKey = presetFromDenColor(denColor);

    // ---------- round + discard ----------
    const roundNum = Number.isFinite(Number(game?.round)) ? Number(game.round) : 0;
    const disc = Array.isArray(game?.actionDiscard) ? game.actionDiscard : [];
    const discThisRound = disc.filter((x) => Number(x?.round || 0) === roundNum);

    const botPlayedThisRound = discThisRound.filter((x) => x?.by === bot.id);
    const botPlayedActionIdsThisRound = botPlayedThisRound.map(toActionId).filter(Boolean);
    const actionsPlayedThisRound = botPlayedThisRound.length;

    const discardThisRoundActionIds = discThisRound.map(toActionId).filter(Boolean);

    const discardRecentActionIds = [...disc]
      .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0))
      .slice(-10)
      .map(toActionId)
      .filter(Boolean);

    const discardActionIds = [
      ...(Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile : []),
      ...disc.map((x) => x?.name),
    ]
      .map((v) => {
        if (typeof v === "string") {
          const def = getActionDefByName(v);
          return def?.id ? String(def.id) : String(v);
        }
        return null;
      })
      .filter(Boolean);

    // ---------- flags / next event / knowledge ----------
    const flags = fillFlags(game?.flagsRound);
    const noPeek = !!flags.noPeek;

    const knownUpcomingEvents = Array.isArray(bot?.knownUpcomingEvents)
      ? bot.knownUpcomingEvents.filter(Boolean)
      : [];
    const knownUpcomingCount = knownUpcomingEvents.length;

    const nextKnown = !noPeek || knownUpcomingCount >= 1;
    const nextId = nextKnown ? String(noPeek ? knownUpcomingEvents[0] : nextEventId(game, 0) || "") : null;

    const isLead = String(game?.leadFoxId || game?.leadFox || "") === String(bot?.id || "");

    // ---------- rooster timing: count revealed roosters ----------
    const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
    const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];

    let revealedRoosters = 0;
    for (let i = 0; i < Math.min(track.length, rev.length); i++) {
      if (rev[i] === true && String(track[i]) === "ROOSTER_CROW") revealedRoosters++;
    }
    const roosterSeen =
      revealedRoosters ||
      (Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : 0);

    const postRooster2Window = revealedRoosters >= 2;

    // carryExact alvast, zodat eventFacts context klopt
    const carryExact = computeCarryValue(bot);
    const lootLen = Array.isArray(bot?.loot) ? bot.loot.length : 0;

    // IMPORTANT: pass the ctx shape your rulesIndex expects
    const nextEventFacts = nextId
      ? getEventFacts(nextId, {
          denColor,
          isLead,
          flagsRound: flags,
          lootLen,
          carryExact,
          roosterSeen,
        })
      : null;

    const dangerNext = nextEventFacts
      ? Math.max(
          Number(nextEventFacts.dangerDash || 0),
          Number(nextEventFacts.dangerLurk || 0),
          Number(nextEventFacts.dangerBurrow || 0)
        )
      : 0;

    const scoutTier =
      knownUpcomingCount >= 2 ? "HARD_SCOUT" :
      knownUpcomingCount >= 1 ? "SOFT_SCOUT" :
      "NO_SCOUT";

    // ---------- score meta (last / behind) ----------
    const list = Array.isArray(players) ? players.filter((x) => x?.id) : [];
    const getVal = (pl) => {
      const s = Number(pl?.score);
      if (Number.isFinite(s)) return s;
      return sumLootPoints(pl);
    };
    const sorted = [...list].sort((a, b) => getVal(b) - getVal(a));
    const leaderVal = sorted.length ? getVal(sorted[0]) : 0;
    const myVal = getVal(bot);

    const carryRecObj3 = computeCarryValueRec({ game, player: bot, players: list, mode: "publicSafe" });
    const carryRec = Number(carryRecObj3?.carryValueRec || 0);

    const myRank = sorted.findIndex((x) => x.id === bot.id);
    const isLast = myRank >= 0 ? myRank === sorted.length - 1 : false;
    const scoreBehind = Math.max(0, leaderVal - myVal);

    const lockEventsActive = !!flags?.lockEvents;
    const opsLockedActive = !!flags?.opsLocked;

    // ---------- revealed den events by color ----------
    const revealedDenEventsByColor = {};
    for (let i = 0; i < Math.min(track.length, rev.length); i++) {
      if (rev[i] !== true) continue;
      const id = String(track[i] || "");
      if (id.startsWith("DEN_")) {
        const c = normColor(id.split("_")[1] || "");
        if (c) revealedDenEventsByColor[c] = true;
      }
    }

    // ---------- Follow target selection (basis) ----------
    function pickBestFollowTarget() {
      const candidates = (players || []).filter((x) => x?.id && x.id !== bot.id && isInYard(x));
      if (!candidates.length) return { targetId: null, sameDen: false, denRevealed: false, eligible: false };

      let best = null;
      for (const pl of candidates) {
        const cDen = normColor(pl?.color || pl?.den || pl?.denColor);

        const sameDen = cDen && cDen === denColor;
        const denRevealed = !!revealedDenEventsByColor[cDen];
        const eligible = !nextKnown && (sameDen || denRevealed);

        let score = 0;
        if (sameDen) score += 10;
        if (denRevealed) score += 6;
        if (eligible) score += 4;

        const k = Array.isArray(pl?.knownUpcomingEvents) ? pl.knownUpcomingEvents.length : 0;
        score += Math.min(3, k);

        score += Math.min(5, sumLootPoints(pl) * 0.4);

        if (!best || score > best.score) best = { id: pl.id, score, sameDen, denRevealed, eligible };
      }

      return {
        targetId: best?.id || null,
        sameDen: !!best?.sameDen,
        denRevealed: !!best?.denRevealed,
        eligible: !!best?.eligible,
      };
    }

    const followPick = pickBestFollowTarget();

    // ---------- ctx for heuristics/strategies ----------
    const ctx = {
      phase: String(game?.phase || ""),
      round: roundNum,
      botId: bot?.id || null,
      denColor,

      carryValue: carryRec,
      carryValueExact: carryExact,
      carryValueRec: carryRec,
      isLast,
      scoreBehind,

      handActionIds: ids,
      handSize: ids.length,

      actionsPlayedThisRound,
      discardActionIds,
      discardThisRoundActionIds,
      discardRecentActionIds,

      nextEventId: nextId,
      nextEventFacts,
      dangerNext,
      nextKnown,
      knownUpcomingEvents,
      knownUpcomingCount,
      scoutTier,

      roosterSeen,
      postRooster2Window,

      lockEventsActive,
      opsLockedActive,

      hasEligibleFollowTarget: followPick.eligible && !!followPick.targetId,
      bestFollowTargetIsSameDen: followPick.sameDen,
      bestFollowTargetDenRevealed: followPick.denRevealed,

      revealedDenEventsByColor,
    };

    for (const id of ids) ctx["handHas_" + id] = true;

  // ---------- ranking (strategy.js) ----------
const usedIds = (
  Array.isArray(game?.discardThisRoundActionIds) && game.discardThisRoundActionIds.length
)
  ? game.discardThisRoundActionIds.map((x) => String(x))
  : (Array.isArray(discardThisRoundActionIds) ? discardThisRoundActionIds : []);

const res = evaluateOpsActions({
  game,
  me: bot,
  players: list,
  flagsRound: flags,
  cfg: getStrategyCfgForBot(bot, game), // behoud: per-bot DISC overrides (+ optioneel game.botDiscProfiles)
});
    
// ✅ Respecteer strategy: als best = PASS → echt PASS
if (res?.best?.kind !== "PLAY") return null;

const passU0 = Number(res?.baseline?.passUtility ?? 0);
const req0 = Number(res?.meta?.requiredGain ?? 0);
const minU0 = passU0 + req0;
    
    if (game?.debugBots) {
      console.log(
        "[OPS]",
        bot.id,
        "hand", (bot.hand || []).length,
        "best", res?.best?.kind, res?.best?.reason,
        "bestU", res?.best?.utility,
        "topU", res?.ranked?.[0]?.utility
      );
    }

    const candidates = [];
candidates.push(...(res.best.plays || []));

// ranked alleen als ze óók boven de drempel zitten (fallback als best play illegaal is)
for (const r of (res?.ranked || [])) {
  if (r?.play && Number(r.utility) >= minU0) candidates.push(r.play);
}
    
    const botPlayedSet = new Set(botPlayedActionIdsThisRound);

    const GLOBAL_SINGLETON_ACTIONS = new Set([
      "KICK_UP_DUST",
      "PACK_TINKER",
      "NO_GO_ZONE",
      "SCATTER",
    ]);

    for (const play of candidates) {
      const id = String(play?.actionId || "").trim();
      if (!id) continue;

      if (botPlayedSet.has(id)) continue;
      if (GLOBAL_SINGLETON_ACTIONS.has(id) && usedIds.includes(id)) continue;

      // legality checks
if (id === "KICK_UP_DUST") {
  if (lockEventsActive) continue;
  if (!Array.isArray(game?.eventTrack)) continue;
  if (!Number.isFinite(Number(game?.eventIndex))) continue;
  if (Number(game.eventIndex) >= game.eventTrack.length - 1) continue;
}

if (id === "PACK_TINKER") {
  // Pack Tinker = hand ↔ discard pile (niet eventTrack)
  const pile = Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile : [];
  const hasPile = pile.some((x) => x && typeof x === "object" && x.uid && x.name);
  if (!hasPile) continue;
  if ((handNames?.length || 0) < 2) continue; // je moet iets anders hebben om te ruilen
}

      if (id === "HOLD_STILL" && opsLockedActive) continue;

      // IMPORTANT: choose a token that actually exists in hand
      const chosenName =
        entries.find((e) => e.actionId === id)?.handToken ||
        String(play?.name || "").trim();

      if (!chosenName) continue;

      let targetId = play?.targetId || null;

      if ((id === "MASK_SWAP" || id === "HOLD_STILL") && !targetId) {
        targetId = pickRichestTarget(players || [], bot.id);
        if (!targetId) continue;
      }

      if (id === "FOLLOW_THE_TAIL" && !targetId) {
        targetId = followPick.targetId || pickRichestTarget(players || [], bot.id);
        if (!targetId) continue;
      }

      if (id === "SCENT_CHECK" && !targetId) {
        const intelTarget =
          (players || [])
            .filter((x) => x?.id && x.id !== bot.id && isInYard(x))
            .map((x) => ({
              id: x.id,
              k: Array.isArray(x?.knownUpcomingEvents) ? x.knownUpcomingEvents.length : 0,
              loot: sumLootPoints(x),
            }))
            .sort((a, b) => (b.k - a.k) || (b.loot - a.loot))[0]?.id || null;

        targetId = intelTarget || pickRichestTarget(players || [], bot.id);
        if (!targetId) continue;
      }

      return { name: chosenName, actionId: id, targetId };
    }

    return null;
  } catch (err) {
    console.warn("[BOTS] pickBestActionFromHand crashed -> PASS", err);
    return null;
  }
}

function getOpsTurnId(game) {
  if (!game || game.phase !== "ACTIONS") return null;
  const order = Array.isArray(game.opsTurnOrder) ? game.opsTurnOrder : [];
  if (!order.length) return null;
  const idx = Number.isFinite(game.opsTurnIndex) ? game.opsTurnIndex : 0;
  if (idx < 0 || idx >= order.length) return null;
  return order[idx];
}

function canBotMove(game, p) {
  if (!game || !p) return false;
  if (!isActiveRaidStatus(game.status)) return false;
  if (game.phase !== "MOVE") return false;
  if (game.raidEndedByRooster) return false;
  if (!isInYard(p)) return false;
  const moved = Array.isArray(game.movedPlayerIds) ? game.movedPlayerIds : [];
  return !moved.includes(p.id);
}

function canBotDecide(game, p) {
  if (!game || !p) return false;
  if (!isActiveRaidStatus(game.status)) return false;
  if (game.phase !== "DECISION") return false;
  if (game.raidEndedByRooster) return false;
  if (!isInYard(p)) return false;
  if (p.decision) return false;
  return true;
}

function hasCard(hand, name) {
  const n = String(name || "");
  return Array.isArray(hand) && hand.some((c) => String(c?.name || c).trim() === n);
}

function removeOneCard(hand, name) {
  const n = String(name || "");
  const idx = hand.findIndex((c) => String(c?.name || c).trim() === n);
  if (idx >= 0) hand.splice(idx, 1);
  return idx >= 0;
}

function discardPileHasCard(game, name) {
  const n = String(name || "").trim();
  const pile = Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile : [];
  return pile.some((x) => x && typeof x === "object" && x.uid && String(x.name || "").trim() === n);
}

function canBotPackTinkerNow(game, bot) {
  const hand = Array.isArray(bot?.hand) ? bot.hand : [];
  const hasOther = hand.some((c) => String(c?.name || c).trim() !== "Pack Tinker");
  const pile = Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile : [];
  const hasPile = pile.some((x) => x && typeof x === "object" && x.uid && x.name);
  return hasOther && hasPile;
}

function pickRichestTarget(players, excludeId) {
  const candidates = (players || []).filter((x) => x?.id && x.id !== excludeId && isInYard(x));
  if (!candidates.length) return null;
  candidates.sort((a, b) => sumLootPoints(b) - sumLootPoints(a));
  return candidates[0]?.id || null;
}

/** ===== runner id (prevents multi-tab chaos; lock still the real guard) ===== */
function getRunnerId() {
  try {
    const k = "vj_botRunnerId";
    let v = localStorage.getItem(k);
    if (!v) {
      v = globalThis.crypto?.randomUUID
        ? crypto.randomUUID()
        : String(Math.random()).slice(2) + "-" + Date.now();
      localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return String(Math.random()).slice(2) + "-" + Date.now();
  }
}
/** ===== logging ===== */
async function logBotAction({ db, gameId, addLog, payload }) {
  // ✅ keep: structured action timeline
  await addDoc(collection(db, "games", gameId, "actions"), {
    ...payload,
    createdAt: serverTimestamp(),
  });

  // ❌ disable: extra log writes (story log)
  // if (typeof addLog === "function") {
  //   await addLog(gameId, {
  //     round: payload.round ?? 0,
  //     phase: payload.phase ?? "",
  //     kind: "BOT",
  //     playerId: payload.playerId,
  //     message: payload.message || `${payload.playerName || "BOT"}: ${payload.choice}`,
  //   });
  // }
}

async function applyOpsActionAndAdvanceTurn({ db, gameRef, actorId, isPass }) {
  const now = Date.now();

  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists()) return { didApply: false, reason: "no-game" };

    const g = snap.data();
    if (g.phase !== "ACTIONS") return { didApply: false, reason: "not-actions" };

    const order = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder : [];
    if (!order.length) return { didApply: false, reason: "no-order" };

    const idx = Number.isFinite(g.opsTurnIndex) ? g.opsTurnIndex : 0;
    const expected = order[idx];

    // Alleen wie aan de beurt is
    if (expected !== actorId) return { didApply: false, reason: "not-your-turn" };

    const opsLocked = !!g.flagsRound?.opsLocked;
    const target = Number(g.opsActiveCount || order.length);
    const passesNow = Number(g.opsConsecutivePasses || 0);

    // Als OPS klaar is: niets meer accepteren
    if (opsLocked || passesNow >= target) return { didApply: false, reason: "ops-ended" };

    const nextIdx = (idx + 1) % order.length;

    // PASS telt op, echte action reset
    let nextPasses = isPass ? passesNow + 1 : 0;

    // clamp
    if (nextPasses > target) nextPasses = target;

    const ended = nextPasses >= target;

    tx.update(gameRef, {
      opsTurnIndex: nextIdx,
      opsConsecutivePasses: nextPasses,
      ...(ended
        ? {
            flagsRound: { ...(g.flagsRound || {}), opsLocked: true },
            opsEndedAtMs: now,
          }
        : {}),
    });

    return {
      didApply: true,
      ended,
      nextPasses,
      target,
      nextIdx,
    };
  });
}

/** ===== lock (one bot-runner active per game) ===== */
async function acquireBotLock({ db, gameId, gameRef, runnerKey }) {
  const now = Date.now();

  try {
    const ok = await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) return false;
      const g = snap.data();

      if (g?.botsEnabled !== true) return false;
      if (isGameFinished(g)) return false;

      const lockUntil = Number(g.botsLockUntil || 0);
      const lockBy = String(g.botsLockBy || "");

      if (lockUntil > now && lockBy && lockBy !== runnerKey) return false;

      tx.update(gameRef, { botsLockUntil: now + LOCK_MS, botsLockBy: runnerKey });
      return true;
    });

    return ok === true;
  } catch (e) {
    console.warn("[BOTS] acquire lock failed", e);
    return false;
  }
}

/** ===== smarter MOVE ===== */
async function botDoMove({ db, gameId, botId, latestPlayers = [] }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };
    if (!canBotMove(g, p)) return;

    const moved = Array.isArray(g.movedPlayerIds) ? [...g.movedPlayerIds] : [];
    const hand = Array.isArray(p.hand) ? [...p.hand] : [];
    const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const lootDeck = Array.isArray(g.lootDeck) ? [...g.lootDeck] : [];
    const loot = Array.isArray(p.loot) ? [...p.loot] : [];

    const flags = fillFlags(g.flagsRound);
    // --- Den Intel share (publish) ---
const denColor = normColor(p.color);

const share = extractIntelForDenShare({ game: g, player: p });
if (share && denColor) {
  const prev = flags?.denIntel?.[denColor] || null;
  const merged = mergeDenIntel(prev, {
    ...share,
    by: String(p.id || botId || ""),
    at: Date.now(),
  });

  tx.update(gRef, { [`flagsRound.denIntel.${denColor}`]: merged });
}
    const myColor = normColor(p.color);
    const immune = !!flags.denImmune?.[myColor];
    const lootPts = sumLootPoints({ loot });

    // === Metrics-driven MOVE planning (carryValueRec + dangerEffective) ===
    // Rule: do NOT peek the hidden next event. Only use deterministic next-event info
    // if the bot actually knows it (SCOUT / intel). Otherwise rely on probabilistic danger.
    const meForMetrics = { ...p, hand, loot };

    // Per-bot tuning (DISC + optional per-RAID overrides)
    const cfg0 = { ...BOT_UTILITY_CFG, ...(getStrategyCfgForBot(p, g) || {}) };

    // SHIFT anti-spam tuning (with safe fallbacks)
    const roundNum = Number(g.round || 0);
    const shiftDangerTrigger = Number.isFinite(Number(cfg0.shiftDangerTrigger)) ? Number(cfg0.shiftDangerTrigger) : 7.2;
    const shiftLookahead = Number.isFinite(Number(cfg0.shiftLookahead)) ? Number(cfg0.shiftLookahead) : 4;
    const shiftDistancePenalty = Number.isFinite(Number(cfg0.shiftDistancePenalty)) ? Number(cfg0.shiftDistancePenalty) : 0.25;
    const shiftBenefitMin = Number.isFinite(Number(cfg0.shiftBenefitMin)) ? Number(cfg0.shiftBenefitMin) : 1.6;
    const shiftCooldownRounds = Number.isFinite(Number(cfg0.shiftCooldownRounds)) ? Number(cfg0.shiftCooldownRounds) : 1;
    const shiftOverrideBenefit = Number.isFinite(Number(cfg0.shiftOverrideBenefit)) ? Number(cfg0.shiftOverrideBenefit) : 3.0;
    const lastMoveKind = String(p?.lastMoveKind || "").toUpperCase();
    const lastMoveRound = Number.isFinite(Number(p?.lastMoveRound)) ? Number(p.lastMoveRound) : -999;
    const shiftOnCooldown = (lastMoveKind === "SHIFT") && ((roundNum - lastMoveRound) <= shiftCooldownRounds);

    const basePlayers = Array.isArray(latestPlayers) ? latestPlayers : [];
    const mergedPlayers = basePlayers.length
      ? basePlayers.map((x) => (String(x?.id) === String(botId) ? meForMetrics : x))
      : [meForMetrics];

    const isLead = computeIsLeadForPlayer(g, meForMetrics, mergedPlayers);
    const carryExact = computeCarryValue(meForMetrics);
    const carryRecObj = computeCarryValueRec({
      game: g,
      player: meForMetrics,
      players: mergedPlayers,
      mode: "publicSafe",
    });
    const carryValueRec = Number(carryRecObj?.carryValueRec || 0);

    const danger = computeDangerMetrics({
      game: g,
      player: meForMetrics,
      players: mergedPlayers,
      flagsRound: flags,
      intel: {
        denColor: myColor,
        isLead,
        carryValueExact: carryExact,
        carryValueRec,
      },
    });

    const dangerEffective = Number(danger?.dangerEffective || 0);
    const pDanger = Number(danger?.pDanger || 0);
    const confidence = Number(danger?.confidence || 0);

    const nextUsedId = danger?.nextEventIdUsed || null;
    const upcoming = nextUsedId ? classifyEvent(nextUsedId) : { type: "UNKNOWN" };

    // Defense readiness: can we survive a bad obstacle without needing to DASH?
    const hasHardDefense = hasCard(hand, "Den Signal");
    const hasTrackDefense = !flags.lockEvents && hasCard(hand, "Kick Up Dust");

    const defenseReady = immune || hasHardDefense || hasTrackDefense;

    // If we *know* Gate Toll is next and we have no loot -> SNATCH to avoid forced capture.
    const mustHaveLoot =
      upcoming.type === "TOLL" && danger?.intel?.nextKnown === true;

    // Translate (carryValueRec + dangerEffective) into a MOVE choice.
    // Goal: bots aim for high score (keep farming), but invest in survivability + tools so OPS has real options.
    // New: allow SCOUT + SHIFT (aligned with player.js rules as close as possible).

    const track = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
    const eventIdx = Number.isFinite(Number(g.eventIndex)) ? Number(g.eventIndex) : 0;

    // flags.noPeek has 2 meanings in this codebase:
    // - boolean true => global "no-peek mode"
    // - array [pos,...] => No-Go Zone blocked scout positions (1-based)
    const noPeekMode = flags?.noPeek === true;
    const noGoPositions = (Array.isArray(flags?.noPeek) ? flags.noPeek : [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x));

    const canScout = !flags?.scatter && track.length > 0;
    const canShift = !flags?.lockEvents && track.length >= 2 && eventIdx < track.length - 1 && loot.length > 0;

    const dangerHigh = dangerEffective >= 7.0;
    const dangerMid = dangerEffective >= 5.2;
    const uncertain = confidence <= 0.40;
    const cashPressure = carryValueRec >= 8.0;
    const extremePressure = carryValueRec >= 10.5;

    // Stronger: keep a healthy hand early so OPS can actually do something.
    const desiredHandMin = roundNum <= 1 ? 4 : 3;
    const desiredHandMax = 6;

    // ---- SCOUT pick (1-based) ----
    let scoutPos = null;
    if (canScout) {
      const startPos = eventIdx + 1; // next event (1-based)
      const endPos = Math.min(track.length, startPos + 2); // don't scout too far
      for (let pos = startPos; pos <= endPos; pos++) {
        if (noGoPositions.includes(pos)) continue;
        scoutPos = pos;
        break;
      }
    }

    const knownUpcomingEvents = Array.isArray(p?.knownUpcomingEvents)
      ? p.knownUpcomingEvents.filter(Boolean)
      : [];

    const wantScout =
      noPeekMode &&
      canScout &&
      scoutPos != null &&
      knownUpcomingEvents.length < 1; // no intel yet

    // ---- SHIFT pick: swap the next event with a safer one within a small lookahead ----
    let shiftPick = null;
    if (canShift) {
      const nextId = track[eventIdx] ? String(track[eventIdx]) : null;
      if (nextId) {
        const nextFacts = getEventFacts(nextId, { game: g, me: meForMetrics, denColor: myColor, isLead });
        const nextPeak = peakDanger(nextFacts);

        // Only bother shifting if the near-term looks nasty and we don't have defensive tools ready.
        if (nextPeak >= shiftDangerTrigger && !defenseReady) {
          const LOOKAHEAD = shiftLookahead;
          let best = null;

          for (let j = eventIdx + 1; j < Math.min(track.length, eventIdx + 1 + LOOKAHEAD); j++) {
            const candId = track[j] ? String(track[j]) : null;
            if (!candId) continue;

            const f = getEventFacts(candId, { game: g, me: meForMetrics, denColor: myColor, isLead });
            const candPeak = peakDanger(f);

            // Benefit: reduce immediate danger, small penalty for swapping too far.
            const benefit = (nextPeak - candPeak) - shiftDistancePenalty * (j - eventIdx);

            if (!best || benefit > best.benefit) {
              best = { j, candId, candPeak, benefit };
            }
          }

          if (best && best.benefit >= shiftBenefitMin) {
            shiftPick = {
              i1: eventIdx,
              i2: best.j,
              pos1: eventIdx + 1,
              pos2: best.j + 1,
              benefit: best.benefit,
              nextId,
              nextPeak,
              candId: best.candId,
              candPeak: best.candPeak,
            };
          }
        }
      }

    // Anti-SHIFT spam: block repeated SHIFT unless the benefit is huge.
    if (shiftOnCooldown && shiftPick && Number(shiftPick.benefit || 0) < shiftOverrideBenefit) {
      shiftPick = null;
    }
    }

    // ---- FORAGE desire ----
    const avoidSnatch =
      carryValueRec >= 7.5 &&
      (dangerMid || pDanger >= 0.2 || uncertain) &&
      !defenseReady;

    const wantForage =
      !mustHaveLoot &&
      actionDeck.length > 0 &&
      hand.length < desiredHandMax &&
      (
        hand.length < desiredHandMin ||                 // hard minimum hand size
        (dangerHigh && !defenseReady) ||                // danger, no defense
        (dangerMid && cashPressure && !defenseReady) || // pressure + danger
        (extremePressure && (pDanger >= 0.25 || uncertain)) ||
        avoidSnatch
      );

    // Choose MOVE
    let did = null;

    if (mustHaveLoot && lootPts <= 0) {
      // Must have loot to stay viable (Gate Toll etc.)
      did = { kind: "SNATCH", detail: "mustHaveLoot" };
    } else if (wantScout) {
      did = { kind: "SCOUT", detail: `pos ${scoutPos}` };
    } else if (actionDeck.length > 0 && hand.length < desiredHandMin) {
      did = { kind: "FORAGE", detail: `hand<${desiredHandMin}` };
    } else if (shiftPick) {
      did = { kind: "SHIFT", detail: `${shiftPick.pos1}<->${shiftPick.pos2} (Δ≈${shiftPick.benefit.toFixed(1)})` };
    } else if (wantForage) {
      did = { kind: "FORAGE", detail: `rec=${carryValueRec.toFixed(1)} dEff=${dangerEffective.toFixed(1)}` };
    } else {
      did = { kind: "SNATCH", detail: `rec=${carryValueRec.toFixed(1)} dEff=${dangerEffective.toFixed(1)}` };
    }

    // Execute MOVE (mutate local copies used for tx.update)
    if (did.kind === "SNATCH") {
      if (!lootDeck.length) {
        // fallback to forage if possible
        if (!actionDeck.length) return;
        let drawn = 0;
        for (let i = 0; i < 2; i++) {
          if (!actionDeck.length) break;
          hand.push(actionDeck.pop());
          drawn++;
        }
        did = { kind: "FORAGE", detail: `${drawn} kaart(en) (loot op)` };
      } else {
        const card = lootDeck.pop();
        loot.push(card);
        did.detail = `${card?.t || "Loot"} ${card?.v ?? ""} (${did.detail})`;
      }
    } else if (did.kind === "FORAGE") {
      if (!actionDeck.length) {
        // fallback to snatch if possible
        if (!lootDeck.length) return;
        const card = lootDeck.pop();
        loot.push(card);
        did = { kind: "SNATCH", detail: `${card?.t || "Loot"} ${card?.v ?? ""} (action op)` };
      } else {
        let drawn = 0;
        for (let i = 0; i < 2; i++) {
          if (!actionDeck.length) break;
          hand.push(actionDeck.pop());
          drawn++;
        }
        did.detail = `${drawn} kaart(en) (${did.detail})`;
      }
    } else if (did.kind === "SCOUT") {
      const pos = Number(scoutPos);
      const i0 = Number.isFinite(pos) ? pos - 1 : eventIdx;
      const eventId = track[i0] ? String(track[i0]) : null;

      if (!eventId) {
        // nothing to scout -> fallback to forage/snatch
        if (actionDeck.length > 0) {
          let drawn = 0;
          for (let i = 0; i < 2; i++) {
            if (!actionDeck.length) break;
            hand.push(actionDeck.pop());
            drawn++;
          }
          did = { kind: "FORAGE", detail: `${drawn} kaart(en) (scout fail)` };
        } else if (lootDeck.length) {
          const card = lootDeck.pop();
          loot.push(card);
          did = { kind: "SNATCH", detail: `${card?.t || "Loot"} ${card?.v ?? ""} (scout fail)` };
        } else {
          return;
        }
      } else {
        // save intel for noPeek mode + den share
        const nextKnown = [eventId, ...knownUpcomingEvents.filter((x) => String(x) !== eventId)].slice(0, 2);
        // store scoutPeek too (same shape as player) for debugging/UI if needed
        p._scoutUpdate = {
          scoutPeek: { round: Number(g.round || 0), index: i0, eventId },
          knownUpcomingEvents: nextKnown,
        };
        did.detail = `#${pos}=${eventId}`;
      }
    } else if (did.kind === "SHIFT") {
      if (!shiftPick) return;
      // only swap future slots (>= eventIdx) like player.js
      const i1 = shiftPick.i1;
      const i2 = shiftPick.i2;

      if (i1 < eventIdx || i2 < eventIdx) {
        // should not happen, but stay safe
        did = { kind: "FORAGE", detail: "shift invalid" };
        if (actionDeck.length > 0) {
          let drawn = 0;
          for (let i = 0; i < 2; i++) {
            if (!actionDeck.length) break;
            hand.push(actionDeck.pop());
            drawn++;
          }
          did.detail += ` (${drawn} kaart(en))`;
        } else if (lootDeck.length) {
          const card = lootDeck.pop();
          loot.push(card);
          did = { kind: "SNATCH", detail: `${card?.t || "Loot"} ${card?.v ?? ""} (shift invalid)` };
        } else {
          return;
        }
      } else {
        // ✅ SHIFT COST: return highest loot to bottom of loot deck (prevents SHIFT spam)
        if (!loot.length) {
          // should not happen because canShift requires loot, but stay safe
          did = { kind: "FORAGE", detail: "shift cost fail (no loot)" };
          if (actionDeck.length > 0) {
            let drawn = 0;
            for (let i = 0; i < 2; i++) {
              if (!actionDeck.length) break;
              hand.push(actionDeck.pop());
              drawn++;
            }
            did.detail += ` (${drawn} kaart(en))`;
          } else if (lootDeck.length) {
            const card = lootDeck.pop();
            loot.push(card);
            did = { kind: "SNATCH", detail: `${card?.t || "Loot"} ${card?.v ?? ""} (shift cost fail)` };
          } else {
            return;
          }
        } else {
          let hiIdx = 0;
          let hiVal = -1e9;
          for (let k = 0; k < loot.length; k++) {
            const v = Number(loot[k]?.v ?? loot[k]?.value ?? 0);
            if (v > hiVal) {
              hiVal = v;
              hiIdx = k;
            }
          }
          const spent = loot.splice(hiIdx, 1)[0];
          if (spent) lootDeck.unshift(spent); // bottom of deck (since draw uses pop())
          did.detail += ` cost: returned ${spent?.t || "Loot"} ${spent?.v ?? ""}`;
        }

        const tmp = track[i1];
        track[i1] = track[i2];
        track[i2] = tmp;
        // attach for tx.update below
        g._shiftTrack = track;
      }
    }


    // persist player + game changes
    const pUpdate = { hand, loot };
    pUpdate.lastMoveKind = did?.kind || null;
    pUpdate.lastMoveRound = Number(g.round || 0);
    if (p && p._scoutUpdate && typeof p._scoutUpdate === "object") {
      Object.assign(pUpdate, p._scoutUpdate);
    }
    tx.update(pRef, pUpdate);

    const gUpdate = { actionDeck, lootDeck, movedPlayerIds: [...new Set([...moved, botId])] };
    if (g && Array.isArray(g._shiftTrack)) {
      gUpdate.eventTrack = g._shiftTrack;
    }
    tx.update(gRef, gUpdate);

    const botAfter = { ...p, hand, loot };

    logPayload = {
      round: Number(g.round || 0),
      phase: "MOVE",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `MOVE_${did.kind}`,
      message: `BOT deed ${did.kind} (${did.detail})`,
      kind: "BOT_MOVE",
      at: Date.now(),
      metrics: buildBotMetricsForLog({ game: g, bot: botAfter, players: latestPlayers || [], flagsRoundOverride: flags }),
    };
  });

  if (logPayload) await logBotAction({ db, gameId, addLog: null, payload: logPayload });
}

/** ===== smarter OPS ===== */
function chooseBotOpsPlay({ game, bot, players }) {
  const g = game;
  const p = bot;

  const flags = fillFlags(g.flagsRound);

  const myColor = normColor(p.color);
  const immune = !!flags.denImmune?.[myColor];

  const upcoming = classifyEvent(nextEventId(g, 0));
  const hand = Array.isArray(p.hand) ? p.hand : [];

  const roundNum = Number(g.round || 0);

  // If OPS locked: must pass (caller will handle)
  if (flags.opsLocked) return null;

  // -------------------------
  // Conserve rules (hand/deck sparen)
  // -------------------------

  // reserve: early game 2 kaarten houden, later 1
  const reserve = roundNum <= 1 ? 2 : 1;

  // heeft bot deze ronde al een action gespeeld?
  const disc = Array.isArray(g.actionDiscard) ? g.actionDiscard : [];
  const alreadyPlayedThisRound = disc.some(
    (x) => x?.by === p.id && Number(x?.round || 0) === roundNum
  );

  // gevaar waarvoor Den Signal echt relevant is (DOG of DEN van jouw kleur)
  const dangerSoonDogDen =
    upcoming.type === "DOG" ||
    (upcoming.type === "DEN" && normColor(upcoming.color) === myColor);

  const urgentDefense = dangerSoonDogDen && !immune && hasCard(hand, "Den Signal");

  // - als hand te klein is: alleen noodrem spelen
  if (hand.length <= reserve && !urgentDefense) return null;

  // - als bot deze ronde al speelde: alleen noodrem spelen
  if (alreadyPlayedThisRound && !urgentDefense) return null;

  // -------------------------
  // 1) Survival first: Den Signal
  // -------------------------
  if (!immune && hasCard(hand, "Den Signal")) {
    if (upcoming.type === "DOG") return { name: "Den Signal" };
    if (upcoming.type === "DEN" && normColor(upcoming.color) === myColor) return { name: "Den Signal" };
  }

  // -------------------------
  // 2) Danger management: push danger away (track-manip / mask swap)
  // -------------------------
  if (dangerSoonDogDen && !immune) {
  if (!flags.lockEvents && hasCard(hand, "Kick Up Dust")) return { name: "Kick Up Dust" };

  // Pack Tinker alleen als er écht iets bruikbaars in de discard ligt (bv Den Signal)
  if (hasCard(hand, "Pack Tinker") && canBotPackTinkerNow(g, p) && discardPileHasCard(g, "Den Signal")) {
    return { name: "Pack Tinker" };
  }

  if (hasCard(hand, "Mask Swap")) {
    const targetId = pickRichestTarget(players, p.id);
    if (targetId) return { name: "Mask Swap", targetId };
  }
}

  // -------------------------
  // 3) Tactical: Hold Still op rijkste target
  // -------------------------
  if (hasCard(hand, "Hold Still")) {
    const targetId = pickRichestTarget(players, p.id);
    if (targetId) return { name: "Hold Still", targetId };
  }

  // -------------------------
  // 4) Utility: Alpha Call (alleen als deck nog heeft + hand niet huge)
  // -------------------------
  const actionDeckLen = Array.isArray(g.actionDeck) ? g.actionDeck.length : 0;
  if (actionDeckLen > 0 && hasCard(hand, "Alpha Call") && hand.length < 4) {
    return { name: "Alpha Call" };
  }

  // -------------------------
  // 5) End OPS faster: No-Go Zone als veel al gepasst is
  // -------------------------
  const orderLen = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder.length : 0;
  const passes = Number(g.opsConsecutivePasses || 0);
  if (orderLen >= 2 && passes >= Math.floor(orderLen * 0.6) && hasCard(hand, "No-Go Zone")) {
    return { name: "No-Go Zone" };
  }

  // Otherwise: pass
  return null;
}

function pickPackTinkerSwap(game) {
  const track = Array.isArray(game?.eventTrack) ? [...game.eventTrack] : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;
  if (track.length < 2) return null;
  if (idx >= track.length - 1) return null;

  // swap "next up" with a later non-dog if possible
  const nextId = track[idx];
  const nextType = classifyEvent(nextId);
  let j = -1;

  for (let k = track.length - 1; k > idx; k--) {
    const t = classifyEvent(track[k]);
    if (nextType.type === "DOG") {
      if (t.type !== "DOG") {
        j = k;
        break;
      }
    } else {
      j = k;
      break;
    }
  }

  if (j <= idx) return null;
  return [idx, j];
}

function shuffleFutureTrack(game) {
  const track = Array.isArray(game?.eventTrack) ? [...game.eventTrack] : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;
  if (track.length <= 1) return null;
  const locked = track.slice(0, idx);
  const future = track.slice(idx);
  if (future.length <= 1) return null;
  return [...locked, ...shuffleArray(future)];
}

async function botDoOpsTurn({ db, gameId, botId, latestPlayers }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!isActiveRaidStatus(g.status) || g.phase !== "ACTIONS") return;

    const order = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder : [];
    const idx = Number.isFinite(g.opsTurnIndex) ? g.opsTurnIndex : 0;
    if (!order.length || order[idx] !== botId) return;

    const roundNum = Number(g.round || 0);

    const flagsRound = fillFlags(g.flagsRound);

    // ✅ HARD STOP: als OPS al klaar is → niets meer doen (voorkomt eindeloos PASS ophogen)
    const target = Number(g.opsActiveCount || order.length);
    const passesNow = Number(g.opsConsecutivePasses || 0);
    if (flagsRound.opsLocked || passesNow >= target) return;

    // ⏳ UI pacing: wacht tot de vorige gespeelde kaart minimaal zichtbaar was
    const holdUntil = Number(g.opsHoldUntilMs || 0);
    if (holdUntil && Date.now() < holdUntil) return;

    const nextIdx = (idx + 1) % order.length;

    const hand = Array.isArray(p.hand) ? [...p.hand] : [];
    const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const actionDiscard = Array.isArray(g.actionDiscard) ? [...g.actionDiscard] : [];
    const actionDiscardPile = Array.isArray(g.actionDiscardPile) ? [...g.actionDiscardPile] : [];

    // ✅ Max 1 Action Card per speler per ronde (zonder extra writes)
const discNow = Array.isArray(g.actionDiscard) ? g.actionDiscard : [];
const alreadyPlayedThisRound = discNow.some(
  (x) => String(x?.by || "") === String(botId) && Number(x?.round || 0) === roundNum
);

let passReason = null;

const play = alreadyPlayedThisRound
  ? (passReason = "ALREADY_PLAYED_THIS_ROUND", null)
  : await pickBestActionFromHand({ db, gameId, game: g, bot: p, players: latestPlayers || [] });

// als strategy PASS zegt (pickBestActionFromHand → null)
if (!alreadyPlayedThisRound && !play) passReason = "LOW_VALUE_OR_HOLD_FOR_COMBO";

    // =========================
    // PASS
    // =========================
    if (!play) {
      let nextPasses = passesNow + 1;
      if (nextPasses > target) nextPasses = target;

      const ended = nextPasses >= target;

      tx.update(gRef, {
        opsTurnIndex: nextIdx,
        opsConsecutivePasses: nextPasses,
        ...(ended
          ? {
              flagsRound: { ...(g.flagsRound || {}), opsLocked: true }, // ✅ hard stop
              opsEndedAtMs: Date.now(),
            }
          : {}),
      });

      const botAfter = { ...p, hand };

      logPayload = {
        round: roundNum,
        phase: "ACTIONS",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "ACTION_PASS",
        message: "BOT kiest PASS",
        kind: "BOT_OPS",
        at: Date.now(),
        metrics: buildBotMetricsForLog({ game: g, bot: botAfter, players: latestPlayers || [], flagsRoundOverride: flagsRound }),
      };
      return;
    }

let cardName = String(play?.name || "").trim();
let removed = removeOneCard(hand, cardName);

// Fallback: als play.name een ACTION_ID is, map dan terug naar echte kaartnaam uit de hand
if (!removed) {
  const wantedId = String(play?.actionId || play?.id || "").trim();
  if (wantedId) {
    const match = hand.find((c) => {
      const nm = String(c?.name || c || "").trim();
      const def = nm ? getActionDefByName(nm) : null;
      return String(def?.id || "") === wantedId;
    });

    if (match) {
      cardName = String(match?.name || match || "").trim();
      removed = removeOneCard(hand, cardName);
    }
  }
}

if (!removed) {
  // fallback to PASS if card missing
  let nextPasses = passesNow + 1;
  if (nextPasses > target) nextPasses = target;

  const ended = nextPasses >= target;

  tx.update(gRef, {
    opsTurnIndex: nextIdx,
    opsConsecutivePasses: nextPasses,
    ...(ended
      ? {
          flagsRound: { ...(g.flagsRound || {}), opsLocked: true },
          opsEndedAtMs: Date.now(),
        }
      : {}),
  });

  const botAfter = { ...p, hand };

  logPayload = {
    round: roundNum,
    phase: "ACTIONS",
    playerId: botId,
    playerName: p.name || "BOT",
    choice: "ACTION_PASS",
    message: `BOT wilde spelen maar kaart niet gevonden → PASS (name="${String(play?.name||"")}", id="${String(play?.actionId||"")}")`,
    kind: "BOT_OPS",
    at: Date.now(),
    metrics: buildBotMetricsForLog({ game: g, bot: botAfter, players: latestPlayers || [], flagsRoundOverride: flagsRound }),
  };
  return;
}
    
    // ✅ canonical name alleen voor effects (safe: discard/log blijft cardName)     
    const effName = getActionDefByName(cardName)?.name || cardName;

    // discard (face-up): kaart gaat direct op de Discard Pile
const nowMs = Date.now();
const playedUid = `${nowMs}_${Math.random().toString(16).slice(2)}`;

actionDiscard.push({ name: cardName, by: botId, round: roundNum, at: nowMs });
if (actionDiscard.length > 30) actionDiscard.splice(0, actionDiscard.length - 30);

// ✅ echte aflegstapel met uid (voor Pack Tinker)
actionDiscardPile.push({ uid: playedUid, name: cardName, by: botId, round: roundNum, at: nowMs });
if (actionDiscardPile.length > 80) actionDiscardPile.splice(0, actionDiscardPile.length - 80);

const playedId = String(play?.actionId || "");
const dIds = Array.isArray(g?.discardThisRoundActionIds) ? [...g.discardThisRoundActionIds] : [];
if (playedId && !dIds.includes(playedId)) dIds.push(playedId);
if (dIds.length > 30) dIds.splice(0, dIds.length - 30);

const extraGameUpdates = {
  lastActionPlayed: { name: cardName, by: botId, round: Number(g.round || 0), at: nowMs },
  opsHoldUntilMs: nowMs + 650,
  discardThisRoundActionIds: dIds,
};

    // effects
    if (effName === "Den Signal") {
      const myColor = normColor(p.color);
      const denImmune = { ...(flagsRound.denImmune || {}) };
      if (myColor) denImmune[myColor] = true;
      flagsRound.denImmune = denImmune;
    }

    if (effName === "No-Go Zone") {
      flagsRound.opsLocked = true;
      extraGameUpdates.opsConsecutivePasses = target; // ✅ einde OPS (past bij PhaseGate)
      extraGameUpdates.opsEndedAtMs = Date.now();
    }

    if (effName === "Hold Still") {
      const targetId = play.targetId;
      if (targetId) {
        const hs = { ...(flagsRound.holdStill || {}) };
        hs[targetId] = true;
        flagsRound.holdStill = hs;
        extraGameUpdates.lastHoldStill = { by: botId, targetId, round: roundNum, at: Date.now() };
      }
    }

    if (effName === "Kick Up Dust") {
      if (!flagsRound.lockEvents) {
        const newTrack = shuffleFutureTrack(g);
        if (newTrack) extraGameUpdates.eventTrack = newTrack;
      }
    }

    if (effName === "Pack Tinker") {
  // ✅ Nieuwe regels: wissel 1 kaart uit hand met 1 kaart uit actionDiscardPile
  const pileCandidates = actionDiscardPile
    .filter((x) => x && typeof x === "object" && x.uid && x.name && x.uid !== playedUid);

  // je moet een andere kaart hebben dan Pack Tinker (die is al verwijderd)
  const handNamesNow = hand.map((c) => String(c?.name || c || "").trim()).filter(Boolean);

  if (pileCandidates.length && handNamesNow.length) {
    const WANT = [
      "Den Signal",
      "Hold Still",
      "No-Go Zone",
      "Mask Swap",
      "Scatter!",
      "Molting Mask",
      "Kick Up Dust",
      "Alpha Call",
      "Pack Tinker",
      "Nose for Trouble",
      "Scent Check",
      "Follow the Tail",
      "Burrow Beacon",
    ];

    const score = (nm) => {
      const n = String(nm || "").trim();
      if (flagsRound.lockEvents && n === "Kick Up Dust") return 999; // onbruikbaar nu
      const i = WANT.indexOf(n);
      return i >= 0 ? i : 500;
    };

    // neem beste uit pile
    pileCandidates.sort((a, b) => score(a.name) - score(b.name));
    const takeItem = pileCandidates[0];
    const takeUid = takeItem.uid;
    const takeName = String(takeItem.name).trim();

    // geef slechtste uit hand
    const giveName = handNamesNow.slice().sort((a, b) => score(b) - score(a))[0];

    const giveIdx = hand.findIndex((c) => String(c?.name || c || "").trim() === giveName);
    const takeIdx = actionDiscardPile.findIndex((x) => x && x.uid === takeUid);

    if (giveIdx >= 0 && takeIdx >= 0 && takeName) {
      hand[giveIdx] = { name: takeName };
      actionDiscardPile[takeIdx] = {
        ...actionDiscardPile[takeIdx],
        name: giveName,
        by: botId,
        round: roundNum,
        at: nowMs,
      };

      extraGameUpdates.lastPackTinker = { by: botId, giveName, takeName, takeUid, round: roundNum, at: nowMs };
    }
  }
}

    // Alpha Call: effect is only lead change (no draw in OPS)

    if (cardName === "Burrow Beacon") {
      flagsRound.lockEvents = true;
    }

    if (cardName === "Scatter!") {
      flagsRound.scatter = true;
      extraGameUpdates.scatterArmed = true;
    }

    if (cardName === "Scent Check") {
      const arr = Array.isArray(flagsRound.scentChecks) ? [...flagsRound.scentChecks] : [];
      if (!arr.includes(botId)) arr.push(botId);
      flagsRound.scentChecks = arr;
    }

    if (cardName === "No-Go Zone") {
      // No-Go Zone: hide the next event info for everyone this round
      flagsRound.noPeek = true;
    }

    if (cardName === "Follow the Tail") {
      const targetId = pickRichestTarget(latestPlayers || [], botId);
      if (targetId) {
        const ft = { ...(flagsRound.followTail || {}) };
        ft[botId] = targetId;
        flagsRound.followTail = ft;
      }
    }

    if (cardName === "Molting Mask") {
      // Molting Mask: change my den color randomly (strategic reset). This does NOT affect noPeek.
      const COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];
      const cur = normColor(p.color);
      const pool = COLORS.filter((c) => c && c !== cur);
      const pickFrom = pool.length ? pool : COLORS;
      const next = pickFrom[Math.floor(Math.random() * pickFrom.length)] || cur;
      if (next && next !== cur) {
        // keep ephemeral debug for message/log only (NOT written to Firestore)
        p.__moltingFrom = cur;
        p.__moltingTo = next;
        p.color = next;
        p.den = next;
      }
    }

    if (cardName === "Nose for Trouble") {
      const eventId = nextEventId(g, 0) || nextEventId(g, 1);
      if (eventId) {
        const preds = Array.isArray(flagsRound.predictions) ? [...flagsRound.predictions] : [];
        const filtered = preds.filter((x) => x?.playerId !== botId);
        filtered.push({ playerId: botId, eventId, round: roundNum, at: Date.now() });
        flagsRound.predictions = filtered;
      }
    }

    if (cardName === "Mask Swap") {
      const targetId = play.targetId;
      if (targetId) {
        const tRef = doc(db, "games", gameId, "players", targetId);
        const tSnap = await tx.get(tRef);
        if (tSnap.exists()) {
          const t = { id: tSnap.id, ...tSnap.data() };
          const a = normColor(p.color);
          const b = normColor(t.color);
          if (a && b && a !== b) {
            tx.update(tRef, { color: a, den: a });
            p.color = b;
            extraGameUpdates.lastMaskSwap = { by: botId, targetId, a, b, round: roundNum, at: Date.now() };
          }
        }
      }
    }

    // commit
    tx.update(pRef, { hand, color: p.color, den: p.color });
    tx.update(gRef, {
  actionDeck,
  actionDiscard,
  actionDiscardPile,
  flagsRound,
  opsTurnIndex: nextIdx,
  opsConsecutivePasses: 0,
  ...extraGameUpdates,
});

    let msg = `BOT speelt Action Card: ${cardName}`;
    if (cardName === "Pack Tinker" && extraGameUpdates.lastPackTinker) {
  msg = `BOT speelt Pack Tinker (swap "${extraGameUpdates.lastPackTinker.giveName}" ↔ "${extraGameUpdates.lastPackTinker.takeName}")`;
}

    if (cardName === "Kick Up Dust") {
      msg = flagsRound.lockEvents
        ? "BOT speelt Kick Up Dust (geen effect: Burrow Beacon actief)"
        : "BOT speelt Kick Up Dust (future events geschud)";
    }
    if (cardName === "Den Signal") {
      msg = `BOT speelt Den Signal (DEN ${normColor(p.color) || "?"} immune)`;
    }
    if (cardName === "Molting Mask") {
      const from = p.__moltingFrom;
      const to = p.__moltingTo;
      if (from && to) msg = `BOT speelt Molting Mask (${from} → ${to})`;
      else msg = "BOT speelt Molting Mask (den kleur gewijzigd)";
    }
    if (cardName === "No-Go Zone") {
      msg = "BOT speelt No-Go Zone (noPeek actief: event info verborgen deze ronde)";
    }

    const gAfter = {
      ...g,
      ...extraGameUpdates,
      actionDiscard,
      flagsRound,
      // reflect any track mutation for metrics
      ...(extraGameUpdates?.eventTrack ? { eventTrack: extraGameUpdates.eventTrack } : {}),
      opsTurnIndex: nextIdx,
      opsConsecutivePasses: 0,
    };

    const botAfter = { ...p, hand, color: p.color, den: p.color };

    logPayload = {
      round: roundNum,
      phase: "ACTIONS",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `ACTION_${cardName}`,
      message: msg,
      kind: "BOT_OPS",
      at: Date.now(),
      metrics: buildBotMetricsForLog({ game: gAfter, bot: botAfter, players: latestPlayers || [], flagsRoundOverride: flagsRound }),
    };
  });

  if (logPayload) await logBotAction({ db, gameId, addLog: null, payload: logPayload });
}

async function fetchPlayersOutsideTx(db, gameId, latestPlayers = []) {
  const ids = (latestPlayers || []).map((x) => x?.id).filter(Boolean);

  // fallback: als er geen ids zijn, gebruik latestPlayers zelf
  if (!ids.length) return Array.isArray(latestPlayers) ? latestPlayers : [];

  const snaps = await Promise.all(
    ids.map((id) => getDoc(doc(db, "games", gameId, "players", id)))
  );

  return snaps
    .filter((s) => s.exists())
    .map((s) => ({ id: s.id, ...s.data() }));
}

/** ===== smarter DECISION ===== */
async function botDoDecision({ db, gameId, botId, latestPlayers = [] }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

 let logPayload = null;

// ✅ lees players OUTSIDE de transaction (voorkomt failed-precondition)
const freshPlayersOuter = await fetchPlayersOutsideTx(db, gameId, latestPlayers);

await runTransaction(db, async (tx) => {

    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!canBotDecide(g, p)) return;

    // ✅ gebruik de outside snapshot, maar update "me" naar de tx-versie
const base = Array.isArray(freshPlayersOuter) && freshPlayersOuter.length
  ? freshPlayersOuter
  : (Array.isArray(latestPlayers) ? latestPlayers : []);

const playersForDecision = base.length
  ? base.map((x) => (String(x?.id) === String(botId) ? { ...x, ...p } : x))
  : [{ ...p }];

    const flags = fillFlags(g?.flagsRound);
    const noPeek = flags?.noPeek === true;

    const denColor = normColor(p?.color || p?.den || p?.denColor);
    const presetKey = presetFromDenColor(denColor);
    const dashDecisionsSoFar = countDashDecisions(playersForDecision);
    const isLead = computeIsLeadForPlayer(g, p, playersForDecision);

// ✅ CANON: alleen burrowUsedThisRaid (1 bron van waarheid)
const burrowUsedThisRaid = (p?.burrowUsedThisRaid === true);
const burrowUsed = burrowUsedThisRaid; // alias voor bestaande code

// ✅ strategy + heuristics verwachten me.burrowUsed (alias); ook burrowUsedThisRaid consistent maken
const meForDecision = {
  ...p,
  burrowUsed,
  burrowUsedThisRaid,
};

// ✅ metrics altijd berekenen (voor logs + fallback)
const metricsNow = buildBotMetricsForLog({
  game: g,
  bot: meForDecision,
  players: playersForDecision || [],
  flagsRoundOverride: flags,
});

// ---- HYBRID DECISION ----
let decision = "LURK";
let rec = null;
let dec = null;

// simpele intel-check (optioneel): als bot knownUpcomingEvents heeft, strategy mag ook in noPeek
const known = Array.isArray(meForDecision?.knownUpcomingEvents)
  ? meForDecision.knownUpcomingEvents.filter(Boolean)
  : [];
const hasKnown = known.length > 0;

const useStrategy = !noPeek || hasKnown;

// ✅ noPeek + eigen intel: geef strategy expliciet de knownUpcomingEvents mee
const peekIntel = (noPeek && hasKnown)
  ? { events: known.map((x) => String(x)) }
  : null;

if (useStrategy) {
  dec = evaluateDecision({
    game: g,
    me: meForDecision,
    players: playersForDecision || [],
    flagsRound: flags,
    cfg: getStrategyCfgForBot(meForDecision, g),
    peekIntel,
  });

  decision = dec?.decision || "LURK";
} else {
  rec = recommendDecision({
    presetKey,
    denColor,
    game: g,
    me: meForDecision,
    ctx: {
      round: Number(g.round || 0),
      isLead,
      dashDecisionsSoFar,

      roosterSeen: Number.isFinite(Number(g?.roosterSeen))
        ? Number(g.roosterSeen)
        : countRevealedRoosters(g),
      postRooster2Window: countRevealedRoosters(g) >= 2,

      carryValue: 0,
      carryValueRec: 0,

      dangerVec: metricsNow?.dangerVec,
      dangerPeak: metricsNow?.dangerPeak,
      dangerStay: metricsNow?.dangerStay,
      dangerEffective: metricsNow?.dangerEffective,
      nextEventIdUsed: metricsNow?.nextEventIdUsed,
      pDanger: metricsNow?.pDanger,
      confidence: metricsNow?.confidence,

      flagsRound: g?.flagsRound || null,
    },
  });

  decision = rec?.decision || "LURK";
}

// Next event id only when allowed (noPeek=false OR bot has known intel)
const nextEvent0 = (!noPeek)
  ? nextEventId(g, 0)
  : (hasKnown ? String(known[0] || "") : null);

// (optioneel) debug vlag als bot BURROW wil maar al gebruikt is
const burrowAttemptWhileUsed = (decision === "BURROW") && burrowUsedThisRaid;

// Alleen als bot op LURK uitkomt: check of LURK (stay) veilig is op basis van nextEvent.
// Onbekend => liever DASH dan dood.
if (decision === "LURK") {
  let dStay = Number.NaN;

  if (nextEvent0) {
    try {
      const f = getEventFacts(String(nextEvent0 || ""), {
        game: g,
        me: meForDecision,
        denColor,
        isLead,
        flagsRound: flags,
      });
      const dl = Number(f?.dangerLurk);
      if (Number.isFinite(dl)) dStay = dl;
    } catch (e) {}
  }

  if (!Number.isFinite(dStay)) dStay = 10;
  if (dStay > 3.0) decision = "DASH";
}

  // ===== HARD RULE: eigen DEN_* (zonder Den Signal) => LURK is lethal (caught)
// Alleen veilig: DASH of BURROW. Als BURROW al op is -> force DASH.
// (En als bot al DASH kiest voor carry/Hidden Nest, laten we dat staan.)
try {
  const ne = String(nextEvent0 || "");
  if (ne.startsWith("DEN_")) {
    const evDen = ne.slice(4).toUpperCase();
    const myDen = String(denColor || "").toUpperCase();

    const denImmune = (flags && typeof flags === "object" ? flags.denImmune : null) || null;
    const immuneToDen = !!(denImmune && evDen && (denImmune[evDen] || denImmune[String(evDen).toLowerCase()]));

    if (myDen && evDen && myDen === evDen && !immuneToDen) {
      if (decision !== "DASH") decision = burrowUsed ? "DASH" : "BURROW";
    }
  }
} catch (e) {}

  // ===== HARD RULE: DOG_CHARGE / SECOND_CHARGE / MAGPIE_SNITCH => LURK is lethal
try {
  const ne = String(nextEvent0 || "");

  // Den Signal immunity (zelfde stijl als DEN_* rule)
  const denImmune = (flags && typeof flags === "object" ? flags.denImmune : null) || null;
  const myDen = String(denColor || "").toUpperCase();
  const immuneToMyDen = !!(denImmune && myDen && (denImmune[myDen] || denImmune[String(myDen).toLowerCase()]));

  // DOG charges: alleen veilig = DASH of (1x) BURROW
  if ((ne === "DOG_CHARGE" || ne === "SECOND_CHARGE") && !immuneToMyDen) {
    if (decision !== "DASH") decision = burrowUsed ? "DASH" : "BURROW";
  }

  // Magpie Snitch: alleen relevant voor Lead (hier is Den Signal niet van toepassing)
  if (ne === "MAGPIE_SNITCH" && isLead) {
    if (decision !== "DASH") decision = burrowUsed ? "DASH" : "BURROW";
  }
} catch (e) {}

// ✅ Anti-herding coordination for congestion events (HIDDEN_NEST): limit DASH slots
    if (String(nextEvent0) === "HIDDEN_NEST" && decision === "DASH") {
      const picked = pickHiddenNestDashSet({ game: g, gameId, players: playersForDecision || [] });
      const dashSet = picked?.dashSet || null;

      if (dashSet && !dashSet.has(p.id)) {
      // CANON (jouw regel): Hidden Nest / winst-DASH mag nooit BURROW triggeren.
        decision = "LURK";
      }

    }

    const dashPushNext = Number.isFinite(Number(dec?.meta?.dashPushNext))
      ? Number(dec.meta.dashPushNext)
      : (Number.isFinite(Number(p?.dashPush)) ? Number(p.dashPush) : 0);

  const update = {
  decision,
  ...(Number.isFinite(Number(dashPushNext)) ? { dashPush: dashPushNext } : {}),
  // 👇 NIET hier zetten. Engine consume't BURROW bij REVEAL.
};

    tx.update(pRef, update);

    const botAfter = { ...meForDecision, ...update };

    logPayload = {
      round: Number(g.round || 0),
      phase: "DECISION",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `DECISION_${decision}`,
      message: `BOT kiest ${decision}`,
      kind: "BOT_DECISION",
      at: Date.now(),
      metrics: buildBotMetricsForLog({ game: g, bot: botAfter, players: playersForDecision || [], flagsRoundOverride: flags }),
    };
  });

  if (logPayload) {
    await logBotAction({ db, gameId, addLog: null, payload: logPayload });
  }
}

/** ===== exported: start runner (1 action per tick + backoff, no interval storm) ===== */
export function startBotRunner({ db, gameId, addLog, isBoardOnly = false, hostUid = null }) {
  if (!db || !gameId) return () => {};
  if (isBoardOnly) return () => {}; // board screens must NOT drive bots

  const runnerKey = hostUid || getRunnerId();

  const gameRef = doc(db, "games", gameId);
  const playersCol = collection(db, "games", gameId, "players");

  // Safe defaults (no ReferenceError if constants not defined elsewhere)
  const DEBOUNCE_MS = typeof BOT_DEBOUNCE_MS === "number" ? BOT_DEBOUNCE_MS : 200;
  const MIN_ACTION_MS = 1500; // critical: slows writes, prevents quota/hot-doc
  const IDLE_MS = 2500; // when nothing to do
  const MAX_BACKOFF_MS = 8000;

  let latestGame = null;
  let latestPlayers = [];

  let unsubGame = null;
  let unsubPlayers = null;

  let stopped = false;
  let busy = false;

  let timer = null;
  let scheduled = false;

  let backoffMs = 0;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function plan(ms) {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(loop, ms);
  }

  function nudge() {
    // debounce snapshot storms
    if (stopped) return;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      // push loop soon, but don't spam
      if (!timer) plan(0);
    }, DEBOUNCE_MS);
  }

  function pickOneJob(g, bots) {
    if (!g || !bots?.length) return null;

    if (g.phase === "MOVE") {
      const b = bots.find((x) => canBotMove(g, x));
      return b ? { kind: "MOVE", botId: b.id } : null;
    }

    if (g.phase === "ACTIONS") {
      const order = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder : [];
      const target = Number(g.opsActiveCount || order.length);
      const passesNow = Number(g.opsConsecutivePasses || 0);
      const opsLocked = !!g.flagsRound?.opsLocked;

      // ✅ als OPS klaar is, geen jobs meer plannen
      if (opsLocked || (target > 0 && passesNow >= target)) return null;

      const turnId = getOpsTurnId(g);
      if (!turnId) return null;
      const b = bots.find((x) => x.id === turnId);
      return b ? { kind: "ACTIONS", botId: b.id } : null;
    }

    if (g.phase === "DECISION") {
      const b = bots.find((x) => canBotDecide(g, x));
      return b ? { kind: "DECISION", botId: b.id } : null;
    }

    return null;
  }

  async function loop() {
    if (stopped) return;
    if (busy) return plan(400);

    const g = latestGame;

    // Guardrails
    if (!g || g.botsEnabled !== true) return plan(IDLE_MS);
    if (isGameFinished(g)) return plan(IDLE_MS);
    if (!isActiveRaidStatus(g.status)) return plan(IDLE_MS);
    if (g.raidEndedByRooster) return plan(IDLE_MS);

    const bots = (latestPlayers || []).filter((p) => p?.isBot);
    const job = pickOneJob(g, bots);
    if (!job) return plan(IDLE_MS);

    busy = true;
    try {
      const gotLock = await acquireBotLock({ db, gameId, gameRef, runnerKey });
      if (!gotLock) {
        // backoff on contention
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : 1000);
        return plan(backoffMs);
      }

      backoffMs = 0;

      // Execute EXACTLY ONE action per loop (huge quota win)
      if (job.kind === "MOVE") {
        await botDoMove({ db, gameId, botId: job.botId, latestPlayers });
      } else if (job.kind === "ACTIONS") {
        await botDoOpsTurn({ db, gameId, botId: job.botId, latestPlayers });
      } else if (job.kind === "DECISION") {
        await botDoDecision({ db, gameId, botId: job.botId, latestPlayers });
      }
    } catch (e) {
      console.warn("[BOTS] loop error", e);
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : 1000);
      return plan(backoffMs);
    } finally {
      busy = false;
    }

    // schedule next allowed action
    plan(MIN_ACTION_MS);
  }

  // --- snapshots ---
  unsubGame = onSnapshot(gameRef, (snap) => {
    latestGame = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    nudge();
  });

  unsubPlayers = onSnapshot(playersCol, (snap) => {
    latestPlayers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    nudge();
  });

  // kickstart
  plan(500);

  return function stop() {
    stopped = true;
    clearTimer();
    if (typeof unsubGame === "function") unsubGame();
    if (typeof unsubPlayers === "function") unsubPlayers();
    unsubGame = null;
    unsubPlayers = null;
    latestGame = null;
    latestPlayers = [];
  };
}

/** ===== exported: add bot ===== */
export async function addBotToCurrentGame({ db, gameId, denColors = ["RED", "BLUE", "GREEN", "YELLOW"] }) {
  if (!db || !gameId) throw new Error("Missing db/gameId");

  const gRef = doc(db, "games", gameId);
  const playersRef = collection(db, "games", gameId, "players");

  const gSnap = await getDoc(gRef);
  if (!gSnap.exists()) throw new Error("Game not found");
  const g = gSnap.data();

  const pSnap = await getDocs(playersRef);
  const players = pSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const maxJoin = players.reduce(
    (m, p) => (Number.isFinite(p?.joinOrder) ? Math.max(m, p.joinOrder) : m),
    -1
  );
  const joinOrder = maxJoin + 1;
  const color = denColors[joinOrder % denColors.length];

  // ✅ random bot name from pool (prefer unused), fallback to old pattern
  const used = new Set((players || []).map((p) => String(p?.name || "").trim().toLowerCase()).filter(Boolean));
  const available = BOT_NAME_POOL.filter((n) => !used.has(String(n).toLowerCase()));
  const namePool = available.length ? available : BOT_NAME_POOL;
  const pickedName = namePool[Math.floor(Math.random() * namePool.length)] || `BOT Fox ${joinOrder + 1}`;

  let actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
  const hand = [];
  for (let i = 0; i < 3; i++) if (actionDeck.length) hand.push(actionDeck.pop());

  await addDoc(playersRef, {
    name: pickedName,
    isBot: true,
    isHost: false,
    uid: null,
    score: 0,
    joinedAt: serverTimestamp(),
    joinOrder,
    color,
    den: color,
    inYard: true,
    dashed: false,
    burrowUsedThisRaid: false,
    decision: null,
    hand,
    loot: [],
  });

  await updateDoc(gRef, { botsEnabled: true, actionDeck });
}
