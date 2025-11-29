import {
  getFirestore,
  doc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";


import { getEventById } from "./cards.js";
import { addLog } from "./log.js";

const db = getFirestore();

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isInYardForEvents(p) {
  return p.inYard !== false && !p.dashed;
}

function calcLootStats(loot) {
  const items = loot || [];
  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let points = 0;

  for (const card of items) {
    const t = card.t || "";
    const v = card.v || 0;
    if (t === "Egg") {
      eggs++;
    } else if (t === "Hen") {
      hens++;
    } else if (t === "Prize Hen") {
      prize++;
    }
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

async function scoreRaidAndFinish(
  gameId,
  gameRef,
  game,
  players,
  lootDeck,
  sack,
  reason
) {
  const round = game.round || 0;

  let bestPoints = -Infinity;
  let winners = [];

  for (const p of players) {
    const { eggs, hens, prize, points } = calcLootStats(p.loot);
    p.eggs = eggs;
    p.hens = hens;
    p.prize = prize;
    p.score = points;

    if (points > bestPoints) {
      bestPoints = points;
      winners = [p];
    } else if (points === bestPoints) {
      winners.push(p);
    }
  }

  await writePlayers(gameId, players);

  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));

  const summary = sorted
    .map((p, idx) => {
      return `${idx + 1}. ${p.name || "Vos"} – ${p.score || 0} punten (P:${
        p.prize || 0
      } H:${p.hens || 0} E:${p.eggs || 0})`;
    })
    .join(" | ");

  const winnerNames = winners.map((w) => w.name || "Vos").join(", ");

  await addLog(gameId, {
    round,
    phase: "END",
    kind: "SCORE",
    message: `Raid eindigt (${reason}). Winnaar(s): ${winnerNames}. Stand: ${summary}`,
  });

  await updateDoc(gameRef, {
    status: "finished",
    phase: "END",
    lootDeck,
    sack,
  });

  await saveLeaderboardForGame(gameId);
}

async function endRaidByRooster(
  gameId,
  gameRef,
  game,
  players,
  lootDeck,
  sack,
  event,
  round
) {
  const dashers = players
    .filter((p) => isInYardForEvents(p) && p.decision === "DASH")
    .sort((a, b) => {
      const ao =
        typeof a.joinOrder === "number"
          ? a.joinOrder
          : Number.MAX_SAFE_INTEGER;
      const bo =
        typeof b.joinOrder === "number"
          ? b.joinOrder
          : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

  if (dashers.length && sack.length) {
    let idx = 0;
    let dir = 1;
    while (sack.length) {
      const card = sack.pop();
      const fox = dashers[idx];
      fox.loot = fox.loot || [];
      fox.loot.push(card);

      idx += dir;
      if (idx >= dashers.length) {
        dir = -1;
        idx = dashers.length - 1;
      } else if (idx < 0) {
        dir = 1;
        idx = 0;
      }
    }

    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "EVENT",
      message: "Dashers verdelen de Sack na de laatste Rooster Crow.",
    });
  }

  for (const p of players) {
    if (isInYardForEvents(p) && p.decision === "DASH") {
      p.dashed = true;
    }
    p.decision = null;
  }

  sack = [];
  game.raidEndedByRooster = true;

  await scoreRaidAndFinish(
    gameId,
    gameRef,
    game,
    players,
    lootDeck,
    sack,
    "Rooster Crow limiet bereikt"
  );
}

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
  playersSnap.forEach((pDoc) => {
    players.push({ id: pDoc.id, ...pDoc.data() });
  });
  if (!players.length) return;

  const ev = getEventById(eventId);
  let lootDeck = [...(game.lootDeck || [])];
  let sack = [...(game.sack || [])];
  let flagsRound = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
    ...(game.flagsRound || {}),
  };

  // ====== Rooster: limiet-check ======
  if ((game.roosterSeen || 0) >= 3 && eventId === "ROOSTER_CROW") {
    await endRaidByRooster(
      gameId,
      gameRef,
      game,
      players,
      lootDeck,
      sack,
      ev,
      round
    );
    return;
  }

  // ====== Nose for Trouble – juiste voorspelling? ======
  const predictions = Array.isArray(flagsRound.predictions)
    ? flagsRound.predictions
    : [];

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
        message: `${
          p.name || "Vos"
        } had Nose for Trouble juist en krijgt extra buit.`,
      });
    }
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
          message: `${
            follower.name || "Vos"
          } volgt de keuze van ${target.name || "een vos"} (Follow the Tail: ${
            target.decision
          }).`,
        });
      }
    }
  }

  // ====== Event-specifieke logica ======

  if (eventId.startsWith("DEN_")) {
    const color = eventId.substring(4); // RED / BLUE / GREEN / YELLOW
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;
      if (p.color !== color) continue;

      const immune =
        flagsRound.denImmune &&
        (flagsRound.denImmune[color] ||
          flagsRound.denImmune[color.toLowerCase()]);

      if (immune) {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${
            p.name || "Vos"
          } negeert dit Den-event dankzij Den Signal.`,
        });
        continue;
      }

      if (p.decision === "BURROW") {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} overleeft in zijn hol (BURROW).`,
        });
        continue;
      }

      if (p.decision === "DASH") {
        continue;
      }

      p.inYard = false;
      p.loot = [];
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${
          p.name || "Vos"
        } wordt gepakt bij ${ev ? ev.title : "Den-event"} en verliest alle buit.`,
      });
    }
  } else if (eventId === "DOG_CHARGE") {
    // Eerste Sheepdog Charge – iedereen in de Yard, behalve BURROW / Den Signal / DASH
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;

      const immune =
        flagsRound.denImmune &&
        (flagsRound.denImmune[p.color] ||
          flagsRound.denImmune[(p.color || "").toLowerCase()]);

      if (immune) {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${
            p.name || "Vos"
          } ontsnapt aan de herderhond dankzij Den Signal.`,
        });
        continue;
      }

      if (p.decision === "BURROW") {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${
            p.name || "Vos"
          } duikt onder de grond en ontwijkt de herderhond.`,
        });
        continue;
      }

      if (p.decision === "DASH") {
        // Dashers rennen net op tijd weg
        continue;
      }

      p.inYard = false;
      p.loot = [];
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${
          p.name || "Vos"
        } wordt onder de voet gelopen door de herderhond en verliest alle buit.`,
      });
    }
  } else if (eventId === "SHEEPDOG_PATROL") {
    // Patrol: specifiek op jacht naar Dashers – BURROW/Den Signal helpen niet
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;
      if (p.decision !== "DASH") continue;

      p.inYard = false;
      p.loot = [];

      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${
          p.name || "Vos"
        } wordt tijdens de Sheepdog Patrol gepakt terwijl hij probeert te dashen en verliest alle buit.`,
      });
    }
  } else if (eventId === "SECOND_CHARGE") {
    // Tweede Sheepdog Charge – zelfde effect als DOG_CHARGE
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;

      const immune =
        flagsRound.denImmune &&
        (flagsRound.denImmune[p.color] ||
          flagsRound.denImmune[(p.color || "").toLowerCase()]);

      if (immune) {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${
            p.name || "Vos"
          } ontsnapt aan de tweede herderhond-charge dankzij Den Signal.`,
        });
        continue;
      }

      if (p.decision === "BURROW") {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${
            p.name || "Vos"
          } schuilt opnieuw in zijn hol en ontwijkt de tweede charge.`,
        });
        continue;
      }

      if (p.decision === "DASH") {
        // Dashers rennen net op tijd weg
        continue;
      }

      p.inYard = false;
      p.loot = [];
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${
          p.name || "Vos"
        } wordt alsnog ingehaald bij de Second Charge en verliest alle buit.`,
      });
    }
  } else if (eventId === "HIDDEN_NEST") {
    const dashers = players.filter(
      (p) => isInYardForEvents(p) && p.decision === "DASH"
    );

    if (dashers.length === 1) {
      const fox = dashers[0];
      fox.loot = fox.loot || [];
      let gained = 0;
      for (let i = 0; i < 4; i++) {
        if (!lootDeck.length) break;
        fox.loot.push(lootDeck.pop());
        gained++;
      }
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: fox.id,
        message: `${
          fox.name || "Vos"
        } ontdekt het Verborgen Nest en krijgt ${gained} extra buit.`,
      });
    } else {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        message: "Te veel dashers bij Hidden Nest – niemand profiteert.",
      });
    }
  } else if (eventId === "GATE_TOLL") {
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;
      if (p.decision === "DASH") continue;

      const loot = p.loot || [];
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
        p.inYard = false;
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${
            p.name || "Vos"
          } kan de tol niet betalen en wordt gepakt bij het hek.`,
        });
      }
    }
  } else if (eventId === "MAGPIE_SNITCH") {
    const ordered = [...players].sort((a, b) => {
      const ao =
        typeof a.joinOrder === "number"
          ? a.joinOrder
          : Number.MAX_SAFE_INTEGER;
      const bo =
        typeof b.joinOrder === "number"
          ? b.joinOrder
          : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

    let lead = null;
    if (ordered.length) {
      const idx =
        typeof game.leadIndex === "number" ? game.leadIndex : 0;
      lead = ordered[idx] || ordered[0];
    }

    if (lead && isInYardForEvents(lead)) {
      if (lead.decision === "BURROW") {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: lead.id,
          message: `Magpie Snitch ziet de Lead Fox, maar ${
            lead.name || "de vos"
          } zit veilig in zijn hol.`,
        });
      } else if (lead.decision !== "DASH") {
        lead.inYard = false;
        lead.loot = [];
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: lead.id,
          message: `Magpie Snitch verraadt de Lead Fox – ${
            lead.name || "de vos"
          } wordt gepakt en verliest alle buit.`,
        });
      } else {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: lead.id,
          message: `Magpie Snitch vindt niets – de Lead Fox is al aan het dashen.`,
        });
      }
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
        message:
          "Paint-Bomb Nest: alle buit in de Sack gaat terug naar de loot-deck.",
      });
    }
  } else if (eventId === "ROOSTER_CROW") {
    // roosterSeen teller wordt in host.js bijgehouden;
    // hier alleen flavour/log als nodig.
  }

  // ====== Na event: dashers markeren, flags resetten, extra loot ======

  for (const p of players) {
    if (isInYardForEvents(p) && p.decision === "DASH") {
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

  // Flags van deze ronde leegmaken
  flagsRound.lockEvents = false;
  flagsRound.scatter = false;
  flagsRound.denImmune = {};
  flagsRound.noPeek = [];
  flagsRound.predictions = [];
  flagsRound.opsLocked = false;
  flagsRound.followTail = {};
  flagsRound.scentChecks = [];

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

  // ====== Einde-voorwaarden ======

  const alive = players.filter(isInYardForEvents);

  if (alive.length === 1 && sack.length) {
    const lone = alive[0];
    lone.loot = lone.loot || [];
    while (sack.length) {
      lone.loot.push(sack.pop());
    }
    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "EVENT",
      playerId: lone.id,
      message: `${
        lone.name || "Een vos"
      } grijpt de hele Sack – alleen vos over in de Yard.`,
    });
    await scoreRaidAndFinish(
      gameId,
      gameRef,
      game,
      players,
      lootDeck,
      sack,
      "Eén vos over in de Yard"
    );
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
    await scoreRaidAndFinish(
      gameId,
      gameRef,
      game,
      players,
      lootDeck,
      sack,
      "Event deck leeg"
    );
    return;
  }

  // Lead fox doorgeven (simpele rotatie)
  const ordered = [...players].sort((a, b) => {
    const ao =
      typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo =
      typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  let newLeadIndex =
    typeof game.leadIndex === "number" ? game.leadIndex : 0;

  if (ordered.length) {
    newLeadIndex = (newLeadIndex + 1) % ordered.length;
    const newLead = ordered[newLeadIndex];
    await addLog(gameId, {
      round,
      phase: "REVEAL",
      kind: "SYSTEM",
      message: `Lead Fox schuift door naar ${newLead.name || "een vos"}.`,
    });
  }

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
  });
}
export async function saveLeaderboardForGame(gameId) {
  try {
    const gameRef = doc(db, "games", gameId);
    const gameSnap = await getDoc(gameRef);
    if (!gameSnap.exists()) return;

    const game = gameSnap.data();

    // voorkom dubbele writes
    if (game.leaderboardWritten) {
      return;
    }

    // alleen schrijven als het spel écht klaar is
    if (game.status !== "finished" && !game.raidEndedByRooster) {
      return;
    }

    const playersSnap = await getDocs(
      collection(db, "games", gameId, "players")
    );

    const leaderboardEntries = [];

    playersSnap.forEach((pDoc) => {
      const p = pDoc.data();

      const eggs = p.eggs || 0;
      const hens = p.hens || 0;
      const prize = p.prize || 0;

      const baseScore = eggs + hens * 2 + prize * 3;
      const storedScore =
        typeof p.score === "number" ? p.score : baseScore;
      const bonus = Math.max(0, storedScore - baseScore);

      // Als iedereen 0 heeft, kun je dit weglaten; maar laten we 0 ook toestaan.
      leaderboardEntries.push({
        name: p.name || "Fox",
        score: storedScore,
        eggs,
        hens,
        prize,
        bonus,
        gameId,
        gameCode: game.code || "",
        playedAt: serverTimestamp(), // belangrijk voor dag/maand filters
      });
    });

    // schrijf elke entry naar de globale "leaderboard" collectie
    for (const entry of leaderboardEntries) {
      await addDoc(collection(db, "leaderboard"), entry);
    }

    // flag op het game-document zodat we niet nog een keer schrijven
    await updateDoc(gameRef, { leaderboardWritten: true });
  } catch (err) {
    console.error("Fout bij saveLeaderboardForGame:", err);
  }
}
