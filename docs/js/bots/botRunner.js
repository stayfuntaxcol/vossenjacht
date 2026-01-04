// ./bots/botRunner.js

import {
  doc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  serverTimestamp,
  onSnapshot,
  arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { pickProfile, weightedPick } from "./botProfiles.js";
import { getEventById } from "../cards.js";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randBetween(min, max) {
  const a = Number(min) || 500;
  const b = Number(max) || 1400;
  return Math.floor(a + Math.random() * Math.max(0, b - a));
}

function mergeRoundFlags(game) {
  const base = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
  };
  return { ...base, ...(game?.flagsRound || {}) };
}

function isBotActive(p) {
  return p.isBot === true && p.inYard !== false && !p.dashed;
}

function canMoveNow(game, playerId) {
  if (!game) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "MOVE") return false;
  if (game.raidEndedByRooster) return false;
  const moved = game.movedPlayerIds || [];
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

  const order = game.opsTurnOrder || [];
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return order.length && order[idx] === pId;
}

function nextOpsIndex(game) {
  const order = game.opsTurnOrder || [];
  if (!order.length) return 0;
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

async function writeAction(db, gameId, game, player, phase, choice, extra = null) {
  const actionsCol = collection(db, "games", gameId, "actions");
  const payload = {
    round: game.round || 0,
    phase,
    playerId: player.id,
    playerName: player.name || "",
    choice,
    createdAt: serverTimestamp(),
  };
  if (extra) payload.extra = extra;
  await addDoc(actionsCol, payload);
}

function pickTwoFutureIndexes(game) {
  const track = Array.isArray(game.eventTrack) ? game.eventTrack : [];
  const revealed = Array.isArray(game.eventRevealed) ? game.eventRevealed : track.map(() => false);
  const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;

  const future = [];
  for (let i = eventIndex; i < track.length; i++) {
    if (!revealed[i]) future.push(i);
  }
  if (future.length < 2) return null;

  const a = future[Math.floor(Math.random() * future.length)];
  let b = a;
  while (b === a) b = future[Math.floor(Math.random() * future.length)];
  return [a, b];
}

function pickScoutIndex(game) {
  const track = Array.isArray(game.eventTrack) ? game.eventTrack : [];
  const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;
  if (!track.length) return null;

  const flags = mergeRoundFlags(game);
  if (flags.scatter) return null;

  const candidates = [];
  for (let i = eventIndex; i < track.length; i++) {
    const pos = i + 1; // 1-based
    if (!flags.noPeek?.includes(pos)) candidates.push(i);
  }
  if (!candidates.length) return null;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function tryPlayActionCard(db, gameId, gameRef, playerRef, game, me) {
  const flags = mergeRoundFlags(game);

  // opsLocked => alleen PASS
  if (flags.opsLocked) return { played: false, reason: "OPS_LOCKED" };

  const hand = Array.isArray(me.hand) ? [...me.hand] : [];
  if (!hand.length) return { played: false, reason: "NO_HAND" };

  const profile = pickProfile(me.botProfile);
  if (Math.random() > (profile.actionPlayChance ?? 0.65)) {
    return { played: false, reason: "CHOSE_PASS" };
  }

  // probeer een “effect-kaart” die we zeker kunnen afhandelen
  for (let tries = 0; tries < Math.min(3, hand.length); tries++) {
    const idx = Math.floor(Math.random() * hand.length);
    const card = hand[idx];
    const name = String(card?.name || "").trim();
    if (!name) continue;

    let ok = false;

    if (name === "Scatter!") {
      flags.scatter = true;
      ok = true;
      await updateDoc(gameRef, { flagsRound: flags });
    }

    if (name === "Burrow Beacon") {
      flags.lockEvents = true;
      ok = true;
      await updateDoc(gameRef, { flagsRound: flags });
    }

    if (name === "Hold Still") {
      flags.opsLocked = true;
      ok = true;
      await updateDoc(gameRef, { flagsRound: flags });
    }

    if (name === "No-Go Zone") {
      const track = Array.isArray(game.eventTrack) ? game.eventTrack : [];
      const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;
      if (track.length) {
        const pos = Math.floor(1 + eventIndex + Math.random() * Math.max(1, track.length - eventIndex));
        const noPeek = Array.isArray(flags.noPeek) ? [...flags.noPeek] : [];
        if (!noPeek.includes(pos)) noPeek.push(pos);
        flags.noPeek = noPeek;
        ok = true;
        await updateDoc(gameRef, { flagsRound: flags });
      }
    }

    if (name === "Den Signal") {
      const c = String(me.color || "RED").toUpperCase();
      flags.denImmune = flags.denImmune || {};
      flags.denImmune[c] = true;
      ok = true;
      await updateDoc(gameRef, { flagsRound: flags });
    }

    if (name === "Molting Mask") {
      const colors = ["RED", "BLUE", "GREEN", "YELLOW"];
      const cur = String(me.color || "").toUpperCase();
      const pool = colors.filter((x) => x !== cur);
      const newColor = pool.length ? pool[Math.floor(Math.random() * pool.length)] : "RED";
      ok = true;
      await updateDoc(playerRef, { color: newColor });
    }

    if (name === "Pack Tinker") {
      if (!flags.lockEvents) {
        const pair = pickTwoFutureIndexes(game);
        if (pair) {
          const track = Array.isArray(game.eventTrack) ? [...game.eventTrack] : [];
          [track[pair[0]], track[pair[1]]] = [track[pair[1]], track[pair[0]]];
          ok = true;
          await updateDoc(gameRef, { eventTrack: track });
        }
      }
    }

    if (!ok) continue;

    // consume kaart
    hand.splice(idx, 1);
    await updateDoc(playerRef, { hand });

    return { played: true, cardName: name };
  }

  return { played: false, reason: "NO_USABLE_CARD" };
}

export function startBotRunner({ db, gameId, addLog = null, isBoardOnly = false }) {
  if (isBoardOnly) return; // ✅ bots niet op “board” scherm

  const gameRef = doc(db, "games", gameId);
  const playersRef = collection(db, "games", gameId, "players");

  let game = null;
  let players = [];
  let running = false;

  const inFlight = new Set();
  const keyFor = (botId) => `${game?.round ?? 0}|${game?.phase ?? "?"}|${botId}`;

  async function tick() {
    if (running) return;
    if (!game) return;
    if (game.botsEnabled === false) return;

    running = true;
    try {
      const bots = players.filter(isBotActive);

      // MOVE
      if (game.phase === "MOVE" && game.status === "round") {
        for (const me of bots) {
          if (!canMoveNow(game, me.id)) continue;

          const k = keyFor(me.id);
          if (inFlight.has(k)) continue;
          inFlight.add(k);

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
              await writeAction(db, gameId, g, me, "MOVE", "MOVE_SNATCH_EMPTY");
              continue;
            }
            const card = lootDeck.pop();
            const loot = Array.isArray(me.loot) ? [...me.loot] : [];
            loot.push(card);

            await updateDoc(playerRef, { loot });
            await updateDoc(gameRef, { lootDeck, movedPlayerIds: arrayUnion(me.id) });
            await writeAction(db, gameId, g, me, "MOVE", "MOVE_SNATCH_FROM_DECK", { lootCard: card });
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
            await writeAction(db, gameId, g, me, "MOVE", `MOVE_FORAGE_${drawn}cards`);
          }

          if (move === "SCOUT") {
            const idx = pickScoutIndex(g);
            if (idx === null) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await writeAction(db, gameId, g, me, "MOVE", "MOVE_SCOUT_BLOCKED");
              continue;
            }
            const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
            const eventId = track[idx];
            await updateDoc(playerRef, { scoutPeek: { round: g.round || 0, index: idx, eventId } });
            await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
            await writeAction(db, gameId, g, me, "MOVE", `MOVE_SCOUT_${idx + 1}`, {
              title: getEventById(eventId)?.title || eventId,
            });
          }

          if (move === "SHIFT") {
            const flags = mergeRoundFlags(g);
            if (flags.lockEvents) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await writeAction(db, gameId, g, me, "MOVE", "MOVE_SHIFT_BLOCKED");
              continue;
            }
            const pair = pickTwoFutureIndexes(g);
            if (!pair) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await writeAction(db, gameId, g, me, "MOVE", "MOVE_SHIFT_NO_TARGET");
              continue;
            }
            const track = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
            [track[pair[0]], track[pair[1]]] = [track[pair[1]], track[pair[0]]];

            await updateDoc(gameRef, { eventTrack: track, movedPlayerIds: arrayUnion(me.id) });
            await writeAction(db, gameId, g, me, "MOVE", `MOVE_SHIFT_${pair[0] + 1}<->${pair[1] + 1}`);
          }
        }
      }

      // ACTIONS (OPS turn)
      if (game.phase === "ACTIONS" && game.status === "round") {
        const order = game.opsTurnOrder || [];
        const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
        const currentId = order[idx];
        const me = bots.find((p) => p.id === currentId);

        if (me && canOpsNow(game, me.id)) {
          const k = keyFor(me.id);
          if (!inFlight.has(k)) {
            inFlight.add(k);
            await sleep(randBetween(me.botDelayMin, me.botDelayMax));

            const freshSnap = await getDoc(gameRef);
            if (!freshSnap.exists()) return;
            const g = freshSnap.data();
            if (!canOpsNow(g, me.id)) return;

            const playerRef = doc(db, "games", gameId, "players", me.id);

            const res = await tryPlayActionCard(db, gameId, gameRef, playerRef, g, me);

            if (res.played) {
              await updateDoc(gameRef, {
                opsTurnIndex: nextOpsIndex(g),
                opsConsecutivePasses: 0,
              });
              await writeAction(db, gameId, g, me, "ACTIONS", `ACTION_${res.cardName}`);
            } else {
              await updateDoc(gameRef, {
                opsTurnIndex: nextOpsIndex(g),
                opsConsecutivePasses: (g.opsConsecutivePasses || 0) + 1,
              });
              await writeAction(db, gameId, g, me, "ACTIONS", "ACTION_PASS", { reason: res.reason });
            }
          }
        }
      }

      // DECISION
      if (game.phase === "DECISION" && game.status === "round") {
        for (const me of bots) {
          if (!canDecideNow(game, me)) continue;

          const k = keyFor(me.id);
          if (inFlight.has(k)) continue;
          inFlight.add(k);

          await sleep(randBetween(me.botDelayMin, me.botDelayMax));

          const freshSnap = await getDoc(gameRef);
          if (!freshSnap.exists()) continue;
          const g = freshSnap.data();

          const profile = pickProfile(me.botProfile);
          const decision = profile.decision({ game: g, me, players });

          const playerRef = doc(db, "games", gameId, "players", me.id);

          const upd = { decision };
          if (decision === "BURROW" && !me.burrowUsed) upd.burrowUsed = true;

          await updateDoc(playerRef, upd);
          await writeAction(db, gameId, g, me, "DECISION", `DECISION_${decision}`);
        }
      }
    } finally {
      running = false;
    }
  }

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) return;
    game = { id: snap.id, ...snap.data() };
    tick();
  });

  onSnapshot(playersRef, (qs) => {
    players = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    tick();
  });

  console.log("[BOT-RUNNER] gestart voor game", gameId);
}
