import {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  updateDoc,
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

async function scoreRaidAndFinish(gameId, gameRef, game, players, lootDeck, sack, reason) {
  const round = game.round || 0;

  // scores berekenen
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
      return `${idx + 1}. ${p.name || "Vos"} – ${p.score || 0} punten (P:${p.prize || 0} H:${p.hens || 0} E:${p.eggs || 0})`;
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
}

async function endRaidByRooster(gameId, gameRef, game, players, lootDeck, sack, event, round) {
  // dashers verdelen de Sack in snake-draft
  const dashers = players
    .filter((p) => isInYardForEvents(p) && p.decision === "DASH")
    .sort((a, b) => {
      const ao =
        typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
      const bo =
        typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
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
      message: "Dashers verdelen de Sack na de derde Rooster Crow.",
    });
  }

  // dashers markeren
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
    "Derde Rooster Crow"
  );
}

// Event-afhandeling na REVEAL
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
    ...(game.flagsRound || {}),
  };

  // Derde Rooster Crow → speciale afhandeling
  if ((game.roosterSeen || 0) >= 3 && eventId === "ROOSTER_CROW") {
    await endRaidByRooster(gameId, gameRef, game, players, lootDeck, sack, ev, round);
    return;
  }

  // ====== Event-specifieke logica ======

  // DEN_* events
  if (eventId.startsWith("DEN_")) {
    const color = eventId.substring(4); // RED / BLUE / GREEN / YELLOW
    for (const p of players) {
      if (!isInYardForEvents(p)) continue;
      if (p.color !== color) continue;

      const immune =
        flagsRound.denImmune &&
        (flagsRound.denImmune[color] || flagsRound.denImmune[color.toLowerCase()]);

      if (immune) {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} negeert dit Den-event dankzij Den Signal.`,
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
        // wordt later als dasher afgehandeld
        continue;
      }

      // gevangen
      p.inYard = false;
      p.loot = [];
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${p.name || "Vos"} wordt gepakt bij ${ev ? ev.title : "Den-event"} en verliest alle buit.`,
      });
    }
  }

  // DOG_CHARGE
  else if (eventId === "DOG_CHARGE") {
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
          message: `${p.name || "Vos"} ontsnapt aan de herderhond dankzij Den Signal.`,
        });
        continue;
      }

      if (p.decision === "BURROW") {
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: p.id,
          message: `${p.name || "Vos"} duikt onder de grond en ontwijkt de herderhond.`,
        });
        continue;
      }

      if (p.decision === "DASH") {
        continue;
      }

      // hond loopt je omver
      p.inYard = false;
      p.loot = [];
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        playerId: p.id,
        message: `${p.name || "Vos"} wordt onder de voet gelopen door de herderhond en verliest alle buit.`,
      });
    }
  }

  // HIDDEN_NEST
  else if (eventId === "HIDDEN_NEST") {
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
        message: `${fox.name || "Vos"} ontdekt het Verborgen Nest en krijgt ${gained} extra buit.`,
      });
    } else {
      await addLog(gameId, {
        round,
        phase: "REVEAL",
        kind: "EVENT",
        message: "Te veel dashers bij Hidden Nest – niemand profiteert.",
      });
    }
  }

  // GATE_TOLL
  else if (eventId === "GATE_TOLL") {
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
          message: `${p.name || "Vos"} kan de tol niet betalen en wordt gepakt bij het hek.`,
        });
      }
    }
  }

  // MAGPIE_SNITCH
  else if (eventId === "MAGPIE_SNITCH") {
    const ordered = [...players].sort((a, b) => {
      const ao =
        typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
      const bo =
        typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
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
          message: `Magpie Snitch ziet de Lead Fox, maar ${lead.name || "de vos"} zit veilig in zijn hol.`,
        });
      } else if (lead.decision !== "DASH") {
        lead.inYard = false;
        lead.loot = [];
        await addLog(gameId, {
          round,
          phase: "REVEAL",
          kind: "EVENT",
          playerId: lead.id,
          message: `Magpie Snitch verraadt de Lead Fox – ${lead.name || "de vos"} wordt gepakt en verliest alle buit.`,
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
  }

  // PAINT_BOMB_NEST
  else if (eventId === "PAINT_BOMB_NEST") {
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
  }

  // ROOSTER_CROW (1e of 2e)
  else if (eventId === "ROOSTER_CROW") {
    // roosterSeen is al verhoogd door host.js – hier alleen evt. extra logica
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

  flagsRound.lockEvents = false;
  flagsRound.scatter = false;
  flagsRound.denImmune = {};
  flagsRound.noPeek = [];
  flagsRound.predictions = [];

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
      message: `${lone.name || "Een vos"} grijpt de hele Sack – alleen vos over in de Yard.`,
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

  // Lead doorgeven (simpele rotatie)
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

  // decisions resetten
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
