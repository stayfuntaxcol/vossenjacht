// ./bots/botRunner.js
// Autonome bots voor Vossenjacht — werkt met host.js flow:
// MOVE -> ACTIONS (OPS) -> DECISION
// ACTIONS eindigt pas als opsConsecutivePasses >= actieve spelers (of opsLocked)

import {
  doc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
  arrayUnion,
  runTransaction,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { pickProfile, weightedPick } from "./botProfiles.js";
import { getEventById } from "../cards.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randBetween(min, max) {
  const a = Number(min) || 450;
  const b = Number(max) || 1200;
  return Math.floor(a + Math.random() * Math.max(0, b - a));
}

function normalizeCardName(card) {
  if (!card) return "";
  if (typeof card === "string") return card.trim();
  if (typeof card?.name === "string") return card.name.trim();
  return "";
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function mergeRoundFlags(game) {
  const base = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],       // kan ook boolean zijn in oudere games
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
    holdStill: {},
  };
  const f = { ...base, ...(game?.flagsRound || {}) };

  // compat: noPeek kan boolean zijn (Molting Mask in oudere code)
  if (f.noPeek === true) f.noPeekAll = true;
  else f.noPeekAll = false;

  // compat: noPeek array (No-Go Zone)
  if (!Array.isArray(f.noPeek)) f.noPeek = [];

  // ensure objects
  if (!f.denImmune || typeof f.denImmune !== "object") f.denImmune = {};
  if (!f.followTail || typeof f.followTail !== "object") f.followTail = {};
  if (!f.holdStill || typeof f.holdStill !== "object") f.holdStill = {};
  if (!Array.isArray(f.predictions)) f.predictions = [];
  if (!Array.isArray(f.scentChecks)) f.scentChecks = [];

  return f;
}

function isBotActive(p) {
  return p?.isBot === true && p?.inYard !== false && !p?.dashed;
}

function canMoveNow(game, playerId) {
  if (!game) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "MOVE") return false;
  if (game.raidEndedByRooster) return false;
  const moved = Array.isArray(game.movedPlayerIds) ? game.movedPlayerIds : [];
  return !moved.includes(playerId);
}

function canDecideNow(game, p) {
  if (!game || !p) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "DECISION") return false;
  if (game.raidEndedByRooster) return false;
  return !p.decision;
}

function canOpsNow(game, pId) {
  if (!game) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "ACTIONS") return false;
  if (game.raidEndedByRooster) return false;
  const order = Array.isArray(game.opsTurnOrder) ? game.opsTurnOrder : [];
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return order.length > 0 && order[idx] === pId;
}

function nextOpsIndex(game) {
  const order = Array.isArray(game.opsTurnOrder) ? game.opsTurnOrder : [];
  if (!order.length) return 0;
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

async function writeAction(db, gameId, game, player, phase, choice, extra = null) {
  const actionsCol = collection(db, "games", gameId, "actions");
  const payload = {
    round: Number(game?.round || 0),
    phase,
    playerId: player.id,
    playerName: player.name || "",
    choice,
    createdAt: serverTimestamp(),
  };
  if (extra) payload.extra = extra;
  await addDoc(actionsCol, payload);
}

function lootPoints(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);
}

function pickBestTargetPlayerId(botId, players) {
  const candidates = (players || []).filter(
    (x) => x?.id && x.id !== botId && x.inYard !== false && !x.dashed
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => lootPoints(b) - lootPoints(a));
  return candidates[0].id;
}

function pickTwoHiddenIndexes(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const revealed = Array.isArray(game?.eventRevealed)
    ? game.eventRevealed
    : track.map(() => false);

  const hidden = [];
  for (let i = 0; i < track.length; i++) {
    if (!revealed[i]) hidden.push(i);
  }
  if (hidden.length < 2) return null;

  // slim: pak vaak "next" + "later"
  const nextIdx = typeof game?.eventIndex === "number" ? game.eventIndex : hidden[0];
  const a = hidden.includes(nextIdx) ? nextIdx : hidden[0];
  let b = hidden[hidden.length - 1];
  if (b === a) b = hidden[0];
  return [a, b];
}

