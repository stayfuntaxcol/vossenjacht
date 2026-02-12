import "./firebase.js"; // zorgt dat initializeApp wordt uitgevoerd

import {
  getFirestore,
  doc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
  addDoc,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { getEventById } from "./cards.js";
import { addLog } from "./log.js";

const db = getFirestore();

// =======================================
// Helpers
// =======================================

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// LOCKED (reeds onthuld) vs FUTURE (nog dicht)
function splitTrackByStatus(game) {
  const track = Array.isArray(game.eventTrack) ? [...game.eventTrack] : [];
  const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;

  return {
    track,
    eventIndex,
    locked: track.slice(0, eventIndex), // al gespeeld
    future: track.slice(eventIndex), // nog te komen
  };
}

// =========================
// DECISION normalize + safety
// DASH/BURROW/HIDE = safe, LURK/unknown = unsafe
// =========================
function normDecision(x) {
  const s = String(x || "").toUpperCase().trim();
  return s.startsWith("DECISION_") ? s.slice("DECISION_".length) : s;
}

function isDecision(x, want) {
  return normDecision(x) === String(want || "").toUpperCase().trim();
}

function isSafeDecision(x) {
  const d = normDecision(x);
  if (d === "DASH") return true;
  if (d === "BURROW" || d === "HIDE") return true;
  return false; // LURK/unknown
}

function isInYardForEvents(p) {
  return p?.inYard !== false && !p?.dashed && !p?.caught;
}

function isActiveForTurn(p) {
  return p?.inYard !== false && !p?.dashed && !p?.caught;
}

function markCaught(p) {
  if (!p) return;
  p.caught = true;
  p.role = "VIEWER";     // viewer: mag meekijken, geen invloed
  p.state = "CAUGHT";    // handig voor UI
  p.inYard = false;
  p.dashed = false;
  p.loot = [];
}

function pickLeadFromBase(game, base) {
  if (!Array.isArray(base) || !base.length) return null;

  const leadId = String(game?.leadFoxId || "");
  if (leadId) {
    const found = base.find((p) => String(p?.id || "") === leadId);
    if (found) return found;
  }

  const idxRaw = typeof game?.leadIndex === "number" ? game.leadIndex : 0;
  const idx = ((idxRaw % base.length) + base.length) % base.length;
  return base[idx] || base[0];
}

function normalizeColorKey(c) {
  if (!c) return "";
  return String(c).trim().toUpperCase();
}

function isDenImmune(flagsRound, color) {
  const key = normalizeColorKey(color);
  const map = flagsRound?.denImmune || {};
  return !!(map[key] || map[key.toLowerCase()]);
}

function calcLootStats(loot) {
  const items = loot || [];
  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let points = 0;

  for (const card of items) {
    const t = card?.t || "";
    const v = Number(card?.v || 0);
    if (t === "Egg") eggs++;
    else if (t === "Hen") hens++;
    else if (t === "Prize Hen") prize++;
    points += v;
  }
  return { eggs, hens, prize, points };
}

async function writePlayers(gameId, players) {
  const updates = [];
  for (const p of players) {
    const { id, ...data } = p;
    const pref = doc(db, "games", gameId, "players", id);
    updates.push(updateDoc(pref, data));
  }
  await Promise.all(updates);
}

// =======================================
// Hidden Nest helper
// =======================================
//
// - 1 dasher  => 3 lootkaarten
// - 2 dashers => ieder 2 lootkaarten
// - 3 dashers => ieder 1 lootkaart
// - 4+        => niemand krijgt iets
//
// Loot komt uit lootDeck. Als er te weinig kaarten zijn,
// delen we eerlijk in rondes.
function applyHiddenNestEvent(players, lootDeck) {
  const dashers = players.filter((p) => isInYardForEvents(p) && isDecision(p.decision, "DASH"));
  const n = dashers.length;

  let targetEach = 0;
  if (n === 1) targetEach = 3;
  else if (n === 2) targetEach = 2;
  else if (n === 3) targetEach = 1;
  else targetEach = 0;

  if (!targetEach || !dashers.length || !lootDeck.length) return null;

  const grantedMap = new Map();
  dashers.forEach((p) => grantedMap.set(p.id, 0));

  for (let round = 0; round < targetEach && lootDeck.length > 0; round++) {
    for (const fox of dashers) {
      if (!lootDeck.length) break;
      const current = grantedMap.get(fox.id) || 0;
      if (current >= targetEach) continue;

      if (!Array.isArray(fox.loot)) fox.loot = [];
      fox.loot.push(lootDeck.pop());
      grantedMap.set(fox.id, current + 1);
    }
  }

  const results = [];
  for (const fox of dashers) {
    const c = grantedMap.get(fox.id) || 0;
    if (c > 0) results.push({ player: fox, count: c });
  }
  return results.length ? results : null;
}

// =======================================
// Pack Tinker helper (NEW)
// Wissel 1 handkaart met 1 kaart uit de aflegstapel (actionDiscardPile)
// =======================================
export async function applyPackTinker(gameId, playerId, giveName, takeUid) {
  const gameRef = doc(db, "games", gameId);
  const playerRef = doc(db, "games", gameId, "players", playerId);

  const [gSnap, pSnap] = await Promise.all([getDoc(gameRef), getDoc(playerRef)]);
  if (!gSnap.exists() || !pSnap.exists()) return;

  const game = gSnap.data();
  const player = pSnap.data();

  const round = game.round || 0;
  const phase = game.phase || "ACTIONS";

  const norm = (x) => String(x || "").trim().toLowerCase();
  const cardNameOf = (c) => {
    if (c == null) return "";
    if (typeof c === "string") return c;
    return String(c.name || c.cardName || c.id || "").trim();
  };

  const hand = Array.isArray(player.hand) ? [...player.hand] : [];
  const giveKey = norm(giveName);
  const giveIdx = hand.findIndex((c) => norm(cardNameOf(c)) === giveKey);

  if (giveIdx < 0) {
    await addLog(gameId, {
      round,
      phase,
      kind: "ACTION_CARD",
      choice: "EFFECT_PACK_TINKER_INVALID",
      payload: { reason: "give_not_in_hand", giveName },
      message: `Pack Tinker: "${giveName}" zit niet (meer) in je hand.`,
    });
    return;
  }

  const discard = Array.isArray(game.actionDiscardPile) ? [...game.actionDiscardPile] : [];
  const takeIdx = discard.findIndex((it) => it && typeof it === "object" && it.uid === takeUid);

  if (takeIdx < 0) {
    await addLog(gameId, {
      round,
      phase,
      kind: "ACTION_CARD",
      choice: "EFFECT_PACK_TINKER_INVALID",
      payload: { reason: "take_not_in_discard", takeUid },
      message: "Pack Tinker: gekozen kaart staat niet (meer) in de aflegstapel.",
    });
    return;
  }

  const takeItem = discard[takeIdx];
  const takeName = String(takeItem?.name || "").trim();
  if (!takeName) return;

  // ✅ swap: gekozen discard kaart naar hand (als object, consistent met deck/hand)
  hand[giveIdx] = { name: takeName };

  // ✅ swap: gekozen hand kaart naar discard (houd uid stabiel, vervang alleen de inhoud)
  const at = Date.now();
  discard[takeIdx] = {
    ...takeItem,
    name: String(giveName || "").trim(),
    by: playerId,
    round: Number(round),
    at,
  };

  await Promise.all([
    updateDoc(playerRef, { hand }),
    updateDoc(gameRef, { actionDiscardPile: discard }),
  ]);

  await addLog(gameId, {
    round,
    phase,
    kind: "ACTION_CARD",
    choice: "EFFECT_PACK_TINKER_SWAP",
    payload: { giveName, takeName, takeUid },
    message: `Pack Tinker: "${giveName}" gewisseld met "${takeName}" uit de aflegstapel.`,
  });
}

// =======================================
// Kick Up Dust helper
// =======================================
export async function applyKickUpDust(gameId) {
  const gameRef = doc(db, "games", gameId);
  const snap = await getDoc(gameRef);
  if (!snap.exists()) return;
  const game = snap.data();

  const round = game.round || 0;
  const phase = game.phase || "ACTIONS";

  const flags = game.flagsRound || {};

  // Volledige lock (bv. Burrow Beacon): niets mag de Event Track wijzigen.
  if (flags.lockEvents) {
    await addLog(gameId, {
      round,
      phase,
      kind: "ACTION_CARD",
      choice: "EFFECT_KICK_UP_DUST_BLOCKED",
      payload: { reason: "lockEvents" },
      message: "Kick Up Dust had geen effect – Event Track is gelocked (lockEvents).",
    });
    return;
  }

  const { locked, future } = splitTrackByStatus(game);

  if (future.length <= 1) {
    await addLog(gameId, {
      round,
      phase,
      kind: "ACTION_CARD",
      choice: "EFFECT_KICK_UP_DUST_NOOP",
      payload: { lockedCount: locked.length, futureCount: future.length },
      message: "Kick Up Dust had nauwelijks effect – te weinig toekomstige Events om te schudden.",
    });
    return;
  }

  // HEAD-lock (bv. No-Go Zone): de eerstvolgende kaart blijft staan, alleen de rest shuffle't.
  const lockHead = !!flags.lockHead;

  let newTrack;
  if (lockHead) {
    const head = future[0];
    const rest = future.slice(1);
    const shuffledRest = rest.length > 1 ? shuffleArray(rest) : rest;
    newTrack = [...locked, head, ...shuffledRest];

    await updateDoc(gameRef, {
      eventTrack: newTrack,
      eventTrackVersion: increment(1),
    });

    await addLog(gameId, {
      round,
      phase,
      kind: "ACTION_CARD",
      choice: "EFFECT_KICK_UP_DUST_LOCKHEAD",
      payload: { lockedCount: locked.length, futureCount: future.length },
      message: "Kick Up Dust: future Events geschud, maar de eerstvolgende kaart bleef vast staan (No-Go Zone).",
    });
    return;
  }

  // Normaal: hele future shuffle't
  const shuffledFuture = shuffleArray(future);
  newTrack = [...locked, ...shuffledFuture];

  await updateDoc(gameRef, {
    eventTrack: newTrack,
    eventTrackVersion: increment(1),
  });

  await addLog(gameId, {
    round,
    phase,
    kind: "ACTION_CARD",
    choice: "EFFECT_KICK_UP_DUST",
    payload: { lockedCount: locked.length, futureCount: future.length },
    message: "Kick Up Dust: toekomstige Event kaarten geschud (onthulde kaarten blijven staan).",
  });
}
// =======================================
// Scoring & einde raid
// =======================================
async function scoreRaidAndFinish(gameId, gameRef, game, players, lootDeck, sack, reason) {
  const round = game.round || 0;

  // Loot Sack eindscore:
  // - tel punten van alle kaarten die nog in de Sack zitten
  // - verdeel die punten gelijk over alle vossen die veilig geDASH't zijn (p.dashed === true) en niet gepakt zijn
  const sackCards = Array.isArray(sack) ? sack : [];
  const totalSackPoints = sackCards.reduce((sum, c) => sum + (typeof c?.v === "number" ? c.v : 0), 0);

  const eligibleDashers = [...players]
    .filter((p) => p?.dashed === true && p?.inYard !== false)
    .sort((a, b) => {
      const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

  const sackBonusById = new Map();
  if (eligibleDashers.length && totalSackPoints > 0) {
    const base = Math.floor(totalSackPoints / eligibleDashers.length);
    const remainder = totalSackPoints % eligibleDashers.length;

    eligibleDashers.forEach((p, i) => {
      const extra = i < remainder ? 1 : 0;
      sackBonusById.set(p.id, base + extra);
    });
  }

  let bestPoints = -Infinity;
  let winners = [];

  for (const p of players) {
    const { eggs, hens, prize, points } = calcLootStats(p.loot);
    const sackBonus = sackBonusById.get(p.id) || 0;

    p.eggs = eggs;
    p.hens = hens;
    p.prize = prize;
    p.sackBonus = sackBonus;
    p.score = points + sackBonus;

    if (p.score > bestPoints) {
      bestPoints = p.score;
      winners = [p];
    } else if (p.score === bestPoints) {
      winners.push(p);
    }
  }

  await writePlayers(gameId, players);

  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const summary = sorted
    .map((p, idx) => {
      const baseLine = `${idx + 1}. ${p.name || "Vos"} – ${p.score || 0} punten (P:${p.prize || 0} H:${p.hens || 0} E:${p.eggs || 0})`;
      const sb = typeof p.sackBonus === "number" && p.sackBonus > 0 ? ` Sack:+${p.sackBonus}` : "";
      return baseLine + sb;
    })
    .join(" | ");

  const winnerNames = winners.map((w) => w.name || "Vos").join(", ");

  let sackInfo = "";
  if (totalSackPoints > 0) {
    if (!eligibleDashers.length) {
      sackInfo = ` Loot Sack: ${totalSackPoints} punten, maar niemand heeft veilig geDASH't.`;
    } else {
      const base = Math.floor(totalSackPoints / eligibleDashers.length);
      const remainder = totalSackPoints % eligibleDashers.length;
      sackInfo = ` Loot Sack: ${totalSackPoints} punten → ${eligibleDashers.length} Dasher(s): +${base} p.p.${remainder ? ` (+1 voor ${remainder} vos(sen))` : ""}.`;
    }
  }

  await addLog(gameId, {
    round,
    phase: "END",
    kind: "SCORE",
    message: `Raid eindigt (${reason}).${sackInfo} Winnaar(s): ${winnerNames}. Stand: ${summary}`,
  });

  await updateDoc(gameRef, {
    status: "finished",
    phase: "END",
    lootDeck,
    sack,
    raidEndedByRooster: !!game.raidEndedByRooster,
  });

  await saveLeaderboardForGame(gameId);
}

// Rooster-limiet: 3e Rooster Crow
async function endRaidByRooster(gameId, gameRef, game, players, lootDeck, sack, event, round) {
  const dashers = players
    .filter((p) => isInYardForEvents(p) && isDecision(p.decision, "DASH"))

    .sort((a, b) => {
      const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

  // markeer Dashers als "veilig weg" + vang iedereen die nog in de YARD staat bij de 3e Rooster.
  // Regel: wie niet DASH’t bij de 3e Rooster Crow wordt gepakt en verliest alle LOOT (dus ook 0 punten).
  for (const p of players) {
    const inYard = isInYardForEvents(p);
    const choseDash = inYard && isDecision(p.decision, "DASH");

    const getsCaught = inYard && !choseDash;

    if (choseDash) {
      p.dashed = true;
    }

    if (getsCaught) {
      p.caught = true;
      p.role = "VIEWER";
      p.state = "CAUGHT";
      p.inYard = false; // host kan CAUGHT tonen
      // wipe loot + all score-related fields so leaderboard becomes 0
      p.loot = [];
      p.eggs = 0;
      p.hens = 0;
      p.prize = 0;
      p.score = 0;
      p.lootShare = 0;
      p.sackBonus = 0;
      p.bonusPoints = 0;
      p.dashPenalty = 0;
    }

    p.decision = null;
  }

  game.raidEndedByRooster = true;

  await addLog(gameId, {
    round,
    phase: "REVEAL",
    kind: "EVENT",
    message: dashers.length
      ? "Derde Rooster Crow: raid eindigt. Loot Sack telt als punten-bonus en wordt verdeeld onder de Dashers bij de eindscore."
      : "Derde Rooster Crow: raid eindigt. Geen Dashers → Loot Sack levert geen bonus op.",
  });

  await scoreRaidAndFinish(gameId, gameRef, game, players, lootDeck, sack, "Rooster Crow limiet bereikt");
}

// =======================================
// resolveAfterReveal
// =======================================
export async function resolveAfterReveal(gameId) {
  const gameRef = doc(db, "games", gameId);
  const snap = await getDoc(gameRef);
  if (!snap.exists()) return;
  const game = snap.data();

  if (game.phase !== "REVEAL") return;
  if (!game.currentEventId) return;

  const round = game.round || 0;
  const eventId = game.currentEventId;

  const playersCol = collection(db, "games", gameId, "players");
  const playersSnap = await getDocs(playersCol);
  const players = [];
  playersSnap.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));
  if (!players.length) return;

  const ev = getEventById(eventId);
  let lootDeck = [...(game.lootDeck || [])];
  let sack = [...(game.sack || [])];
  
  let leadAdvanceBonus = 0; // +1 betekent: lead roteert extra hard (penalty)
  
  let flagsRound = {
    lockEvents: false,
    lockHead: false,
    scatter: false,
    denImmune: {},
    noPeekAll: false,
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
    ...(game.flagsRound || {}),
  };

// ====== Nose for Trouble – juiste voorspelling? ======
const predictions = Array.isArray(flagsRound.predictions) ? flagsRound.predictions : [];
if (predictions.length && lootDeck.length) {
  for (const pred of predictions) {
    if (pred.eventId !== eventId) continue;
    const p = players.find((pl) => pl.id === pred.playerId);
    if (!p) continue;
    if (!lootDeck.length) break;

    const card = lootDeck.pop();
    p.loot = p.loot || [];
    p.loot.push(card);

    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "EVENT",
      playerId: p.id,
      message: `${p.name || "Vos"} had Nose for Trouble juist en krijgt extra buit.`,
    });
  }
}

// ====== Rooster: limiet-check (3e crow) ======
if ((game.roosterSeen || 0) >= 3 && eventId === "ROOSTER_CROW") {
  await endRaidByRooster(gameId, gameRef, game, players, lootDeck, sack, ev, round);
  return;
}

  // ====== Follow the Tail – beslissingen laten volgen ======
  const followMap = flagsRound.followTail || {};
  const followPairs = Object.entries(followMap);
  if (followPairs.length) {
    for (const [followerId, targetId] of followPairs) {
      const follower = players.find((p) => p.id === followerId);
      const target = players.find((p) => p.id === targetId);
      if (!follower || !target) continue;
      if (!isInYardForEvents(follower)) continue;

      if (target.decision) {
        follower.decision = target.decision;
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: follower.id,
          message: `${follower.name || "Vos"} volgt de keuze van ${target.name || "een vos"} (Follow the Tail: ${target.decision}).`,
        });
      }
    }
  }
  
  // ====== BURROW/HIDE: consume token zodra gekozen (voor UI/consistency) ======
  for (const p of players) {
    if (!isInYardForEvents(p)) continue;

    if (isDecision(p.decision, "BURROW") || isDecision(p.decision, "HIDE")) {
      if (!p.burrowUsedThisRaid) {
        const pRef = doc(db, "games", gameId, "players", p.id);
        await updateDoc(pRef, { burrowUsedThisRaid: true });
        p.burrowUsedThisRaid = true;

        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} gebruikt BURROW/HIDE (1× per raid) en is veilig.`,
        });
      }
    }
  }

  // =======================================
  // Event-specifieke logica
  // =======================================

    if (eventId.startsWith("DEN_")) {
    const color = normalizeColorKey(eventId.substring(4)); // RED / BLUE / GREEN / YELLOW

    if (isDenImmune(flagsRound, color)) {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        message: `Den ${color} is immune door Den Signal – niemand wordt gepakt.`,
      });
    } else {
      for (const p of players) {
        if (!isInYardForEvents(p)) continue;
        if (normalizeColorKey(p.color || p.denColor) !== color) continue;

        // SAFE: DASH/BURROW/HIDE
        if (isSafeDecision(p.decision)) continue;

        // Unsafe (LURK/unknown) => caught
        markCaught(p);

        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} wordt gepakt bij ${ev ? ev.title : "Den-event"} en verliest alle buit.`,
        });
      }
    }

    } else if (eventId === "DOG_CHARGE") {
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;

      if (isDenImmune(flagsRound, p.color || p.denColor)) {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} ontsnapt aan de herderhond dankzij Den Signal.`,
        });
        continue;
      }

      // SAFE: DASH/BURROW/HIDE
      if (isSafeDecision(p.decision)) continue;

      // Unsafe => caught
      markCaught(p);

      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${p.name || "Vos"} wordt onder de voet gelopen door de herderhond en verliest alle buit.`,
      });
    }

  } else if (eventId === "SHEEPDOG_PATROL") {
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;

      // SAFE: DASH/BURROW/HIDE
      if (isSafeDecision(p.decision)) continue;

      // Unsafe => caught
      markCaught(p);

      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${p.name || "Vos"} wordt tijdens de Sheepdog Patrol gepakt (LURK) en verliest alle buit.`,
      });
    }

   } else if (eventId === "SECOND_CHARGE") {
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;

      if (isDenImmune(flagsRound, p.color || p.denColor)) {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} ontsnapt aan de tweede herderhond-charge dankzij Den Signal.`,
        });
        continue;
      }

      // SAFE: DASH/BURROW/HIDE
      if (isSafeDecision(p.decision)) continue;

      // Unsafe => caught
      markCaught(p);

      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${p.name || "Vos"} wordt alsnog ingehaald bij de Second Charge en verliest alle buit.`,
      });
    }

  } else if (eventId === "HIDDEN_NEST") {
    const results = applyHiddenNestEvent(players, lootDeck);

    if (results && results.length) {
      const parts = results.map((r) => `${r.player.name || "Vos"} (+${r.count})`);
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        cardId: eventId,
        message: `Hidden Nest: ${parts.join(", ")}.`,
      });
    } else {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        cardId: eventId,
        message: "Hidden Nest had geen effect – het aantal dashers was niet 1, 2 of 3 (of er was geen loot meer).",
      });
    }
  } else if (eventId === "GATE_TOLL") {
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;
      if (isSafeDecision(p.decision)) continue;

      const loot = Array.isArray(p.loot) ? [...p.loot] : [];
      if (loot.length > 0) {
        loot.pop();
        p.loot = loot;
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} betaalt Gate Toll en verliest 1 buit.`,
        });
      } else {
        markCaught(p);
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} kan de tol niet betalen en wordt gepakt bij het hek.`,
        });
      }
    }
  } else if (eventId === "MAGPIE_SNITCH") {
  const orderedAll = [...players].sort((a, b) => {
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  // leadIndex is gebaseerd op actieve yard-spelers (match host.js)
const orderedActive = orderedAll.filter(isActiveForTurn);
const base = orderedActive.length ? orderedActive : orderedAll;

const lead = pickLeadFromBase(game, base);

    if (lead && isInYardForEvents(lead)) {
    // SAFE: DASH/BURROW/HIDE
    if (isSafeDecision(lead.decision)) {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: lead.id,
        message: `Magpie Snitch ziet de Lead Fox, maar ${lead.name || "de vos"} is veilig (${normDecision(lead.decision)}).`,
      });
    } else {
      // Unsafe => caught
      markCaught(lead);
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: lead.id,
        message: `Magpie Snitch verraadt de Lead Fox – ${lead.name || "de vos"} wordt gepakt en verliest alle buit.`,
      });
    }
  } else {
    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "EVENT",
      message: "Magpie Snitch: geen effect (Lead Fox is niet in de Yard).",
    });
  }

} else if (eventId === "SILENT_ALARM") {
  const orderedAll = [...players].sort((a, b) => {
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

 const orderedActive = orderedAll.filter(isActiveForTurn);
 const base = orderedActive.length ? orderedActive : orderedAll;

 const lead = pickLeadFromBase(game, base);


  if (lead && isInYardForEvents(lead)) {
    if (isSafeDecision(lead.decision)) {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: lead.id,
        message: `${lead.name || "Lead Fox"} dash't al weg – Silent Alarm heeft geen effect.`,
      });
    } else {
      const loot = Array.isArray(lead.loot) ? [...lead.loot] : [];

      if (loot.length >= 2) {
        const drop1 = loot.pop();
        const drop2 = loot.pop();
        lead.loot = loot;
        if (drop1) sack.push(drop1);
        if (drop2) sack.push(drop2);

        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: lead.id,
          message: `${lead.name || "Lead Fox"} betaalt Silent Alarm en legt 2 buit af in de Sack.`,
        });
      } else {
        leadAdvanceBonus = 1;
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: lead.id,
          message: `${lead.name || "Lead Fox"} kan Silent Alarm niet betalen (minder dan 2 buit) en verliest zijn Lead-status.`,
        });
      }
    }
  } else {
    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "EVENT",
     message: `${lead.name || "Lead Fox"} is veilig (${normDecision(lead.decision)}) – Silent Alarm heeft geen effect.`,
    });
  }

  } else if (eventId === "PAINT_BOMB_NEST") {

    if (sack.length) {
      lootDeck.push(...sack);
      sack = [];
      lootDeck = shuffleArray(lootDeck);
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        message: "Paint-Bomb Nest: alle buit in de Sack gaat terug naar de loot-deck.",
      });
    }
  } else if (eventId === "ROOSTER_CROW") {
    // roosterSeen teller wordt in host.js bijgehouden
  }

  // =======================================
  // Na event: dashers markeren + flags resetten
  // =======================================
  for (const p of players) {
    if (isInYardForEvents(p) && isDecision(p.decision, "DASH")) {
      p.dashed = true;
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${p.name || "Vos"} rent met zijn buit weg (DASH).`,
      });
    }
  }

  // Flags van deze ronde resetten (types blijven correct)
  flagsRound = {
    lockEvents: false,
    lockHead: false,
    scatter: false,
    denImmune: {},
    noPeekAll: false,
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
    holdStill: {},
  };

  // Extra loot in de Sack voor volgende ronde
  if (lootDeck.length) {
    const card = lootDeck.pop();
    sack.push(card);
    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "EVENT",
      message: "Er komt extra buit in de Sack voor de volgende ronde.",
    });
  }

  // =======================================
  // Einde-voorwaarden
  // =======================================
  const alive = players.filter(isInYardForEvents);

  if (alive.length === 0) {
    const dashersSurviving = players.filter((p) => p.dashed && p.inYard !== false);

   if (dashersSurviving.length && sack.length) {
  await addLog(gameId, {
    round,
    phase: "REVEAL",
    kind: "EVENT",
    message:
      "De laatste vos is uit de Yard – Loot Sack punten worden verdeeld onder de Dashers bij de eindscore.",
  });

    } else {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "SYSTEM",
        message: "Er zijn geen vossen meer in de Yard. De raid eindigt.",
      });
    }

    await scoreRaidAndFinish(gameId, gameRef, game, players, lootDeck, sack, "Geen vossen meer in de Yard");
    return;
  }

  const track = game.eventTrack || [];
  if ((game.eventIndex || 0) >= track.length) {
    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "SYSTEM",
      message: "Alle Event Cards zijn gespeeld. De raid eindigt.",
    });
    await scoreRaidAndFinish(gameId, gameRef, game, players, lootDeck, sack, "Event deck leeg");
    return;
  }

  // Lead fox doorgeven (simpele rotatie)// Lead Fox rotatie gebeurt in host.js (Start Round). Hier dus NIET doorschuiven.
let newLeadIndex = typeof game.leadIndex === "number" ? game.leadIndex : 0;

  // decisions resetten voor volgende ronde
  for (const p of players) {
    p.decision = null;
  }

  await writePlayers(gameId, players);

  await updateDoc(gameRef, {
    lootDeck,
    sack,
    flagsRound,
    movedPlayerIds: [],
    leadIndex: newLeadIndex,
    // Scatter is een one-round effect: na REVEAL altijd disarmen
    scatterArmed: false,
  });
}

// =======================================
// Leaderboard opslag
// =======================================
export async function saveLeaderboardForGame(gameId) {
  try {
    const gameRef = doc(db, "games", gameId);
    const gameSnap = await getDoc(gameRef);
    if (!gameSnap.exists()) return;

    const game = gameSnap.data();

    // voorkom dubbele writes
    if (game.leaderboardWritten) return;

    // alleen schrijven als het spel écht klaar is
    if (game.status !== "finished" && !game.raidEndedByRooster) return;

    const playersSnap = await getDocs(collection(db, "games", gameId, "players"));

 const leaderboardEntries = [];

for (const pDoc of playersSnap.docs) {
  const p = pDoc.data();

  const eggs = Number(p.eggs || 0);
  const hens = Number(p.hens || 0);
  const prize = Number(p.prize || 0);

  const baseScore = eggs + hens * 2 + prize * 3;

  // score componenten
  const lootShare   = Number(p.lootShare ?? p.sackBonus ?? 0);
  const dashPenalty = Number(p.dashPenalty ?? 0);
  const bonusPoints = Number(p.bonusPoints ?? 0);

  let finalScore = baseScore + lootShare - dashPenalty + bonusPoints;


  // safety: if the raid ended by 3rd rooster, anyone who did NOT dash is caught => score must be 0


  if (game?.raidEndedByRooster && !p?.dashed) finalScore = 0;

  // ✅ niet opslaan als score 0 of lager
  if (!Number.isFinite(finalScore) || finalScore <= 0) {
    continue;
  }

  const bonus = lootShare + bonusPoints;

  leaderboardEntries.push({
    name: p.name || "Fox",
    score: finalScore,

    baseScore,
    lootShare,
    dashPenalty,
    bonusPoints,
    bonus,

    eggs,
    hens,
    prize,

    gameId,
    gameCode: game.code || "",
    playedAt: serverTimestamp(),
  });
}

    // Alleen entries met een echte score > 0 opslaan
    for (const entry of leaderboardEntries) {
 const s = Number(entry.score);
if (!Number.isFinite(s) || s <= 0) continue;
     await addDoc(collection(db, "leaderboard"), entry);
    }

    await updateDoc(gameRef, { leaderboardWritten: true });
  } catch (err) {
    console.error("saveLeaderboardForGame failed", err);
  }
}


