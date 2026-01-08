// docs/js/bots/botRunner.js
import {
  doc,
  getDoc,
  getDocs,
  collection,
  addDoc,
  updateDoc,
  serverTimestamp,
  onSnapshot,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { getEventById } from "../cards.js";

// ------------------------------
// helpers (self-contained)
// ------------------------------
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isActiveRaidStatus(status) {
  // pas aan als jij andere statuses gebruikt
  return status === "round" || status === "playing" || status === "active";
}
function isGameFinished(game) {
  return game?.status === "finished";
}
function isInYardLocal(p) {
  return p?.inYard !== false && !p?.dashed;
}

function safeArr(x) { return Array.isArray(x) ? x : []; }
function safeObj(x) { return x && typeof x === "object" ? x : {}; }
function str(x) { return x == null ? "" : String(x); }

function currentOpsPlayerId(game) {
  const order = safeArr(game?.opsTurnOrder);
  const idx = typeof game?.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  if (!order.length) return null;
  if (idx < 0 || idx >= order.length) return null;
  return order[idx];
}

function mergeFlagsRound(g) {
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
    ...(g?.flagsRound || {}),
  };
}

// ------------------------------
// bot policy (zelfde als host.js)
// ------------------------------
const BOT_ACTION_PROB_BASE = 0.65;

const BOT_PREFERRED_ACTIONS = new Set([
  "Den Signal",
  "Nose for Trouble",
  "Kick Up Dust",
  "Pack Tinker",
  "Hold Still",
  "Mask Swap",
  "Follow the Tail",
  "Scent Check",
  "Burrow Beacon",
  "Scatter!",
  "No-Go Zone",
  "Alpha Call",
  "Molting Mask",
]);

function botActionProb(handLen) {
  const base = BOT_ACTION_PROB_BASE;
  const handBonus = Math.min(0.25, Math.max(0, (handLen - 1) * 0.08));
  return Math.min(0.95, base + handBonus);
}

function pickBotActionName(hand) {
  const names = safeArr(hand).map((c) => c?.name).filter(Boolean);
  if (!names.length) return null;

  const preferred = names.filter((n) => BOT_PREFERRED_ACTIONS.has(n));
  if (preferred.length) return preferred[Math.floor(Math.random() * preferred.length)];

  return names[Math.floor(Math.random() * names.length)];
}

function pickFutureEventIdForPrediction(game) {
  const track = safeArr(game?.eventTrack);
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  if (!track.length || idx >= track.length) return null;

  if (Math.random() < 0.75) return track[idx];

  const future = track.slice(idx).filter(Boolean);
  if (!future.length) return null;
  return future[Math.floor(Math.random() * future.length)];
}

function shuffleFutureTrack(game) {
  const track = safeArr(game?.eventTrack).slice();
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  if (track.length <= 1) return null;

  const locked = track.slice(0, idx);
  const future = track.slice(idx);
  if (future.length <= 1) return null;

  const shuffledFuture = shuffleArray(future);
  return [...locked, ...shuffledFuture];
}

function lootPoints(p) {
  const loot = safeArr(p?.loot);
  return loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);
}

function pickBestTargetPlayerId(botId, players) {
  const candidates = safeArr(players).filter((x) => x?.id && x.id !== botId && isInYardLocal(x));
  if (!candidates.length) return null;
  candidates.sort((a, b) => lootPoints(b) - lootPoints(a));
  return candidates[0].id;
}

function pickPackTinkerIndices(game) {
  const track = safeArr(game?.eventTrack);
  const revealed = Array.isArray(game?.eventRevealed) ? game.eventRevealed : track.map(() => false);

  const hidden = [];
  for (let i = 0; i < track.length; i++) if (!revealed[i]) hidden.push(i);
  if (hidden.length < 2) return null;

  const nextIdx = typeof game?.eventIndex === "number" ? game.eventIndex : hidden[0];
  const a = hidden.includes(nextIdx) ? nextIdx : hidden[0];
  let b = hidden[hidden.length - 1];
  if (b === a) b = hidden[0];

  return [a, b];
}

