// js/bots/botRunner.js
// Autonomous bots for VOSSENJACHT (smart OPS flow + threat-aware decisions)

import { getEventFacts } from "./aiKit.js";
import { getActionDefByName } from "../cards.js";
import { comboScore } from "./actionComboMatrix.js";
import { computeCarryValue, computeDangerMetrics } from "./core/metrics.js";
import {
  rankActions,
  scoreActionFacts,
  presetFromDenColor,
  BOT_PRESETS,
  pickActionOrPass, // ✅ toevoegen
  recommendDecision,
} from "./botHeuristics.js";

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

function synthFactsFromMetrics(metrics) {
  const v = metrics?.dangerVec;
  if (!v) return null;

  const dash = Number(v.dash ?? 0);
  const lurk = Number(v.lurk ?? 0);
  const burrow = Number(v.burrow ?? 0);

  return {
    id: String(metrics?.nextEventIdUsed || "PROB_NEXT"),
    category: "PROB",
    dangerDash: dash,
    dangerLurk: lurk,
    dangerBurrow: burrow,
    tags: [],
    dangerNotes: [
      `synthetic facts from dangerVec (conf=${Number(metrics?.confidence ?? 0)})`,
    ],
    lootImpact: { appliesTo: "ALL" },
  };
}

/** ===== small helpers ===== */
function normColor(c) {
  return String(c || "").trim().toUpperCase();
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
  return loot.reduce((s, c) => {
    const raw = c?.v ?? c?.value ?? c?.points ?? c?.pts ?? 0;
    const n = Number(raw);
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
}

function computeIsLeadForPlayer(game, me, players) {
  const leadId = String(game?.leadFoxId || "");
  if (leadId && leadId === String(me?.id || "")) return true;

  const leadName = String(game?.leadFox || "");
  if (leadName && leadName === String(me?.name || "")) return true;

  const idx = Number.isFinite(Number(game?.leadIndex)) ? Number(game.leadIndex) : null;
  if (idx === null) return false;

  const ordered = Array.isArray(players) ? [...players].sort((a, b) => (a?.joinOrder ?? 9999) - (b?.joinOrder ?? 9999)) : [];
  return ordered[idx]?.id === me?.id;
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
  const names = arr
    .map((c) => String(c?.name || c || "").trim())
    .filter(Boolean);

  // map "Den Signal" -> {id:"DEN_SIGNAL", ...}
  const ids = [];
  for (const nm of names) {
    const def = getActionDefByName(nm);
    if (def?.id) ids.push(def.id);
  }
  return ids;
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
  const isLead = String(game?.leadFoxId || game?.leadFox || "") === String(bot?.id || "");
  const nextFacts = nextId ? getEventFacts(nextId, { game, me: bot, denColor, isLead }) : null;
  const dangerNext = peakDanger(nextFacts);

  // --- rooster timing ---
  const revealedRoosters = countRevealedRoosters(game);

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

function pickDecisionLootMaximizer({ g, p, latestPlayers, gameId }) {
  const myColor = String(p?.color || "").trim().toUpperCase();
  const flags = fillFlags(g?.flagsRound);
  const immune = !!flags.denImmune?.[myColor];

  const nextEvent0 = nextEventId(g, 0);
  const lootPts = sumLootPoints(p);

  
  // Rooster pressure: after 2 roosters the next one can end the raid.
  // If you already have loot, prefer to bail out (DASH) instead of risking getting caught.
  const roosterSeen = Number.isFinite(Number(g?.roosterSeen)) ? Number(g.roosterSeen) : 0;
const isLead = (() => {
    const ordered = [...(latestPlayers || [])].sort(
      (a, b) => (a.joinOrder ?? 9999) - (b.joinOrder ?? 9999)
    );
    const idx = Number.isFinite(g?.leadIndex) ? g.leadIndex : 0;
    return ordered[idx]?.id === p.id;
  })();

  const avgLoot = avgLootValueFromDeck(g?.lootDeck);
  const roundsLeft = estimateRoundsLeft(g);
  const futureGain = roundsLeft * avgLoot;

  const sackShareIfDash = expectedSackShareNow({ game: g, players: latestPlayers || [] });
  const caughtLoss = lootPts;

  let options = ["LURK", "DASH", "BURROW"].filter((d) => d !== "BURROW" || !p.burrowUsed);

  // Anti-herding coordination for congestion events
  if (String(nextEvent0) === "HIDDEN_NEST") {
    const picked = pickHiddenNestDashSet({ game: g, gameId, players: latestPlayers || [] });
    const dashSet = picked?.dashSet || null;

    // If you are not selected for one of the limited DASH slots, remove DASH from options.
    if (dashSet && !dashSet.has(p.id)) {
      options = options.filter((d) => d !== "DASH");
    }
  }

  const scored = options.map((decision) => {
    const surviveP = survivalProbNextEvent({
      eventId: nextEvent0,
      decision,
      myColor,
      immune,
      isLead,
      lootPts,
    });

    const alarmPenalty = silentAlarmPenalty({ eventId: nextEvent0, decision, isLead, lootPts });

    const dashOpportunityCost = decision === "DASH" ? futureGain * 0.95 : 0;

    const roundNum = Number(g?.round || 0);
    const burrowReservePenalty = decision === "BURROW" ? (roundNum <= 1 ? 1.2 : 0.6) : 0;

    const baseNow = lootPts;

    let ev = 0;

    if (decision === "DASH") {
      ev = baseNow + sackShareIfDash - dashOpportunityCost;
    } else {
      ev =
        baseNow +
        surviveP * futureGain -
        (1 - surviveP) * caughtLoss -
        alarmPenalty -
        burrowReservePenalty;
    }

    // -------------------------
    // HIDDEN_NEST exploit: bonus loot bij weinig dashers (later in track = interessanter)
    // -------------------------
    if (String(nextEvent0) === "HIDDEN_NEST") {
      // hoeveel spelers hebben al DASH gekozen deze DECISION-fase?
      const alreadyDash = (latestPlayers || []).filter((x) => isInYard(x) && x?.decision === "DASH").length;

      const totalDashers = alreadyDash + (decision === "DASH" ? 1 : 0);

      // bonus kaarten per speler op basis van totaal dashers
      let bonusCards = 0;
      if (decision === "DASH") {
        if (totalDashers <= 1) bonusCards = 3;
        else if (totalDashers === 2) bonusCards = 2;
        else if (totalDashers === 3) bonusCards = 1;
        else bonusCards = 0; // 4+ => niets
      }

      // later in track => bonus waardevoller
      const track = Array.isArray(g?.eventTrack) ? g.eventTrack : [];
      const idx = Number.isFinite(g?.eventIndex) ? g.eventIndex : 0;
      const denom = Math.max(1, track.length - 1);
      const prog = Math.max(0, Math.min(1, idx / denom));     // 0..1
      const lateBoost = 0.75 + prog * 0.75;                   // 0.75..1.5

      // bonus in punten ≈ bonusCards * avgLootValue
      ev += bonusCards * avgLoot * lateBoost;

      // anti-crowding: 4e dasher is meestal dom -> harde straf
      if (decision === "DASH" && totalDashers >= 4) ev -= 6;
    }

    // extra: dash met 0 loot is normaal onaantrekkelijk,
    // maar bij HIDDEN_NEST kan dash juist loot opleveren → geen straf daar
    if (String(nextEvent0) !== "HIDDEN_NEST" && lootPts <= 0 && decision === "DASH") ev -= 5;

    // Rooster risk bias (late raid)
    if (roosterSeen >= 2 && lootPts > 0) {
      if (decision === "DASH") ev += 6;
      else ev -= 8;
    } else if (roosterSeen === 1 && lootPts >= 3) {
      if (decision === "DASH") ev += 2;
      else ev -= 3;
    }


    return { decision, ev, surviveP };
  });

  scored.sort((a, b) => b.ev - a.ev);
  return scored[0]?.decision || "LURK";
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
    ...(flagsRound || {}),
  };
}

function buildLogMetricsSafe({ game, player, players, flagsRound }) {
  const carryValue = Number(computeCarryValue(player) ?? 0);

  let metrics = null;
  try {
    const raw = computeDangerMetrics({
      game,
      player,
      players: Array.isArray(players) ? players : [],
      flagsRound: flagsRound || {},
      intel: {
        knownUpcomingEvents: Array.isArray(player?.knownUpcomingEvents)
          ? player.knownUpcomingEvents.filter(Boolean)
          : [],
      },
    });

    if (raw && typeof raw === "object") {
      metrics = { ...raw };
      // voorkom dubbele waarheid
      if ("carryValue" in metrics) delete metrics.carryValue;
    }
  } catch (e) {
    console.warn("[BOTS] computeDangerMetrics failed (keeping carryValue)", e);
    metrics = null;
  }

  return { carryValue, metrics };
}

function getNextEventId(game) {
  if (Array.isArray(game.eventTrack) && typeof game.eventIndex === "number") {
    return game.eventTrack[game.eventIndex] || null;
  }
  return game.currentEventId || null;
}
function getNextEventIndex(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];

  // Prefer eventRevealed: find first unrevealed slot
  if (track.length && rev.length) {
    const n = Math.min(track.length, rev.length);
    for (let i = 0; i < n; i++) {
      if (rev[i] !== true) return i;
    }
    return n; // all revealed up to n
  }

  // Fallback to eventIndex
  const idx = Number.isFinite(Number(game?.eventIndex)) ? Number(game.eventIndex) : 0;
  return Math.max(0, Math.min(track.length ? track.length - 1 : 0, idx));
}


function pickSafestDecisionForUpcomingEvent(game) {
  const nextId = getNextEventId(game);
  const f = nextId ? getEventFacts(nextId) : null;
  if (!f) return "LURK"; // fallback

  // laagste danger wint; tie-break: BURROW > DASH > LURK (veiliger feel)
  const options = [
    { k: "BURROW", d: f.dangerBurrow ?? 0 },
    { k: "DASH",   d: f.dangerDash ?? 0 },
    { k: "LURK",   d: f.dangerLurk ?? 0 },
  ].sort((a, b) => a.d - b.d);

  return options[0].k;
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

  // --- carry value (use score if present) ---
 const carryValue = computeCarryValue(p);

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
      v: Number.isFinite(Number(p?.score)) ? Number(p.score) : Number(p?.eggs || 0) + Number(p?.hens || 0) + (p?.prize ? 3 : 0),
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
async function pickBestActionFromHand({
  db,          // (niet gebruikt; keep signature)
  gameId,       // (niet gebruikt; keep signature)
  game,
  bot,
  players,
  flagsRound,
  presetKey,
  ctx,
}) {
  try {
    const g = game;
    const p = bot;
    const listPlayers = Array.isArray(players) ? players : [];
    const hand = Array.isArray(p?.hand) ? p.hand : [];

    if (!g || !p || !hand.length) return null;

    // --- build metrics-driven "next event" signal (works even with noPeek / unknown next) ---
    const intel = {
      knownUpcomingEvents: Array.isArray(p?.knownUpcomingEvents) ? p.knownUpcomingEvents : [],
    };

    const metrics = computeDangerMetrics({
      game: g,
      player: p,
      players: listPlayers,
      flagsRound: flagsRound || fillFlags(g?.flagsRound),
      intel,
    });

    // If we truly know the next card via SCOUT intel, pass it as nextEventKey
    // Otherwise pass synthetic nextEventFacts derived from probabilities.
    const nextKnown = !!metrics?.intel?.nextKnown;
    const nextEventKey = nextKnown ? (metrics?.nextEventIdUsed || null) : null;
    const syntheticFacts = !nextEventKey ? synthFactsFromMetrics(metrics) : null;

    const myColor = normColor(p?.color);
    const pk = presetKey || presetFromDenColor(myColor);

    const isLead = computeIsLeadForPlayer(g, p, listPlayers);
    const roosterSeen = countRevealedRoosters(g);
    const postRooster2Window = roosterSeen >= 2;

    const baseCtx = {
      ...(ctx || {}),
      round: Number(g?.round || 0),
      isLead,
      roosterSeen,
      postRooster2Window,
      nextKnown,
      // critical: feed heuristics with either real nextEventKey OR synthetic expected dangerVec
      ...(nextEventKey ? { nextEventKey } : { nextEventFacts: syntheticFacts }),
      // for debugging/telemetry if you want later:
      _dangerMetrics: metrics,
    };

    const actionKeys = hand.map((x) => String(x || "").trim()).filter(Boolean);
    if (!actionKeys.length) return null;

    // Use your existing heuristics engine
    const res = pickActionOrPass(actionKeys, {
      game: g,
      me: p,
      players: listPlayers,
      presetKey: pk,
      ctx: baseCtx,
    });

    const playId = res?.play || null;
    if (!playId) return null;

    // map actionId back to a card name in hand
    const chosenName =
      actionKeys.find((k) => {
        const def = getActionDefByName(k);
        return def && String(def.id) === String(playId);
      }) || actionKeys[0];

    // target selection where needed
    let targetId = null;
    if (playId === "MASK_SWAP" || playId === "HOLD_STILL" || playId === "MAGPIE_SNITCH") {
      const t = pickBestTargetForOps(g, p, listPlayers, { actionId: playId });
      targetId = t ? String(t.id) : null;
    }

    return {
      name: chosenName,
      actionId: playId,
      targetId,
      debug: {
        nextEventKeyUsed: nextEventKey,
        usedSyntheticFacts: !nextEventKey,
        dangerPeak: Number(metrics?.dangerPeak ?? 0),
        dangerStay: Number(metrics?.dangerStay ?? 0),
      },
    };
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

async function applyOpsActionAndAdvanceTurn({ db, gameRef, actorId, isPass }) {
  const now = Date.now();
  
let carryNow = 0;   // ✅ 1x declareren (buiten tx)

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
/** ===== logging (single writer to games/{gameId}/actions) ===== */
function stripUndefinedShallow(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

async function logBotAction({ db, gameId, payload }) {
  try {
    if (!db || !gameId) {
      console.warn("[BOT_LOG] skip: missing db/gameId", { hasDb: !!db, gameId });
      return;
    }

    const p = payload && typeof payload === "object" ? payload : {};

    // carryValue blijft top-level (tijdelijk altijd aanwezig)
    const cvRaw =
      p.carryValue ??
      p?.metrics?.carryValue ??      // fallback (als iemand het toch in metrics stopt)
      p?.ctxMini?.carryValue ??      // legacy fallback
      0;

    const carryValue = Number(cvRaw);
    const safeCarry = Number.isFinite(carryValue) ? carryValue : 0;

    // Firestore faalt op undefined → shallow cleanup
    const safePayload = stripUndefinedShallow(p);

    // metrics ook shallow cleanen (en voorkomen dat carryValue dubbel staat)
    let metrics = null;
    if (safePayload.metrics && typeof safePayload.metrics === "object") {
      metrics = stripUndefinedShallow(safePayload.metrics);
      if ("carryValue" in metrics) delete metrics.carryValue; // carryValue alleen top-level
    }

    await addDoc(collection(db, "games", gameId, "actions"), {
      // vaste meta
      kind: safePayload.kind || "BOT_ACTION",
      at: Number(safePayload.at || Date.now()),
      createdAt: serverTimestamp(),

      // baseline
      carryValue: safeCarry,

      // rest
      ...safePayload,

      // force our cleaned metrics (so no undefined/carryValue inside)
      ...(metrics ? { metrics } : { metrics: safePayload.metrics ?? null }),
    });
  } catch (e) {
    console.error("[BOT_LOG] addDoc failed", e, payload);
  }
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
async function botDoMove({ db, gameId, botId }) {
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

    const flagsRound = fillFlags(g.flagsRound);
    const myColor = normColor(p.color);
    const immune = !!flagsRound.denImmune?.[myColor];
    const upcoming = classifyEvent(nextEventId(g, 0));
    const lootPts = sumLootPoints({ loot });

    // --- jouw bestaande move-keuze (SNATCH/FORAGE) ---
    let did = null;

    if (upcoming.type === "TOLL" && lootPts <= 0) {
      if (!lootDeck.length) return;
      const card = lootDeck.pop();
      loot.push(card);
      did = { kind: "SNATCH", detail: `${card.t || "Loot"} ${card.v ?? ""}` };
    } else if (
      (upcoming.type === "DOG" || (upcoming.type === "DEN" && normColor(upcoming.color) === myColor)) &&
      !immune && !hasCard(hand, "Den Signal") &&
      actionDeck.length
    ) {
      let drawn = 0;
      for (let i = 0; i < 2; i++) {
        if (!actionDeck.length) break;
        hand.push(actionDeck.pop());
        drawn++;
      }
      did = { kind: "FORAGE", detail: `${drawn} kaart(en)` };
    } else if (hand.length < 2 && actionDeck.length) {
      let drawn = 0;
      for (let i = 0; i < 2; i++) {
        if (!actionDeck.length) break;
        hand.push(actionDeck.pop());
        drawn++;
      }
      did = { kind: "FORAGE", detail: `${drawn} kaart(en)` };
    } else {
      if (!lootDeck.length) return;
      const card = lootDeck.pop();
      loot.push(card);
      did = { kind: "SNATCH", detail: `${card.t || "Loot"} ${card.v ?? ""}` };
    }

    tx.update(pRef, { hand, loot });
    tx.update(gRef, {
      actionDeck,
      lootDeck,
      movedPlayerIds: [...new Set([...moved, botId])],
    });

    // metrics + carry AFTER mutaties
    const pAfterMove = { ...p, hand, loot };
    const carryValue = Number(computeCarryValue(pAfterMove) ?? 0);
    const metrics = computeDangerMetrics({
      game: g,
      player: pAfterMove,
      players: [],
      flagsRound,
      intel: {
        knownUpcomingEvents: Array.isArray(pAfterMove.knownUpcomingEvents) ? pAfterMove.knownUpcomingEvents : [],
      },
    });

    logPayload = {
      round: Number(g.round || 0),
      phase: "MOVE",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `MOVE_${did.kind}`,
      message: `BOT deed ${did.kind} (${did.detail})`,
      carryValue,
      metrics,
    };
  });

  if (logPayload) {
    await logBotAction({ db, gameId, addLog: null, carryValue: logPayload.carryValue, payload: logPayload });
  }
}

/** ===== smarter OPS ===== */
function chooseBotOpsPlay({ game, bot, players }) {
  const g = game;
  const p = bot;

  const flags = fillFlags(g.flagsRound);
  if (flags.opsLocked) return null;

  const hand = Array.isArray(p.hand) ? p.hand : [];
  if (!hand.length) return null;

  const roundNum = Number(g.round || 0);
  const reserve = roundNum <= 1 ? 2 : 1;

  const disc = Array.isArray(g.actionDiscard) ? g.actionDiscard : [];
  const alreadyPlayedThisRound = disc.some((x) => x?.by === p.id && Number(x?.round || 0) === roundNum);

  const myColor = normColor(p.color);
  const immune = !!flags.denImmune?.[myColor];

  // --- compute danger snapshot (pure)
  const isLead = computeIsLeadForPlayer(g, p, Array.isArray(players) ? players : []);
  const metricsNow = computeDangerMetrics({
    game: g,
    player: p,
    players: Array.isArray(players) ? players : [],
    flagsRound: flags,
    intel: {
      isLead,
      knownUpcomingEvents: Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents : [],
    },
  });

  const dv = metricsNow?.dangerVec || {};
  const dDash = Number(dv.dash ?? 0);
  const dLurk = Number(dv.lurk ?? 0);
  const dBurrow = p.burrowUsed ? 10 : Number(dv.burrow ?? 0);
  const stayMin = Math.min(dLurk, dBurrow);

  const nextIdUsed = String(metricsNow?.nextEventIdUsed || nextEventId(g, 0) || "");
  const upcoming = classifyEvent(nextIdUsed);

  const dangerSoonDogDen =
    upcoming.type === "DOG" ||
    (upcoming.type === "DEN" && normColor(upcoming.color) === myColor);

  // "urgent" = geen veilige choice meer (of BURROW al verbruikt)
  const urgent = (stayMin >= 7) || (p.burrowUsed && dLurk >= 7) || (Number(metricsNow?.dangerPeak ?? 0) >= 8);

  // conserve: small hand / already played -> only if urgent
  if ((hand.length <= reserve || alreadyPlayedThisRound) && !urgent) return null;

  // 1) Den Signal only when it actually matters
  if (!immune && hasCard(hand, "Den Signal") && dangerSoonDogDen) {
    return { name: "Den Signal" };
  }

  // 2) If urgent and track can be manipulated: prefer action that *reduces* dangerPeak
  if (urgent && !flags.lockEvents) {
    let best = null;

    if (hasCard(hand, "Pack Tinker")) {
      const pair = pickPackTinkerSwap(g);
      if (pair) {
        const [i1, i2] = pair;
        const trackNow = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
        if (trackNow[i1] && trackNow[i2]) {
          [trackNow[i1], trackNow[i2]] = [trackNow[i2], trackNow[i1]];
          const m2 = computeDangerMetrics({
            game: { ...g, eventTrack: trackNow },
            player: p,
            players: Array.isArray(players) ? players : [],
            flagsRound: flags,
            intel: { isLead, knownUpcomingEvents: Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents : [] },
          });

          best = {
            name: "Pack Tinker",
            score: Number(m2?.dangerPeak ?? 0),
          };
        }
      }
    }

    if (hasCard(hand, "Kick Up Dust")) {
      const newTrack = shuffleFutureTrack(g);
      if (newTrack) {
        const m2 = computeDangerMetrics({
          game: { ...g, eventTrack: newTrack },
          player: p,
          players: Array.isArray(players) ? players : [],
          flagsRound: flags,
          intel: { isLead, knownUpcomingEvents: Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents : [] },
        });

        const cand = { name: "Kick Up Dust", score: Number(m2?.dangerPeak ?? 0) };
        if (!best || cand.score < best.score) best = cand;
      }
    }

    if (best) return { name: best.name };
  }

  // 3) Offensive utility only when you’re relatively safe (otherwise save cards)
  if (stayMin <= 3 && hasCard(hand, "Hold Still")) {
    const targetId = pickRichestTarget(players, p.id);
    if (targetId) return { name: "Hold Still", targetId };
  }

  // 4) Deck utility
  const actionDeckLen = Array.isArray(g.actionDeck) ? g.actionDeck.length : 0;
  if (actionDeckLen > 0 && hasCard(hand, "Alpha Call") && hand.length < 4) {
    return { name: "Alpha Call" };
  }

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

/** ===== smarter OPS (danger-aware + cashout-aware) ===== */
async function botDoOpsTurn({ db, gameId, botId, addLog = null }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    // only act in ACTIONS phase
    if (String(g.phase || "") !== "ACTIONS") return;

    const flagsRound = fillFlags(g.flagsRound);
    if (flagsRound.opsLocked) return;

    // enforce OPS turn order
    const order = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder : [];
    const idx = Number(g.opsTurnIndex || 0);
    const current = order[idx] || null;
    if (String(current) !== String(botId)) return;

    // read players snapshot for targeting/lead checks (non-transactional read is ok for heuristics)
    const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
    const latestPlayers = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const hand = Array.isArray(p.hand) ? [...p.hand] : [];
    const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const discard = Array.isArray(g.actionDiscard) ? [...g.actionDiscard] : [];

    const isLead = computeIsLeadForPlayer(g, p, latestPlayers);

    // --- choose action using danger-aware heuristics (via pickBestActionFromHand) ---
    const presetKey = presetFromDenColor(normColor(p.color));
    const play = await pickBestActionFromHand({
      db,
      gameId,
      game: g,
      bot: p,
      players: latestPlayers,
      flagsRound,
      presetKey,
      ctx: {
        round: Number(g.round || 0),
        isLead,
        dashDecisionsSoFar: countDashDecisions(latestPlayers),
      },
    });

    const passesNow = Number(g.opsConsecutivePasses || 0);
    const nextIdx = (idx + 1) % Math.max(1, order.length);

    // PASS
    if (!play) {
      let nextPasses = passesNow + 1;
      const target = Math.max(1, Math.ceil(order.length * 0.6)); // keep your rule or set your own
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

      const carryValue = Number(computeCarryValue(p) ?? 0);
      const metrics = computeDangerMetrics({
        game: { ...g, flagsRound },
        player: p,
        players: latestPlayers,
        flagsRound,
        intel: { knownUpcomingEvents: Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents : [] },
      });

      logPayload = {
        kind: "BOT_OPS",
        round: Number(g.round || 0),
        phase: "ACTIONS",
        playerId: botId,
        playerName: p.name || "BOT",
        isLead,
        choice: "OPS_PASS",
        message: "BOT past (OPS)",
        carryValue,
        metrics,
      };
      return;
    }

    // PLAY CARD
    const { name, actionId, targetId } = play;

    // remove card from hand
    removeOneCard(hand, name);

    // discard card
    discard.push({ name, id: actionId, by: botId, at: Date.now() });

    // apply effects (keep your existing implementations)
    // NOTE: below calls assume you already have apply* functions in this file.
    // If your engine uses different names, keep your existing block and only keep: hand/discard/flags updates.

    const effect = { ...(flagsRound || {}) };

    if (actionId === "DEN_SIGNAL") {
      const myColor = normColor(p.color);
      effect.denImmune = { ...(effect.denImmune || {}), [myColor]: true };
    }

    if (actionId === "HOLD_STILL") {
      effect.opsLocked = true;
    }

    // TODO: keep your other action implementations here (Mask Swap, Burrow Beacon, Nose for Trouble, etc.)
    // (I’m not removing anything—just ensuring OPS always advances and logs metrics)

    tx.update(pRef, { hand });
    tx.update(gRef, {
      actionDiscard: discard,
      flagsRound: effect,
      opsTurnIndex: nextIdx,
      opsConsecutivePasses: 0,
    });

    const carryValue = Number(computeCarryValue(p) ?? 0);
    const metrics = computeDangerMetrics({
      game: { ...g, flagsRound: effect },
      player: { ...p, hand },
      players: latestPlayers,
      flagsRound: effect,
      intel: { knownUpcomingEvents: Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents : [] },
    });

    logPayload = {
      kind: "BOT_OPS",
      round: Number(g.round || 0),
      phase: "ACTIONS",
      playerId: botId,
      playerName: p.name || "BOT",
      isLead,
      choice: `OPS_PLAY_${actionId}`,
      message: `BOT speelt ${name}`,
      carryValue,
      metrics,
      targetId: targetId || null,
    };
  });

  // ✅ log AFTER transaction
  if (logPayload) {
    await logBotAction({ db, gameId, addLog, payload: logPayload });
  }
}

/** ===== smarter DECISION (danger-aware + cashout-aware) ===== */
async function botDoDecision({ db, gameId, botId }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (String(g.phase || "") !== "DECISION") return;
    if (String(p.decision || "") !== "") return; // already decided

    const flagsRound = fillFlags(g.flagsRound);

    // players snapshot for lead/herd logic
    const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
    const freshPlayers = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const isLead = computeIsLeadForPlayer(g, p, freshPlayers);

    // compute danger metrics (probabilistic if needed)
    const metrics = computeDangerMetrics({
      game: { ...g, flagsRound },
      player: p,
      players: freshPlayers,
      flagsRound,
      intel: { knownUpcomingEvents: Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents : [] },
    });

    // Feed recommendDecision with:
    // - real nextEventKey if nextKnown via scout intel
    // - else synthetic facts from dangerVec (prob-based)
    const nextKnown = !!metrics?.intel?.nextKnown;
    const nextEventKey = nextKnown ? (metrics?.nextEventIdUsed || null) : null;
    const syntheticFacts = !nextEventKey ? synthFactsFromMetrics(metrics) : null;

    const presetKey = presetFromDenColor(normColor(p.color));

    const decisionRes = recommendDecision({
      game: g,
      me: p,
      players: freshPlayers,
      presetKey,
      ctx: {
        round: Number(g.round || 0),
        isLead,
        dashDecisionsSoFar: countDashDecisions(freshPlayers),
        roosterSeen: countRevealedRoosters(g),
        postRooster2Window: countRevealedRoosters(g) >= 2,
        nextKnown,
        ...(nextEventKey ? { nextEventKey } : { nextEventFacts: syntheticFacts }),
      },
    });

    let decision = String(decisionRes?.decision || "LURK").toUpperCase();
    if (decision === "BURROW" && p.burrowUsed) decision = "LURK";

    // write decision
    tx.update(pRef, { decision });

    // also update game decisions map (if you use it)
    const decisions = { ...(g.decisions || {}) };
    decisions[botId] = decision;
    tx.update(gRef, { decisions });

    const carryValue = Number(computeCarryValue(p) ?? 0);

    logPayload = {
      kind: "BOT_DECISION",
      round: Number(g.round || 0),
      phase: "DECISION",
      playerId: botId,
      playerName: p.name || "BOT",
      isLead,
      choice: `DECISION_${decision}`,
      message: `BOT kiest ${decision}`,
      carryValue,
      cashoutBias: Number(decisionRes?.cashoutBias ?? 0),
      metrics: {
        ...metrics,
        // extra debug: wat decision engine zag
        _decision: {
          decision,
          nextEventKeyUsed: nextEventKey,
          usedSyntheticFacts: !nextEventKey,
          dangerVecUsed: decisionRes?.dangerVec || null,
        },
      },
    };
  });

  if (logPayload) {
    // jij wilde decision apart:
    await logBotDecision({ db, gameId, payload: logPayload });
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
        await botDoMove({ db, gameId, botId: job.botId });
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
    burrowUsed: false,
    decision: null,
    hand,
    loot: [],
  });

  await updateDoc(gRef, { botsEnabled: true, actionDeck });
}