function pickScoutIndex(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const eventIndex = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  if (!track.length) return null;

  const flags = mergeRoundFlags(game);
  if (flags.scatter) return null;
  if (flags.noPeekAll) return null;

  const candidates = [];
  for (let i = eventIndex; i < track.length; i++) {
    const pos = i + 1;
    if (!flags.noPeek.includes(pos)) candidates.push(i);
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function shuffleFutureTrack(game) {
  const track = Array.isArray(game?.eventTrack) ? [...game.eventTrack] : [];
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  if (track.length <= 1) return null;

  const locked = track.slice(0, idx);
  const future = track.slice(idx);
  if (future.length <= 1) return null;

  const shuffledFuture = shuffleArray(future);
  return [...locked, ...shuffledFuture];
}

function pickFutureEventIdForPrediction(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  if (!track.length || idx >= track.length) return null;

  if (Math.random() < 0.75) return track[idx];
  const future = track.slice(idx).filter(Boolean);
  if (!future.length) return null;
  return future[Math.floor(Math.random() * future.length)];
}

// ---- exports: BOT toevoegen ----
export async function addBotToCurrentGame({ db, gameId, denColors = ["RED","BLUE","GREEN","YELLOW"] }) {
  if (!gameId) throw new Error("addBotToCurrentGame: missing gameId");

  const gRef = doc(db, "games", gameId);
  const gSnap = await getDoc(gRef);
  if (!gSnap.exists()) throw new Error("Game not found");

  const g = gSnap.data();
  const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const maxJoin = players.reduce(
    (m, p) => (typeof p.joinOrder === "number" ? Math.max(m, p.joinOrder) : m),
    -1
  );
  const joinOrder = maxJoin + 1;
  const color = denColors[joinOrder % denColors.length] || "RED";

  let actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
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
    botProfile: "DEFAULT",
    botDelayMin: 450,
    botDelayMax: 1200,
  });

  await updateDoc(gRef, { botsEnabled: true, actionDeck });
}

