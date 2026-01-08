// docs/js/bots/botRunner.js
import {
  doc, getDoc, getDocs, collection, addDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

export async function addBotToCurrentGame({ db, gameId, denColors }) {
  if (!gameId) throw new Error("Geen gameId");

  const gSnap = await getDoc(doc(db, "games", gameId));
  if (!gSnap.exists()) throw new Error("Game niet gevonden");
  const g = gSnap.data();

  const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
  const players = [];
  playersSnap.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));

  const maxJoin = players.reduce((m, p) => (typeof p.joinOrder === "number" ? Math.max(m, p.joinOrder) : m), -1);
  const joinOrder = maxJoin + 1;
  const color = denColors[joinOrder % denColors.length];

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
  });

  await updateDoc(doc(db, "games", gameId), { botsEnabled: true, actionDeck });
}

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
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { pickProfile, weightedPick } from "./botProfiles.js";
import { getEventById } from "../cards.js";

// ---------------- utils ----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randBetween(min, max) {
  const a = Number(min) || 500;
  const b = Number(max) || 1400;
  return Math.floor(a + Math.random() * Math.max(0, b - a));
}
const safeArr = (x) => (Array.isArray(x) ? x : []);
const safeObj = (x) => (x && typeof x === "object" ? x : {});
const str = (x) => (x == null ? "" : String(x));

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
  return p?.isBot === true && p.inYard !== false && !p.dashed;
}

// ---------------- phase guards ----------------
function canMoveNow(game, playerId) {
  if (!game) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "MOVE") return false;
  if (game.raidEndedByRooster) return false;
  const moved = safeArr(game.movedPlayerIds);
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

  const order = safeArr(game.opsTurnOrder);
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return order.length && order[idx] === pId;
}

