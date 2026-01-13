// js/bots/botRunner.js
// Autonomous bots for VOSSENJACHT (smart OPS flow + threat-aware decisions)

import { getEventFacts, rankActions, scoreActionFacts } from "./aiKit.js";
import { getActionDefByName } from "../cards.js";
import { presetFromDenColor } from "./botHeuristics.js";

const presetKey = presetFromDenColor(bot.denColor);

const ranked = rankActions(bot.hand || bot.actionHand || bot.actionCards || [], { presetKey,
  denColor: bot.denColor,
  game,
  me: bot,
});

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

// 0..100 (grof, maar werkt goed)
function computeHandStrength({ game, bot }) {
  const ids = handToActionIds(bot?.hand);
  if (!ids.length) return { score: 0, ids: [], top: null };

  // top-2 kaarten tellen het zwaarst
  const ranked = rankActions(ids);
  const topIds = ranked.slice(0, 2).map((x) => x.id);

  let raw = 0;
  for (const id of topIds) {
    const s = scoreActionFacts(id);
    if (!s) continue;
    raw +=
      (s.controlScore || 0) +
      (s.infoScore || 0) +
      (s.lootScore || 0) +
      (s.tempoScore || 0) -
      (s.riskScore || 0);
  }

  // context: als next event gevaarlijk is, is defense/control meer waard
  const nextEvent0 = getNextEventId(game);
  const f = nextEvent0 ? getEventFacts(nextEvent0) : null;
  const dangerPeak = f ? Math.max(f.dangerDash ?? 0, f.dangerLurk ?? 0, f.dangerBurrow ?? 0) : 0;

  // schaal en clamp
  let score = Math.round(Math.max(0, Math.min(100, raw * 5)));

  // als danger hoog is, verlaag “comfort”: je wil liever een sterke hand
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

function pickDecisionLootMaximizer({ g, p, latestPlayers }) {
  const myColor = String(p?.color || "").trim().toUpperCase();
  const flags = fillFlags(g?.flagsRound);
  const immune = !!flags.denImmune?.[myColor];

  const nextEvent0 = nextEventId(g, 0);
  const lootPts = sumLootPoints(p);

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

  const options = ["LURK", "DASH", "BURROW"].filter((d) => d !== "BURROW" || !p.burrowUsed);

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

function getNextEventId(game) {
  if (Array.isArray(game.eventTrack) && typeof game.eventIndex === "number") {
    return game.eventTrack[game.eventIndex] || null;
  }
  return game.currentEventId || null;
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

function pickBestActionFromHand({ game, bot, players }) {
  const hand = Array.isArray(bot?.hand) ? bot.hand : [];
  if (!hand.length) return null;

  // hand bevat bij jou meestal {name:"Den Signal"} of "Den Signal"
  const handNames = hand
    .map((c) => String(c?.name || c || "").trim())
    .filter(Boolean);

  // map kaartnaam -> actionId via cards.js defs
  const entries = handNames
    .map((name) => ({ name, def: getActionDefByName(name) }))
    .filter((x) => x.def?.id);

  const ids = entries.map((x) => x.def.id);
  if (!ids.length) return null;

  const ranked = rankActions(ids); // hoogste waarde eerst

  for (const r of ranked) {
    const id = r.id;

    // legality checks
    if (id === "PACK_TINKER" || id === "KICK_UP_DUST") {
      if (game?.flagsRound?.lockEvents) continue;
      if (!Array.isArray(game.eventTrack)) continue;
      if (typeof game.eventIndex !== "number") continue;
      if (game.eventIndex >= game.eventTrack.length - 1) continue;
    }

    if (id === "HOLD_STILL" && game?.flagsRound?.opsLocked) continue;

    // targets waar nodig
    let targetId = null;
    if (id === "MASK_SWAP" || id === "HOLD_STILL") {
      targetId = pickRichestTarget(players || [], bot.id);
      if (!targetId) continue;
    }

    // terug naar “kaartnaam” die in hand zit (nodig voor removeOneCard(hand, cardName))
    const entry = entries.find((x) => x.def.id === id);
    const name = entry?.name || entry?.def?.name || id;

    return targetId ? { name, targetId } : { name };
  }

  return null;
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
async function logBotAction({ db, gameId, addLog, payload }) {
  // games/{game}/actions
  await addDoc(collection(db, "games", gameId, "actions"), {
    ...payload,
    createdAt: serverTimestamp(),
  });

  // games/{game}/log (via your helper)
  if (typeof addLog === "function") {
    await addLog(gameId, {
      round: payload.round ?? 0,
      phase: payload.phase ?? "",
      kind: "BOT",
      playerId: payload.playerId,
      message: payload.message || `${payload.playerName || "BOT"}: ${payload.choice}`,
    });
  }
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

    const flags = fillFlags(g.flagsRound);
    const myColor = normColor(p.color);
    const immune = !!flags.denImmune?.[myColor];
    const upcoming = classifyEvent(nextEventId(g, 0));
    const lootPts = sumLootPoints({ loot });

    // Priorities:
    // 1) If Gate Toll soon and no loot: grab loot
    const mustHaveLoot = upcoming.type === "TOLL";
    // 2) If danger soon and no Den Signal in hand: forage to fish for defense
    const dangerSoon =
      upcoming.type === "DOG" || (upcoming.type === "DEN" && normColor(upcoming.color) === myColor);
    const needsDefense = dangerSoon && !immune && !hasCard(hand, "Den Signal");

    // Choose MOVE
    let did = null;

    if (mustHaveLoot && lootPts <= 0) {
      if (!lootDeck.length) return;
      const card = lootDeck.pop();
      loot.push(card);
      did = { kind: "SNATCH", detail: `${card.t || "Loot"} ${card.v ?? ""}` };
    } else if (needsDefense && actionDeck.length) {
      // draw up to 2
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
    tx.update(gRef, { actionDeck, lootDeck, movedPlayerIds: [...new Set([...moved, botId])] });

    logPayload = {
      round: Number(g.round || 0),
      phase: "MOVE",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `MOVE_${did.kind}`,
      message: `BOT deed ${did.kind} (${did.detail})`,
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
  if (dangerSoonDogDen && !immune && !flags.lockEvents) {
    if (hasCard(hand, "Kick Up Dust")) return { name: "Kick Up Dust" };
    if (hasCard(hand, "Pack Tinker")) return { name: "Pack Tinker" };
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

    const nextIdx = (idx + 1) % order.length;

    const hand = Array.isArray(p.hand) ? [...p.hand] : [];
    const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const actionDiscard = Array.isArray(g.actionDiscard) ? [...g.actionDiscard] : [];

    const play = pickBestActionFromHand({ game: g, bot: p, players: latestPlayers || [] });


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

      logPayload = {
        round: roundNum,
        phase: "ACTIONS",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "ACTION_PASS",
        message: "BOT kiest PASS",
      };
      return;
    }

    const cardName = play.name;

    // remove from hand
    const removed = removeOneCard(hand, cardName);
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
              flagsRound: { ...(g.flagsRound || {}), opsLocked: true }, // ✅ hard stop
              opsEndedAtMs: Date.now(),
            }
          : {}),
      });

      logPayload = {
        round: roundNum,
        phase: "ACTIONS",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "ACTION_PASS",
        message: "BOT wilde spelen maar kaart niet gevonden → PASS",
      };
      return;
    }

    // discard + draw replacement
    actionDiscard.push({ name: cardName, by: botId, round: roundNum, at: Date.now() });
 
    const extraGameUpdates = {};

    // effects
    if (cardName === "Den Signal") {
      const myColor = normColor(p.color);
      const denImmune = { ...(flagsRound.denImmune || {}) };
      if (myColor) denImmune[myColor] = true;
      flagsRound.denImmune = denImmune;
    }

    if (cardName === "No-Go Zone") {
      flagsRound.opsLocked = true;
      extraGameUpdates.opsConsecutivePasses = target; // ✅ einde OPS (past bij PhaseGate)
      extraGameUpdates.opsEndedAtMs = Date.now();
    }

    if (cardName === "Hold Still") {
      const targetId = play.targetId;
      if (targetId) {
        const hs = { ...(flagsRound.holdStill || {}) };
        hs[targetId] = true;
        flagsRound.holdStill = hs;
        extraGameUpdates.lastHoldStill = { by: botId, targetId, round: roundNum, at: Date.now() };
      }
    }

    if (cardName === "Kick Up Dust") {
      if (!flagsRound.lockEvents) {
        const newTrack = shuffleFutureTrack(g);
        if (newTrack) extraGameUpdates.eventTrack = newTrack;
      }
    }

    if (cardName === "Pack Tinker") {
      if (!flagsRound.lockEvents) {
        const pair = pickPackTinkerSwap(g);
        if (pair) {
          const [i1, i2] = pair;
          const trackNow = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
          if (trackNow[i1] && trackNow[i2]) {
            [trackNow[i1], trackNow[i2]] = [trackNow[i2], trackNow[i1]];
            extraGameUpdates.eventTrack = trackNow;
            extraGameUpdates.lastPackTinker = { by: botId, i1, i2, round: roundNum, at: Date.now() };
          }
        }
      }
    }

    if (cardName === "Alpha Call") {
      if (actionDeck.length) hand.push(actionDeck.pop());
    }

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

    if (cardName === "Follow the Tail") {
      const targetId = pickRichestTarget(latestPlayers || [], botId);
      if (targetId) {
        const ft = { ...(flagsRound.followTail || {}) };
        ft[botId] = targetId;
        flagsRound.followTail = ft;
      }
    }

    if (cardName === "Molting Mask") {
      flagsRound.noPeek = true;
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
      flagsRound,
      opsTurnIndex: nextIdx,
      opsConsecutivePasses: 0, // reset on play
      ...extraGameUpdates,
    });

    let msg = `BOT speelt Action Card: ${cardName}`;
    if (cardName === "Pack Tinker" && extraGameUpdates.lastPackTinker) {
      msg = `BOT speelt Pack Tinker (swap ${extraGameUpdates.lastPackTinker.i1 + 1} ↔ ${
        extraGameUpdates.lastPackTinker.i2 + 1
      })`;
    }
    if (cardName === "Kick Up Dust") {
      msg = flagsRound.lockEvents
        ? "BOT speelt Kick Up Dust (geen effect: Burrow Beacon actief)"
        : "BOT speelt Kick Up Dust (future events geschud)";
    }
    if (cardName === "Den Signal") {
      msg = `BOT speelt Den Signal (DEN ${normColor(p.color) || "?"} immune)`;
    }
    if (cardName === "No-Go Zone") {
      msg = "BOT speelt No-Go Zone (OPS locked)";
    }

    logPayload = {
      round: roundNum,
      phase: "ACTIONS",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `ACTION_${cardName}`,
      message: msg,
    };
  });

  if (logPayload) await logBotAction({ db, gameId, addLog: null, payload: logPayload });
}

/** ===== smarter DECISION ===== */
async function botDoDecision({ db, gameId, botId, latestPlayers = [] }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!canBotDecide(g, p)) return;

    const decision = pickDecisionLootMaximizer({ g, p, latestPlayers });
    const update = { decision };

    if (decision === "BURROW" && !p.burrowUsed) {
      update.burrowUsed = true;
    }

    tx.update(pRef, update);

    logPayload = {
      round: Number(g.round || 0),
      phase: "DECISION",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `DECISION_${decision}`,
      message: `BOT kiest ${decision}`,
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