// ---- BOT RUNNER ----
export function startBotRunner({ db, gameId, addLog = null, isBoardOnly = false, hostUid = null }) {
  if (isBoardOnly) {
    console.log("[BOT-RUNNER] board mode => bots disabled");
    return () => {};
  }

  const gameRef = doc(db, "games", gameId);
  const playersRef = collection(db, "games", gameId, "players");

  let game = null;
  let players = [];
  let running = false;

  // ✅ fix: ACTIONS key moet per TURN uniek zijn, niet per bot
  const inFlight = new Map(); // key -> timestamp
  function remember(key) {
    inFlight.set(key, Date.now());
    // prune
    const now = Date.now();
    for (const [k, t] of inFlight.entries()) {
      if (now - t > 20000) inFlight.delete(k);
    }
  }
  function seen(key) {
    const t = inFlight.get(key);
    return t != null && (Date.now() - t) < 20000;
  }

  async function logChoice({ round, phase, playerId, playerName, choice, message, payload }) {
    // legacy actions log (voor roundInfo)
    await addDoc(collection(db, "games", gameId, "actions"), {
      round,
      phase,
      playerId,
      playerName,
      choice,
      createdAt: serverTimestamp(),
      extra: payload || null,
    });

    // community log
    if (typeof addLog === "function") {
      await addLog(gameId, {
        round,
        phase,
        kind: "BOT",
        type: "CHOICE",
        actorId: playerId,
        playerId,
        playerName,
        choice,
        payload: payload || null,
        message: message || `${playerName || "BOT"}: ${choice}`,
      });
    }
  }

  async function tick() {
    if (running) return;
    if (!game) return;
    if (game.botsEnabled === false) return;
    if (game.status !== "round") return;

    running = true;
    try {
      const bots = players.filter(isBotActive);

      // ===== MOVE =====
      if (game.phase === "MOVE") {
        for (const me of bots) {
          if (!canMoveNow(game, me.id)) continue;

          const key = `${game.round}|MOVE|${me.id}`;
          if (seen(key)) continue;
          remember(key);

          await sleep(randBetween(me.botDelayMin, me.botDelayMax));

          const freshSnap = await getDoc(gameRef);
          if (!freshSnap.exists()) continue;
          const g = freshSnap.data();
          if (!canMoveNow(g, me.id)) continue;

          const profile = pickProfile(me.botProfile);
          const move = weightedPick(profile.moveWeights);

          const playerRef = doc(db, "games", gameId, "players", me.id);

          if (move === "SNATCH") {
            const lootDeck = Array.isArray(g.lootDeck) ? [...g.lootDeck] : [];
            if (!lootDeck.length) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await logChoice({
                round: Number(g.round || 0),
                phase: "MOVE",
                playerId: me.id,
                playerName: me.name || "BOT",
                choice: "MOVE_SNATCH_EMPTY",
                message: "BOT deed SNATCH maar loot deck is leeg",
              });
              continue;
            }
            const card = lootDeck.pop();
            const loot = Array.isArray(me.loot) ? [...me.loot] : [];
            loot.push(card);

            await updateDoc(playerRef, { loot });
            await updateDoc(gameRef, { lootDeck, movedPlayerIds: arrayUnion(me.id) });

            await logChoice({
              round: Number(g.round || 0),
              phase: "MOVE",
              playerId: me.id,
              playerName: me.name || "BOT",
              choice: "MOVE_SNATCH_FROM_DECK",
              message: `BOT deed SNATCH (${card?.t || "Loot"} ${card?.v ?? ""})`,
              payload: { lootCard: card || null },
            });
          }

          if (move === "FORAGE") {
            const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
            const hand = Array.isArray(me.hand) ? [...me.hand] : [];
            let drawn = 0;
            for (let i = 0; i < 2; i++) {
              if (!actionDeck.length) break;
              hand.push(actionDeck.pop());
              drawn++;
            }
            await updateDoc(playerRef, { hand });
            await updateDoc(gameRef, { actionDeck, movedPlayerIds: arrayUnion(me.id) });

            await logChoice({
              round: Number(g.round || 0),
              phase: "MOVE",
              playerId: me.id,
              playerName: me.name || "BOT",
              choice: `MOVE_FORAGE_${drawn}cards`,
              message: `BOT deed FORAGE (${drawn} kaart(en))`,
            });
          }

          if (move === "SCOUT") {
            const idx = pickScoutIndex(g);
            if (idx === null) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await logChoice({
                round: Number(g.round || 0),
                phase: "MOVE",
                playerId: me.id,
                playerName: me.name || "BOT",
                choice: "MOVE_SCOUT_BLOCKED",
                message: "BOT deed SCOUT maar dit is geblokkeerd (Scatter/Molting/No-Go)",
              });
              continue;
            }
            const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
            const eventId = track[idx];
            await updateDoc(playerRef, {
              scoutPeek: { round: Number(g.round || 0), index: idx, eventId },
            });
            await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });

            await logChoice({
              round: Number(g.round || 0),
              phase: "MOVE",
              playerId: me.id,
              playerName: me.name || "BOT",
              choice: `MOVE_SCOUT_${idx + 1}`,
              message: `BOT deed SCOUT (pos ${idx + 1})`,
              payload: { index: idx, eventId, title: getEventById(eventId)?.title || eventId },
            });
          }

          if (move === "SHIFT") {
            const flags = mergeRoundFlags(g);
            if (flags.lockEvents) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await logChoice({
                round: Number(g.round || 0),
                phase: "MOVE",
                playerId: me.id,
                playerName: me.name || "BOT",
                choice: "MOVE_SHIFT_BLOCKED",
                message: "BOT wilde SHIFT maar events zijn gelocked (Burrow Beacon)",
              });
              continue;
            }
            const pair = pickTwoHiddenIndexes(g);
            if (!pair) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await logChoice({
                round: Number(g.round || 0),
                phase: "MOVE",
                playerId: me.id,
                playerName: me.name || "BOT",
                choice: "MOVE_SHIFT_NO_TARGET",
                message: "BOT wilde SHIFT maar geen 2 hidden targets",
              });
              continue;
            }
            const track = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
            [track[pair[0]], track[pair[1]]] = [track[pair[1]], track[pair[0]]];

            await updateDoc(gameRef, { eventTrack: track, movedPlayerIds: arrayUnion(me.id) });

            await logChoice({
              round: Number(g.round || 0),
              phase: "MOVE",
              playerId: me.id,
              playerName: me.name || "BOT",
              choice: `MOVE_SHIFT_${pair[0] + 1}<->${pair[1] + 1}`,
              message: `BOT deed SHIFT (${pair[0] + 1} ↔ ${pair[1] + 1})`,
              payload: { i1: pair[0], i2: pair[1] },
            });
          }
        }
      }

      // ===== ACTIONS (OPS) =====
      if (game.phase === "ACTIONS") {
        const order = Array.isArray(game.opsTurnOrder) ? game.opsTurnOrder : [];
        const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
        const currentId = order[idx];

        // alleen als huidige beurt een bot is
        const me = bots.find((p) => p.id === currentId);
        if (me && canOpsNow(game, me.id)) {
          // ✅ key per turn (idx + passes + player)
          const key = `${game.round}|ACTIONS|${idx}|${Number(game.opsConsecutivePasses || 0)}|${currentId}`;
          if (!seen(key)) {
            remember(key);

            await sleep(randBetween(me.botDelayMin, me.botDelayMax));

            // transaction: bot speelt of passed en schuift opsTurnIndex door
            const res = await runTransaction(db, async (tx) => {
              const gSnap = await tx.get(gameRef);
              const pRef = doc(db, "games", gameId, "players", me.id);
              const pSnap = await tx.get(pRef);
              if (!gSnap.exists() || !pSnap.exists()) return null;

              const g = gSnap.data();
              const p = { id: pSnap.id, ...pSnap.data() };

              if (!canOpsNow(g, me.id)) return null;

              const flags = mergeRoundFlags(g);

              const roundNum = Number(g.round || 0);
              const alreadyPlayed = Number(p.opsActionPlayedRound || 0) === roundNum;

              const orderNow = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder : [];
              const idxNow = typeof g.opsTurnIndex === "number" ? g.opsTurnIndex : 0;
              const nextIndex = (idxNow + 1) % (orderNow.length || 1);

              // opsLocked -> altijd PASS (maar wel doorschuiven + passes omhoog)
              if (flags.opsLocked) {
                const passes = Number(g.opsConsecutivePasses || 0) + 1;
                tx.update(gameRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });
                return { kind: "PASS", reason: "OPS_LOCKED", roundNum, nextIndex, passes };
              }

              const hand = Array.isArray(p.hand) ? [...p.hand] : [];
              let actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
              let discard = Array.isArray(g.actionDiscard) ? [...g.actionDiscard] : [];

              // als bot al 1 kaart gespeeld heeft deze ronde => altijd PASS
              if (alreadyPlayed) {
                const passes = Number(g.opsConsecutivePasses || 0) + 1;
                tx.update(gameRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });
                return { kind: "PASS", reason: "ALREADY_PLAYED", roundNum, nextIndex, passes };
              }

              // play chance (profiel + hand bonus)
              const profile = pickProfile(p.botProfile);
              const base = Number(profile.actionPlayChance ?? 0.65);
              const handBonus = Math.min(0.25, Math.max(0, (hand.length - 1) * 0.08));
              const playProb = Math.min(0.95, base + handBonus);

              const willTryPlay = hand.length > 0 && Math.random() < playProb;
              if (!willTryPlay) {
                const passes = Number(g.opsConsecutivePasses || 0) + 1;
                tx.update(gameRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });
                return { kind: "PASS", reason: "CHOSE_PASS", roundNum, nextIndex, passes };
              }

              // kies een speelbare kaart uit hand (simple but safe)
              const names = hand.map(normalizeCardName).filter(Boolean);

              const pickFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];
              const bestTargetId = pickBestTargetPlayerId(me.id, players);

              // filter op speelbaar
              const playable = names.filter((n) => {
                if (n === "Pack Tinker" || n === "Kick Up Dust") return !flags.lockEvents;
                if (n === "Follow the Tail" || n === "Hold Still" || n === "Mask Swap") return !!bestTargetId;
                return true;
              });

              if (!playable.length) {
                const passes = Number(g.opsConsecutivePasses || 0) + 1;
                tx.update(gameRef, { opsTurnIndex: nextIndex, opsConsecutivePasses: passes });
                return { kind: "PASS", reason: "NO_PLAYABLE", roundNum, nextIndex, passes };
              }

              const cardName = pickFrom(playable);

              // consume 1 instance
              const removeIdx = hand.findIndex((c) => normalizeCardName(c) === cardName);
              if (removeIdx >= 0) hand.splice(removeIdx, 1);

              discard.push({ name: cardName, by: me.id, round: roundNum, at: Date.now() });

              // standaard replacement draw
              if (actionDeck.length) hand.push(actionDeck.pop());

              const extraGameUpdates = {};

              // effects
              if (cardName === "Burrow Beacon") flags.lockEvents = true;
              if (cardName === "Scatter!") flags.scatter = true;

              if (cardName === "Den Signal") {
                const myColor = String(p.color || "").toUpperCase();
                if (myColor) flags.denImmune[myColor] = true;
              }

              if (cardName === "Scent Check") {
                if (!flags.scentChecks.includes(me.id)) flags.scentChecks.push(me.id);
              }

              if (cardName === "Follow the Tail") {
                const ft = { ...(flags.followTail || {}) };
                ft[me.id] = bestTargetId;
                flags.followTail = ft;
              }

              if (cardName === "Hold Still") {
                const hs = { ...(flags.holdStill || {}) };
                hs[bestTargetId] = true;
                flags.holdStill = hs;
              }

              if (cardName === "Mask Swap") {
                const tRef = doc(db, "games", gameId, "players", bestTargetId);
                const tSnap = await tx.get(tRef);
                if (tSnap.exists()) {
                  const t = { id: tSnap.id, ...tSnap.data() };
                  const a = String(p.color || "").toUpperCase();
                  const b = String(t.color || "").toUpperCase();
                  if (a && b && a !== b) {
                    tx.update(tRef, { color: a });
                    tx.update(pRef, { color: b }); // swap bot
                  }
                }
              }

              if (cardName === "Molting Mask") {
                // block all peeks this round (compat: boolean)
                flags.noPeekAll = true;
                flags.noPeek = flags.noPeek; // keep array if any
                // schrijf terug als boolean true in flagsRound.noPeek om compat te houden
                extraGameUpdates.flagsNoPeekBoolean = true;
              }

              if (cardName === "No-Go Zone") {
                // lock ops (fase versnellen)
                flags.opsLocked = true;
                extraGameUpdates.opsConsecutivePasses = orderNow.length; // force allow continue
              }

              if (cardName === "Alpha Call") {
                if (actionDeck.length) hand.push(actionDeck.pop());
              }

              if (cardName === "Nose for Trouble") {
                const eventId = pickFutureEventIdForPrediction(g);
                if (eventId) {
                  const filtered = (flags.predictions || []).filter((x) => x?.playerId !== me.id);
                  filtered.push({ playerId: me.id, eventId, round: roundNum, at: Date.now() });
                  flags.predictions = filtered;
                }
              }

              if (cardName === "Pack Tinker") {
                const pair = pickTwoHiddenIndexes(g);
                if (pair) {
                  const trackNow = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
                  [trackNow[pair[0]], trackNow[pair[1]]] = [trackNow[pair[1]], trackNow[pair[0]]];
                  extraGameUpdates.eventTrack = trackNow;
                  extraGameUpdates.lastPackTinker = { by: me.id, i1: pair[0], i2: pair[1], round: roundNum, at: Date.now() };
                }
              }

              if (cardName === "Kick Up Dust") {
                const newTrack = shuffleFutureTrack(g);
                if (newTrack) extraGameUpdates.eventTrack = newTrack;
              }

              // update player + game
              tx.update(pRef, { hand, opsActionPlayedRound: roundNum });
              tx.update(gameRef, {
                actionDeck,
                actionDiscard: discard,
                flagsRound: {
                  ...flags,
                  // compat: als Molting Mask gespeeld is, zet noPeek boolean op true
                  ...(extraGameUpdates.flagsNoPeekBoolean ? { noPeek: true } : {}),
                },
                opsTurnIndex: nextIndex,
                opsConsecutivePasses: 0,
                ...extraGameUpdates,
              });

              return { kind: "PLAY", cardName, roundNum, nextIndex };
            });

            if (res) {
              if (res.kind === "PLAY") {
                await logChoice({
                  round: res.roundNum,
                  phase: "ACTIONS",
                  playerId: me.id,
                  playerName: me.name || "BOT",
                  choice: `ACTION_PLAY_${res.cardName}`,
                  message: `BOT speelt ${res.cardName}`,
                });
              } else {
                await logChoice({
                  round: res.roundNum,
                  phase: "ACTIONS",
                  playerId: me.id,
                  playerName: me.name || "BOT",
                  choice: "ACTION_PASS",
                  message: `BOT kiest PASS (${res.reason})`,
                  payload: { reason: res.reason },
                });
              }
            }
          }
        }
      }

      // ===== DECISION =====
      if (game.phase === "DECISION") {
        for (const me of bots) {
          if (!canDecideNow(game, me)) continue;

          const key = `${game.round}|DECISION|${me.id}`;
          if (seen(key)) continue;
          remember(key);

          await sleep(randBetween(me.botDelayMin, me.botDelayMax));

          const freshSnap = await getDoc(gameRef);
          if (!freshSnap.exists()) continue;
          const g = freshSnap.data();

          // reload player doc for latest
          const pSnap = await getDoc(doc(db, "games", gameId, "players", me.id));
          if (!pSnap.exists()) continue;
          const p = { id: pSnap.id, ...pSnap.data() };
          if (!canDecideNow(g, p)) continue;

          const profile = pickProfile(p.botProfile);
          const decision = profile.decision({ game: g, me: p, players });

          const upd = { decision };
          if (decision === "BURROW" && !p.burrowUsed) upd.burrowUsed = true;

          await updateDoc(doc(db, "games", gameId, "players", me.id), upd);

          await logChoice({
            round: Number(g.round || 0),
            phase: "DECISION",
            playerId: me.id,
            playerName: me.name || "BOT",
            choice: `DECISION_${decision}`,
            message: `BOT kiest ${decision}`,
          });
        }
      }
    } finally {
      running = false;
    }
  }

  // ---- snapshots + fallback interval ----
  const unsubGame = onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) return;
    game = { id: snap.id, ...snap.data() };
    tick();
  });

  const unsubPlayers = onSnapshot(playersRef, (qs) => {
    players = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    tick();
  });

  const interval = setInterval(() => tick(), 900);

  console.log("[BOT-RUNNER] gestart voor game", gameId);

  return function stop() {
    try { unsubGame(); } catch {}
    try { unsubPlayers(); } catch {}
    try { clearInterval(interval); } catch {}
    game = null;
    players = [];
  };
}