function nextOpsIndex(game) {
  const order = safeArr(game.opsTurnOrder);
  if (!order.length) return 0;
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

// ---------------- optional /log mirror ----------------
// host.js kan addLog uit log.js meegeven; dan schrijven we ook naar games/{gameId}/log
let ADD_LOG = null;

function inferMove(choice) {
  const s = str(choice);
  if (s.includes("MOVE_SNATCH")) return "SNATCH";
  if (s.includes("MOVE_FORAGE")) return "FORAGE";
  if (s.includes("MOVE_SCOUT")) return "SCOUT";
  if (s.includes("MOVE_SHIFT")) return "SHIFT";
  return null;
}
function inferDecision(choice) {
  const m = str(choice).match(/^DECISION_(.+)$/);
  return m ? m[1] : null;
}
function inferCardId(choice) {
  const s = str(choice);
  if (s.startsWith("ACTION_") && s !== "ACTION_PASS") return s.replace("ACTION_", "");
  return null;
}

async function logChoice(gameId, game, player, phase, choice, payload = null) {
  if (typeof ADD_LOG !== "function") return;

  await ADD_LOG(gameId, {
    round: game.round ?? null,
    phase,
    kind: "CHOICE",                 // <-- belangrijk: jouw player.js kijkt hiernaar
    type:
      phase === "MOVE" ? "MOVE_CHOSEN" :
      phase === "ACTIONS" ? (choice === "ACTION_PASS" ? "OPS_PASSED" : "OPS_PLAYED") :
      phase === "DECISION" ? "DECISION_CHOSEN" :
      null,
    actorId: player.id,
    playerId: player.id,
    playerName: player.name || "",
    cardId: inferCardId(choice),
    move: phase === "MOVE" ? inferMove(choice) : null,
    decision: phase === "DECISION" ? inferDecision(choice) : null,
    choice: { choice, payload },
    payload: payload || null,
    message: `${phase}: ${choice}`,
  });
}

// behoud /actions writes (host.js gebruikt dit nog op plekken)
async function writeAction(db, gameId, game, player, phase, choice, extra = null) {
  await logChoice(gameId, game, player, phase, choice, extra);

  const actionsCol = collection(db, "games", gameId, "actions");
  const docData = {
    round: game.round || 0,
    phase,
    playerId: player.id,
    playerName: player.name || "",
    choice,
    createdAt: serverTimestamp(),
  };
  if (extra) docData.extra = extra;
  await addDoc(actionsCol, docData);
}

// ---------------- event helpers ----------------
function pickTwoFutureIndexes(game) {
  const track = safeArr(game.eventTrack);
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
  const track = safeArr(game.eventTrack);
  const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;
  if (!track.length) return null;

  const flags = mergeRoundFlags(game);
  if (flags.scatter) return null;

  const candidates = [];
  for (let i = eventIndex; i < track.length; i++) {
    const pos = i + 1; // 1-based
    if (!safeArr(flags.noPeek).includes(pos)) candidates.push(i);
  }
  if (!candidates.length) return null;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function nextUnrevealedEventId(game) {
  const track = safeArr(game.eventTrack);
  const revealed = Array.isArray(game.eventRevealed) ? game.eventRevealed : track.map(() => false);
  const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;

  for (let i = eventIndex; i < track.length; i++) {
    if (!revealed[i]) return track[i];
  }
  return null;
}

function isDangerEventId(eventId) {
  const id = str(eventId).toUpperCase();
  return id.includes("ROOSTER") || id.includes("CHARGE") || id.includes("DOG") || id.includes("SHEEPDOG");
}

// ---------------- claim (anti double-turn) ----------------
async function claimOpsTurn({ db, gameRef, game, meId }) {
  const turnKey = `${game.round ?? 0}|ACTIONS|${game.opsTurnIndex ?? 0}`;

  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) return { ok: false, reason: "NO_GAME" };
      const g = snap.data();

      if (!canOpsNow(g, meId)) return { ok: false, reason: "NOT_MY_OPS_TURN" };

      const claim = g.opsClaim || null;
      if (claim && claim.turnKey === turnKey && claim.playerId !== meId) {
        return { ok: false, reason: "TURN_ALREADY_CLAIMED" };
      }

      tx.update(gameRef, { opsClaim: { turnKey, playerId: meId, at: serverTimestamp() } });
      return { ok: true, turnKey };
    });
  } catch {
    return { ok: false, reason: "CLAIM_FAILED" };
  }
}

// ---------------- action cards ----------------
async function tryPlayActionCard({ db, gameId, gameRef, playerRef, game, me }) {
  const flags = mergeRoundFlags(game);

  if (flags.opsLocked) return { played: false, reason: "OPS_LOCKED" };

  const hand = safeArr(me.hand).slice();
  if (!hand.length) return { played: false, reason: "NO_HAND" };

  const profile = pickProfile(me.botProfile);
  const playChance = profile.actionPlayChance ?? 0.65;

  const nextEvent = nextUnrevealedEventId(game);
  const danger = isDangerEventId(nextEvent);

  const findIdx = (n) => hand.findIndex((c) => str(c?.name).trim() === n);

  // Trigger: danger + Den Signal
  if (danger) {
    const denIdx = findIdx("Den Signal");
    if (denIdx >= 0) return playCardByIndex({ db, gameId, gameRef, playerRef, game, me, hand, idx: denIdx, flags });
  }

  if (Math.random() > playChance) return { played: false, reason: "CHOSE_PASS" };

  const priority = [
    "Hold Still",
    "Burrow Beacon",
    "Scatter!",
    "Pack Tinker",
    "Kick Up Dust",
    "No-Go Zone",
    "Follow the Tail",
    "Molting Mask",
    "Den Signal",
  ];

  for (const cardName of priority) {
    const idx = findIdx(cardName);
    if (idx >= 0) {
      const res = await playCardByIndex({ db, gameId, gameRef, playerRef, game, me, hand, idx, flags });
      if (res.played) return res;
    }
  }

  // fallback: random tries
  for (let tries = 0; tries < Math.min(3, hand.length); tries++) {
    const idx = Math.floor(Math.random() * hand.length);
    const res = await playCardByIndex({ db, gameId, gameRef, playerRef, game, me, hand, idx, flags });
    if (res.played) return res;
  }

  return { played: false, reason: "NO_USABLE_CARD" };
}