// ------------------------------
// runner id (anti double-host)
// ------------------------------
function getRunnerId() {
  let botRunnerId = null;
  try { botRunnerId = localStorage.getItem("botRunnerId"); } catch {}
  if (!botRunnerId) {
    const rnd =
      globalThis.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Math.random()).slice(2) + "-" + Date.now();
    botRunnerId = rnd;
    try { localStorage.setItem("botRunnerId", botRunnerId); } catch {}
  }
  return botRunnerId;
}

// ------------------------------
// logging: /actions (legacy) + /log (CHOICE)
// ------------------------------
async function writeBotLog({ db, gameId, addLog, payload }) {
  const p = payload || {};
  await addDoc(collection(db, "games", gameId, "actions"), {
    ...p,
    createdAt: serverTimestamp(),
  });

  if (typeof addLog === "function") {
    const phase = p.phase ?? "";
    const choice = p.choice ?? null;

    let type = null;
    if (phase === "MOVE") type = "MOVE_CHOSEN";
    else if (phase === "ACTIONS") type = (choice === "ACTION_PASS" ? "OPS_PASSED" : "OPS_PLAYED");
    else if (phase === "DECISION") type = "DECISION_CHOSEN";

    await addLog(gameId, {
      round: Number.isFinite(Number(p.round)) ? Number(p.round) : 0,
      phase,
      kind: "CHOICE",
      type,
      actorId: p.playerId ?? null,
      playerId: p.playerId ?? null,
      playerName: p.playerName ?? "BOT",
      choice,
      payload: p.payload ?? null,
      message: p.message || `${p.playerName || "BOT"}: ${choice || ""}`,
    });
  }
}

// ------------------------------
// lock: botsLockUntil/botsLockBy
// ------------------------------
async function acquireBotLock({ db, gameId, runnerId, hostUid = null }) {
  const ref = doc(db, "games", gameId);
  const now = Date.now();
  const me = hostUid || runnerId;

  try {
    const ok = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;

      const g = snap.data();
      if (g?.botsEnabled !== true) return false;
      if (isGameFinished(g)) return false;

      const lockUntil = Number(g.botsLockUntil || 0);
      const lockBy = String(g.botsLockBy || "");
      if (lockUntil > now && lockBy && lockBy !== me) return false;

      tx.update(ref, { botsLockUntil: now + 1600, botsLockBy: me });
      return true;
    });

    return ok === true;
  } catch (e) {
    console.warn("[BOTS] lock tx failed", e);
    return false;
  }
}

// ------------------------------
// core: MOVE / ACTIONS / DECISION
// ------------------------------
async function botDoMove({ db, gameId, addLog, botId }) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!isActiveRaidStatus(g.status)) return;
    if (g.phase !== "MOVE") return;
    if (g.raidEndedByRooster) return;
    if (!isInYardLocal(p)) return;

    const moved = safeArr(g.movedPlayerIds);
    if (moved.includes(botId)) return;

    const actionDeck = safeArr(g.actionDeck).slice();
    const lootDeck = safeArr(g.lootDeck).slice();
    const hand = safeArr(p.hand).slice();
    const loot = safeArr(p.loot).slice();

    // zelfde gedrag als host: hand<2 => forage, anders snatch
    if (hand.length < 2 && actionDeck.length) {
      let drawn = 0;
      for (let i = 0; i < 2; i++) {
        if (!actionDeck.length) break;
        hand.push(actionDeck.pop());
        drawn++;
      }

      tx.update(pRef, { hand });
      tx.update(gRef, { actionDeck, movedPlayerIds: [...new Set([...moved, botId])] });

      logPayload = {
        round: g.round || 0,
        phase: "MOVE",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: `MOVE_FORAGE_${drawn}cards`,
        message: `BOT deed FORAGE (${drawn} kaart(en))`,
      };
    } else {
      if (!lootDeck.length) return;
      const card = lootDeck.pop();
      loot.push(card);

      tx.update(pRef, { loot });
      tx.update(gRef, { lootDeck, movedPlayerIds: [...new Set([...moved, botId])] });

      logPayload = {
        round: g.round || 0,
        phase: "MOVE",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "MOVE_SNATCH_FROM_DECK",
        message: `BOT deed SNATCH (${card?.t || "Loot"} ${card?.v ?? ""})`,
      };
    }
  });

  if (logPayload) await writeBotLog({ db, gameId, addLog, payload: logPayload });
}