async function playCardByIndex({ db, gameId, gameRef, playerRef, game, me, hand, idx, flags }) {
  const card = hand[idx];
  const name = str(card?.name).trim();
  if (!name) return { played: false, reason: "BAD_CARD" };

  const lockEvents = !!flags.lockEvents;

  let ok = false;
  let extra = null;

  if (name === "Scatter!") {
    flags.scatter = true;
    ok = true;
    extra = { set: "scatter", value: true };
    await updateDoc(gameRef, { flagsRound: { ...flags } });
  }

  if (name === "Burrow Beacon") {
    flags.lockEvents = true;
    ok = true;
    extra = { set: "lockEvents", value: true };
    await updateDoc(gameRef, { flagsRound: { ...flags } });
  }

  if (name === "Hold Still") {
    flags.opsLocked = true;
    ok = true;
    extra = { set: "opsLocked", value: true };
    await updateDoc(gameRef, { flagsRound: { ...flags } });
  }

  if (name === "No-Go Zone") {
    const track = safeArr(game.eventTrack);
    const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;
    if (track.length) {
      const pos = Math.floor(1 + eventIndex + Math.random() * Math.max(1, track.length - eventIndex));
      const noPeek = safeArr(flags.noPeek).slice();
      if (!noPeek.includes(pos)) noPeek.push(pos);
      flags.noPeek = noPeek;
      ok = true;
      extra = { addNoPeekPos: pos };
      await updateDoc(gameRef, { flagsRound: { ...flags } });
    }
  }

  if (name === "Den Signal") {
    const c = str(me.color || "RED").toUpperCase();
    flags.denImmune = safeObj(flags.denImmune);
    flags.denImmune[c] = true;
    ok = true;
    extra = { denImmune: c };
    await updateDoc(gameRef, { flagsRound: { ...flags } });
  }

  if (name === "Molting Mask") {
    const colors = ["RED", "BLUE", "GREEN", "YELLOW"];
    const cur = str(me.color).toUpperCase();
    const pool = colors.filter((x) => x !== cur);
    const newColor = pool.length ? pool[Math.floor(Math.random() * pool.length)] : "RED";
    ok = true;
    extra = { oldColor: cur, newColor };
    await updateDoc(playerRef, { color: newColor });
  }

  if (name === "Pack Tinker") {
    if (!lockEvents) {
      const pair = pickTwoFutureIndexes(game);
      if (pair) {
        const track = safeArr(game.eventTrack).slice();
        [track[pair[0]], track[pair[1]]] = [track[pair[1]], track[pair[0]]];
        ok = true;
        extra = { swap: [pair[0] + 1, pair[1] + 1] };
        await updateDoc(gameRef, { eventTrack: track });
      }
    }
  }

  if (name === "Kick Up Dust") {
    if (!lockEvents) {
      const track = safeArr(game.eventTrack).slice();
      const revealed = Array.isArray(game.eventRevealed) ? game.eventRevealed : track.map(() => false);
      const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;

      const futureIdx = [];
      for (let i = eventIndex; i < track.length; i++) if (!revealed[i]) futureIdx.push(i);

      if (futureIdx.length >= 2) {
        const pool = futureIdx.map((i) => track[i]);
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        futureIdx.forEach((idx2, k) => (track[idx2] = pool[k]));
        ok = true;
        extra = { shuffledFuture: futureIdx.length };
        await updateDoc(gameRef, { eventTrack: track });
      }
    }
  }

  if (name === "Follow the Tail") {
    flags.followTail = safeObj(flags.followTail);
    flags.followTail[me.id] = true;
    ok = true;
    extra = { followTail: me.id };
    await updateDoc(gameRef, { flagsRound: { ...flags } });
  }

  if (!ok) return { played: false, reason: "NOT_IMPLEMENTED" };

  // consume card
  hand.splice(idx, 1);
  await updateDoc(playerRef, { hand });

  return { played: true, cardName: name, extra };
}