async function botDoOpsTurn({ db, gameId, addLog, botId, latestPlayers }) {
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

    const order = safeArr(g.opsTurnOrder);
    const idx = typeof g.opsTurnIndex === "number" ? g.opsTurnIndex : 0;
    if (!order.length || order[idx] !== botId) return;

    const roundNum = Number(g.round || 0);
    const nextIndex = (idx + 1) % order.length;

    // FIX: opsLocked => FORCED PASS (nooit returnen)
    if (g.flagsRound?.opsLocked) {
      tx.update(gRef, {
        opsTurnIndex: nextIndex,
        opsConsecutivePasses: order.length,
      });

      logPayload = {
        round: roundNum,
        phase: "ACTIONS",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "ACTION_PASS",
        payload: { reason: "opsLocked" },
        message: "BOT forced PASS (opsLocked)",
      };
      return;
    }

    const alreadyPlayed = p.opsActionPlayedRound === roundNum;

    const hand0 = safeArr(p.hand).slice();
    const actionDeck0 = safeArr(g.actionDeck).slice();
    const discard0 = safeArr(g.actionDiscard).slice();
    const flagsRound0 = mergeFlagsRound(g);

    const prob = botActionProb(hand0.length);
    let willPlay = !alreadyPlayed && hand0.length > 0 && Math.random() < prob;

    if (!willPlay) {
      // PASS
      const passes = Number(g.opsConsecutivePasses || 0) + 1;
      tx.update(gRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });

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

    const cardName = pickBotActionName(hand0);
    if (!cardName) {
      const passes = Number(g.opsConsecutivePasses || 0) + 1;
      tx.update(gRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });

      logPayload = {
        round: roundNum,
        phase: "ACTIONS",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "ACTION_PASS",
        payload: { reason: "no_cardName" },
        message: "BOT kiest PASS",
      };
      return;
    }

    // prerequisites FIRST (geen rollback-gedoe)
    const extraGameUpdates = {};
    let targetId = null;

    if (cardName === "Follow the Tail" || cardName === "Hold Still" || cardName === "Mask Swap") {
      targetId = pickBestTargetPlayerId(botId, latestPlayers);
      if (!targetId) {
        const passes = Number(g.opsConsecutivePasses || 0) + 1;
        tx.update(gRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });

        logPayload = {
          round: roundNum,
          phase: "ACTIONS",
          playerId: botId,
          playerName: p.name || "BOT",
          choice: "ACTION_PASS",
          payload: { reason: `no_target_for_${cardName}` },
          message: "BOT kiest PASS (geen target)",
        };
        return;
      }
    }

    // consume card
    const hand = hand0.slice();
    const removeIdx = hand.findIndex((c) => c?.name === cardName);
    if (removeIdx >= 0) hand.splice(removeIdx, 1);

    const actionDeck = actionDeck0.slice();
    const discard = discard0.slice();
    discard.push({ name: cardName, by: botId, round: roundNum, at: Date.now() });

    // draw 1 replacement
    if (actionDeck.length) hand.push(actionDeck.pop());

    const flagsRound = { ...flagsRound0 };

    // effects (zelfde als host)
    if (cardName === "Burrow Beacon") {
      flagsRound.lockEvents = true;
    }

    if (cardName === "Scatter!") {
      flagsRound.scatter = true;
      extraGameUpdates.scatterArmed = true;
    }

    if (cardName === "Scent Check") {
      const arr = safeArr(flagsRound.scentChecks).slice();
      if (!arr.includes(botId)) arr.push(botId);
      flagsRound.scentChecks = arr;
    }

    if (cardName === "Follow the Tail") {
      const ft = safeObj(flagsRound.followTail);
      ft[botId] = targetId;
      flagsRound.followTail = ft;
    }

    if (cardName === "Den Signal") {
      const denImmune = safeObj(flagsRound.denImmune);
      const myColor = str(p.color).toUpperCase();
      if (myColor) denImmune[myColor] = true;
      flagsRound.denImmune = denImmune;
    }

    if (cardName === "Pack Tinker") {
      if (!flagsRound.lockEvents) {
        const pair = pickPackTinkerIndices(g);
        if (pair) {
          const [i1, i2] = pair;
          const trackNow = safeArr(g.eventTrack).slice();
          if (trackNow[i1] && trackNow[i2]) {
            [trackNow[i1], trackNow[i2]] = [trackNow[i2], trackNow[i1]];
            extraGameUpdates.eventTrack = trackNow;
            extraGameUpdates.lastPackTinker = { by: botId, i1, i2, round: roundNum, at: Date.now() };
          }
        }
      }
    }

    if (cardName === "Kick Up Dust") {
      if (!flagsRound.lockEvents) {
        const newTrack = shuffleFutureTrack(g);
        if (newTrack) extraGameUpdates.eventTrack = newTrack;
      }
    }

    if (cardName === "Nose for Trouble") {
      const eventId = pickFutureEventIdForPrediction(g);
      if (eventId) {
        const preds = safeArr(flagsRound.predictions).slice();
        const filtered = preds.filter((x) => x?.playerId !== botId);
        filtered.push({ playerId: botId, eventId, round: roundNum, at: Date.now() });
        flagsRound.predictions = filtered;
        extraGameUpdates.lastPrediction = { by: botId, eventId };
      }
    }

    if (cardName === "Molting Mask") {
      flagsRound.noPeek = true;
    }

    if (cardName === "Alpha Call") {
      if (actionDeck.length) hand.push(actionDeck.pop());
    }

    if (cardName === "No-Go Zone") {
      flagsRound.opsLocked = true;
      extraGameUpdates.opsConsecutivePasses = order.length;
    }

    if (cardName === "Hold Still") {
      const hs = safeObj(flagsRound.holdStill);
      hs[targetId] = true;
      flagsRound.holdStill = hs;
      extraGameUpdates.lastHoldStill = { by: botId, targetId };
    }

    let newBotColor = null;
    if (cardName === "Mask Swap") {
      const tRef = doc(db, "games", gameId, "players", targetId);
      const tSnap = await tx.get(tRef);
      if (tSnap.exists()) {
        const t = { id: tSnap.id, ...tSnap.data() };
        const a = str(p.color).toUpperCase();
        const b = str(t.color).toUpperCase();
        if (a && b && a !== b) {
          tx.update(tRef, { color: a });
          newBotColor = b;
          extraGameUpdates.lastMaskSwap = { by: botId, targetId, a, b };
        }
      }
    }

    // commit
    const playerUpdate = { hand, opsActionPlayedRound: roundNum };
    if (newBotColor) playerUpdate.color = newBotColor;

    tx.update(pRef, playerUpdate);

    tx.update(gRef, {
      actionDeck,
      actionDiscard: discard,
      flagsRound,
      opsTurnIndex: nextIndex,
      opsConsecutivePasses: 0,
      ...extraGameUpdates,
    });

    // log
    let msg = `BOT speelt Action Card: ${cardName}`;
    if (cardName === "Pack Tinker" && extraGameUpdates.lastPackTinker) {
      msg = `BOT speelt Pack Tinker (swap ${extraGameUpdates.lastPackTinker.i1 + 1} ↔ ${extraGameUpdates.lastPackTinker.i2 + 1})`;
    } else if (cardName === "Den Signal") {
      msg = `BOT speelt Den Signal (DEN ${newBotColor || p.color || "?"} immune)`;
    } else if (cardName === "Kick Up Dust") {
      msg = flagsRound.lockEvents
        ? "BOT speelt Kick Up Dust (geen effect: Burrow Beacon actief)"
        : "BOT speelt Kick Up Dust (future events geschud)";
    } else if (cardName === "Nose for Trouble" && extraGameUpdates.lastPrediction) {
      msg = `BOT speelt Nose for Trouble (voorspelt: ${extraGameUpdates.lastPrediction.eventId})`;
    } else if (cardName === "Hold Still" && extraGameUpdates.lastHoldStill) {
      msg = `BOT speelt Hold Still (target: ${extraGameUpdates.lastHoldStill.targetId})`;
    } else if (cardName === "Mask Swap" && extraGameUpdates.lastMaskSwap) {
      msg = `BOT speelt Mask Swap (wisselt ${extraGameUpdates.lastMaskSwap.a} ↔ ${extraGameUpdates.lastMaskSwap.b})`;
    } else if (cardName === "No-Go Zone") {
      msg = "BOT speelt No-Go Zone (OPS locked)";
    }

    logPayload = {
      round: roundNum,
      phase: "ACTIONS",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `ACTION_PLAY_${cardName}`,
      payload: { targetId: targetId || null, ...extraGameUpdates },
      message: msg,
    };
  });

  if (logPayload) await writeBotLog({ db, gameId, addLog, payload: logPayload });
}

async function botDoDecision({ db, gameId, addLog, botId }) {
  const pRef = doc(db, "games", gameId, "players", botId);
  const gRef = doc(db, "games", gameId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!isActiveRaidStatus(g.status)) return;
    if (g.phase !== "DECISION") return;
    if (g.raidEndedByRooster) return;
    if (!isInYardLocal(p)) return;
    if (p.decision) return;

    const loot = safeArr(p.loot);
    const lootPts = loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);

    const roundNum = Number(g.round || 0);
    const roosterSeen = Number(g.roosterSeen || 0);

    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

    // Den Signal override => LURK
    const myColor = str(p.color).toUpperCase();
    const denImmune = safeObj(g.flagsRound?.denImmune);

    const hasDenSignalSafety =
      !!myColor && (denImmune[myColor] === true || denImmune[myColor.toLowerCase()] === true);

    if (hasDenSignalSafety) {
      const kind = "LURK";
      tx.update(pRef, { decision: kind });

      logPayload = {
        round: roundNum,
        phase: "DECISION",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: `DECISION_${kind}`,
        message: `BOT kiest LURK (Den Signal actief voor ${myColor || "?"})`,
      };
      return;
    }

    let dashProb = 0.03 + roundNum * 0.04 + lootPts * 0.04 + roosterSeen * 0.08;
    dashProb = clamp(dashProb, 0, 0.70);

    if (lootPts <= 0) dashProb = 0;
    if (roundNum <= 2 && lootPts < 3) dashProb = 0;

    let kind = "LURK";
    if (Math.random() < dashProb) kind = "DASH";
    else if (!p.burrowUsed && Math.random() < 0.15) kind = "BURROW";

    const update = { decision: kind };
    if (kind === "BURROW" && !p.burrowUsed) update.burrowUsed = true;

    tx.update(pRef, update);

    logPayload = {
      round: roundNum,
      phase: "DECISION",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `DECISION_${kind}`,
      message: `BOT kiest ${kind} (dashProb=${dashProb.toFixed(2)} loot=${lootPts} rooster=${roosterSeen})`,
    };
  });

  if (logPayload) await writeBotLog({ db, gameId, addLog, payload: logPayload });
}