// ---------------- main runner ----------------
export function startBotRunner({ db, gameId, addLog = null, isBoardOnly = false }) {
  if (isBoardOnly) return;

  ADD_LOG = addLog;

  const gameRef = doc(db, "games", gameId);
  const playersRef = collection(db, "games", gameId, "players");

  let game = null;
  let players = [];
  let running = false;

  const inFlight = new Set();
  const keyFor = (botId) => {
    const r = game?.round ?? 0;
    const p = game?.phase ?? "?";
    const turn = p === "ACTIONS" ? `|${game?.opsTurnIndex ?? 0}` : "";
    return `${r}|${p}${turn}|${botId}`;
  };

  let lastPhase = null;
  let lastRound = null;

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
            const lootDeck = safeArr(g.lootDeck).slice();
            if (!lootDeck.length) {
              await updateDoc(gameRef, { movedPlayerIds: arrayUnion(me.id) });
              await writeAction(db, gameId, g, me, "MOVE", "MOVE_SNATCH_EMPTY");
              continue;
            }
            const card = lootDeck.pop();
            const loot = safeArr(me.loot).slice();
            loot.push(card);

            await updateDoc(playerRef, { loot });
            await updateDoc(gameRef, { lootDeck, movedPlayerIds: arrayUnion(me.id) });
            await writeAction(db, gameId, g, me, "MOVE", "MOVE_SNATCH_FROM_DECK", { lootCard: card });
          }

          if (move === "FORAGE") {
            const actionDeck = safeArr(g.actionDeck).slice();
            const hand = safeArr(me.hand).slice();
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
            const track = safeArr(g.eventTrack);
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
            const track = safeArr(g.eventTrack).slice();
            [track[pair[0]], track[pair[1]]] = [track[pair[1]], track[pair[0]]];

            await updateDoc(gameRef, { eventTrack: track, movedPlayerIds: arrayUnion(me.id) });
            await writeAction(db, gameId, g, me, "MOVE", `MOVE_SHIFT_${pair[0] + 1}<->${pair[1] + 1}`);
          }
        }
      }

      // ACTIONS (OPS)
      if (game.phase === "ACTIONS" && game.status === "round") {
        const order = safeArr(game.opsTurnOrder);
        const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
        const currentId = order[idx];

        const me = bots.find((p) => p.id === currentId);
        if (me && canOpsNow(game, me.id)) {
          const k = keyFor(me.id);
          if (!inFlight.has(k)) {
            inFlight.add(k);

            const claim = await claimOpsTurn({ db, gameRef, game, meId: me.id });
            if (!claim.ok) return;

            await sleep(randBetween(me.botDelayMin, me.botDelayMax));

            const freshSnap = await getDoc(gameRef);
            if (!freshSnap.exists()) return;
            const g = freshSnap.data();
            if (!canOpsNow(g, me.id)) return;

            const playerRef = doc(db, "games", gameId, "players", me.id);

            const res = await tryPlayActionCard({ db, gameId, gameRef, playerRef, game: g, me });

            if (res.played) {
              await updateDoc(gameRef, { opsTurnIndex: nextOpsIndex(g), opsConsecutivePasses: 0 });
              await writeAction(db, gameId, g, me, "ACTIONS", `ACTION_${res.cardName}`, res.extra || null);
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

    const next = { id: snap.id, ...snap.data() };

    // reset locks bij fase/round wissel (fix ACTIONS freeze)
    if (next.phase !== lastPhase || next.round !== lastRound) {
      inFlight.clear();
      lastPhase = next.phase;
      lastRound = next.round;
    }

    game = next;
    tick();
  });

  onSnapshot(playersRef, (qs) => {
    players = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    tick();
  });

  console.log("[BOT-RUNNER] gestart voor game", gameId);
}