// ------------------------------
// public API
// ------------------------------
export function startBotRunner({ db, gameId, addLog = null, isBoardOnly = false, hostUid = null }) {
  if (isBoardOnly) return;

  const runnerId = getRunnerId();
  const gameRef = doc(db, "games", gameId);
  const playersRef = collection(db, "games", gameId, "players");

  let latestGame = null;
  let latestPlayers = [];
  let busy = false;
  let tickScheduled = false;

  function scheduleTick() {
    if (tickScheduled) return;
    tickScheduled = true;
    setTimeout(async () => {
      tickScheduled = false;
      await runOnce();
    }, 250);
  }

  async function runOnce() {
    if (busy) return;
    if (!latestGame) return;

    const game = latestGame;
    if (game.botsEnabled !== true) return;
    if (isGameFinished(game)) return;
    if (!isActiveRaidStatus(game.status)) return;

    const bots = safeArr(latestPlayers).filter((p) => !!p?.isBot);
    if (!bots.length) return;

    let workNeeded = false;
    if (game.phase === "MOVE") {
      workNeeded = bots.some((b) => {
        const moved = safeArr(game.movedPlayerIds);
        return isInYardLocal(b) && !moved.includes(b.id);
      });
    } else if (game.phase === "ACTIONS") {
      const turnId = currentOpsPlayerId(game);
      workNeeded = !!turnId && bots.some((b) => b.id === turnId);
    } else if (game.phase === "DECISION") {
      workNeeded = bots.some((b) => isInYardLocal(b) && !b.decision);
    } else {
      return;
    }
    if (!workNeeded) return;

    busy = true;
    try {
      const gotLock = await acquireBotLock({ db, gameId, runnerId, hostUid });
      if (!gotLock) return;

      if (game.phase === "MOVE") {
        for (const bot of bots) {
          const moved = safeArr(game.movedPlayerIds);
          if (!isInYardLocal(bot)) continue;
          if (moved.includes(bot.id)) continue;
          await botDoMove({ db, gameId, addLog, botId: bot.id });
        }
        return;
      }

      if (game.phase === "ACTIONS") {
        const turnId = currentOpsPlayerId(game);
        const bot = bots.find((b) => b.id === turnId);
        if (!bot) return;
        await botDoOpsTurn({ db, gameId, addLog, botId: bot.id, latestPlayers });
        return;
      }

      if (game.phase === "DECISION") {
        for (const bot of bots) {
          if (!isInYardLocal(bot)) continue;
          if (bot.decision) continue;
          await botDoDecision({ db, gameId, addLog, botId: bot.id });
        }
      }
    } finally {
      busy = false;
    }
  }

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) return;
    latestGame = { id: snap.id, ...snap.data() };
    scheduleTick();
  });

  onSnapshot(playersRef, (qs) => {
    latestPlayers = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    scheduleTick();
  });

  console.log("[BOT-RUNNER] gestart voor game", gameId);
}

export async function addBotToCurrentGame({ db, gameId, denColors }) {
  if (!gameId) throw new Error("Geen actief spel (gameId ontbreekt).");
  if (!Array.isArray(denColors) || !denColors.length) throw new Error("denColors ontbreekt.");

  const gSnap = await getDoc(doc(db, "games", gameId));
  if (!gSnap.exists()) throw new Error("Game niet gevonden");
  const g = gSnap.data();

  const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
  const players = [];
  playersSnap.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));

  const maxJoin = players.reduce(
    (m, p) => (typeof p.joinOrder === "number" ? Math.max(m, p.joinOrder) : m),
    -1
  );
  const joinOrder = maxJoin + 1;
  const color = denColors[joinOrder % denColors.length];

  let actionDeck = safeArr(g.actionDeck).slice();
  const hand = [];
  for (let i = 0; i < 3; i++) if (actionDeck.length) hand.push(actionDeck.pop());

  await addDoc(collection(db, "games", gameId, "players"), {
    name: `BOT Fox ${joinOrder + 1}`,
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
    opsActionPlayedRound: null,
  });

  await updateDoc(doc(db, "games", gameId), { botsEnabled: true, actionDeck });
}
