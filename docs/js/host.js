import { initAuth } from "./firebase.js";
import { getEventById } from "./cards.js";
import { addLog } from "./log.js";
import { resolveAfterReveal } from "./engine.js";
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  onSnapshot,
  updateDoc,
  query,
  where,
  getDocs,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");

const gameInfo      = document.getElementById("gameInfo");
const playersDiv    = document.getElementById("playersList");
const roundInfo     = document.getElementById("roundInfo");
const logPanel      = document.getElementById("logPanel");
const startBtn      = document.getElementById("startRoundBtn");
const endBtn        = document.getElementById("endRoundBtn");
const nextPhaseBtn  = document.getElementById("nextPhaseBtn");
const playAsHostBtn = document.getElementById("playAsHostBtn");
const eventTrackDiv = document.getElementById("eventTrack");

let currentRoundNumber     = 0;
let currentRoundForActions = 0;
let currentPhase           = "MOVE";
let unsubActions           = null;
let latestPlayers          = [];
let latestGame             = null;

const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];

// Action cards: 40 totaal volgens jouw lijst
const ACTION_CARD_DEFS = [
  { name: "Molting Mask", count: 4 },
  { name: "Scent Check", count: 3 },
  { name: "Follow the Tail", count: 3 },
  { name: "Scatter!", count: 3 },
  { name: "Den Signal", count: 3 },
  { name: "Alpha Call", count: 3 },
  { name: "No-Go Zone", count: 2 },
  { name: "Countermove", count: 4 },
  { name: "Hold Still", count: 2 },
  { name: "Kick Up Dust", count: 3 },
  { name: "Pack Tinker", count: 3 },
  { name: "Mask Swap", count: 2 },
  { name: "Nose for Trouble", count: 3 },
  { name: "Burrow Beacon", count: 2 },
];

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildEventTrack() {
  // Placeholder – later: 7 core + 3 variabel (10 total)
  const baseTrack = [
    "DEN_RED",
    "DEN_BLUE",
    "DEN_GREEN",
    "DEN_YELLOW",
    "DOG_CHARGE",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
    "HIDDEN_NEST",
    "GATE_TOLL",
    "MAGPIE_SNITCH",
    "PAINT_BOMB_NEST",
  ];
  return shuffleArray(baseTrack);
}

function buildActionDeck() {
  const deck = [];
  ACTION_CARD_DEFS.forEach((def) => {
    for (let i = 0; i < def.count; i++) {
      deck.push({ name: def.name });
    }
  });
  return shuffleArray(deck);
}

function buildLootDeck() {
  const deck = [];
  for (let i = 0; i < 20; i++) {
    deck.push({ t: "Egg", v: 1 });
  }
  for (let i = 0; i < 10; i++) {
    deck.push({ t: "Hen", v: 2 });
  }
  for (let i = 0; i < 6; i++) {
    deck.push({ t: "Prize Hen", v: 3 });
  }
  return shuffleArray(deck);
}

function renderEventTrack(game) {
  if (!eventTrackDiv) return;

  const track       = game.eventTrack || [];
  const revealed    = game.eventRevealed || [];
  const currentId   = game.currentEventId || null;
  const roosterSeen = game.roosterSeen || 0;

  eventTrackDiv.innerHTML = "";

  const h2 = document.createElement("h2");
  h2.textContent = "Event Track";
  eventTrackDiv.appendChild(h2);

  if (!track.length) {
    const p = document.createElement("p");
    p.textContent = game.raidStarted
      ? "Geen Event Track gevonden."
      : "Nog geen raid gestart.";
    p.className = "event-track-status";
    eventTrackDiv.appendChild(p);
    return;
  }

  const totalRoosters =
    track.filter((id) => id === "ROOSTER_CROW").length || 3;

  const statusLine = document.createElement("p");
  statusLine.className = "event-track-status";
  statusLine.textContent = `Rooster Crow: ${roosterSeen}/${totalRoosters}`;
  eventTrackDiv.appendChild(statusLine);

  const grid = document.createElement("div");
  grid.className = "event-track-grid";

  track.forEach((eventId, i) => {
    const ev = getEventById(eventId);
    const isRevealed = !!revealed[i];

    let state = "future";
    if (isRevealed) {
      if (currentId && eventId === currentId) state = "current";
      else state = "past";
    }

    const slot = document.createElement("div");
    slot.classList.add("event-slot", `event-state-${state}`);

    if (ev && ev.type) {
      slot.classList.add("event-type-" + ev.type.toLowerCase());
    }

    const idx = document.createElement("div");
    idx.className = "event-slot-index";
    idx.textContent = i + 1;
    slot.appendChild(idx);

    const title = document.createElement("div");
    title.className = "event-slot-title";

    if (!isRevealed) {
      title.textContent = "??";
    } else if (ev) {
      title.textContent = ev.title;
    } else {
      title.textContent = eventId;
    }

    slot.appendChild(title);
    grid.appendChild(slot);
  });

  eventTrackDiv.appendChild(grid);
}

async function initRaidIfNeeded(gameRef) {
  const snap = await getDoc(gameRef);
  if (!snap.exists()) return null;
  const game = snap.data();

  if (game.raidStarted) {
    return game;
  }

  const playersCol = collection(db, "games", gameId, "players");
  const playersSnap = await getDocs(playersCol);
  const players = [];
  playersSnap.forEach((pDoc) => {
    players.push({ id: pDoc.id, ...pDoc.data() });
  });

  if (!players.length) {
    alert(
      "Geen spelers gevonden. Laat eerst spelers joinen voordat je de raid start."
    );
    return game;
  }

  const sorted = [...players].sort((a, b) => {
    const aSec = a.joinedAt && a.joinedAt.seconds ? a.joinedAt.seconds : 0;
    const bSec = b.joinedAt && b.joinedAt.seconds ? b.joinedAt.seconds : 0;
    return aSec - bSec;
  });

  let actionDeck   = buildActionDeck();
  const lootDeck   = buildLootDeck();
  const eventTrack = buildEventTrack();
  const eventRevealed = eventTrack.map(() => false);
  const flagsRound = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
  };

  const updates = [];

  sorted.forEach((p, index) => {
    const color = DEN_COLORS[index % DEN_COLORS.length];
    const hand = [];
    for (let k = 0; k < 3; k++) {
      if (actionDeck.length) {
        hand.push(actionDeck.pop());
      }
    }
    const pref = doc(db, "games", gameId, "players", p.id);
    updates.push(
      updateDoc(pref, {
        joinOrder: index,
        color,
        inYard: true,
        dashed: false,
        burrowUsed: false,
        decision: null,
        hand,
        loot: [],
      })
    );
  });

  const sack = [];
  if (lootDeck.length) {
    sack.push(lootDeck.pop());
  }

  const leadIndex = Math.floor(Math.random() * sorted.length);

  updates.push(
    updateDoc(gameRef, {
      status: "raid",
      phase: "MOVE",
      round: 0,
      currentEventId: null,
      eventTrack,
      eventRevealed,
      eventIndex: 0,
      roosterSeen: 0,
      raidEndedByRooster: false,
      raidStarted: true,
      actionDeck,
      lootDeck,
      sack,
      flagsRound,
      scatterArmed: false,
      opsCount: {},
      leadIndex,
      movedPlayerIds: [],
      opsTurnOrder: [],
      opsTurnIndex: 0,
      opsConsecutivePasses: 0,
    })
  );

  await Promise.all(updates);

  await addLog(gameId, {
    round: 0,
    phase: "MOVE",
    kind: "SYSTEM",
    message:
      "Nieuwe raid gestart. Lead Fox: " + (sorted[leadIndex]?.name || ""),
  });

  const newSnap = await getDoc(gameRef);
  return newSnap.exists() ? newSnap.data() : null;
}

if (!gameId && gameInfo) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async (authUser) => {
  if (!gameId) return;

  const gameRef = doc(db, "games", gameId);
  const playersColRef = collection(db, "games", gameId, "players");

  // ==== GAME SNAPSHOT ====
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    latestGame = { id: snap.id, ...game };

    currentRoundNumber = game.round || 0;
    currentPhase = game.phase || "MOVE";

    const event =
      game.currentEventId && game.phase === "REVEAL"
        ? getEventById(game.currentEventId)
        : null;

    renderEventTrack(game);

    let extraStatus = "";
    if (game.raidEndedByRooster) {
      extraStatus = " – Raid geëindigd door Rooster Crow (limiet bereikt)";
    }

    gameInfo.textContent =
      `Code: ${game.code} – Status: ${game.status} – ` +
      `Ronde: ${currentRoundNumber} – Fase: ${currentPhase}${extraStatus}`;

    if (game.status !== "round" && game.status !== "raid") {
      roundInfo.textContent = "Nog geen actieve ronde.";
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    if (currentRoundForActions === currentRoundNumber && unsubActions) {
      return;
    }

    currentRoundForActions = currentRoundNumber;

    const actionsCol = collection(db, "games", gameId, "actions");
    const actionsQuery = query(
      actionsCol,
      where("round", "==", currentRoundForActions)
    );

    if (unsubActions) unsubActions();
    unsubActions = onSnapshot(actionsQuery, (snapActions) => {
      roundInfo.innerHTML = "";

      const phaseLabel = currentPhase;

      if (event) {
        const h2 = document.createElement("h2");
        h2.textContent =
          `Ronde ${currentRoundForActions} – fase: ${phaseLabel}: ${event.title}`;
        const pText = document.createElement("p");
        pText.textContent = event.text;
        roundInfo.appendChild(h2);
        roundInfo.appendChild(pText);
      } else {
        const h2 = document.createElement("h2");
        h2.textContent =
          `Ronde ${currentRoundForActions} – fase: ${phaseLabel}`;
        roundInfo.appendChild(h2);
      }

      const count = snapActions.size;
      const p = document.createElement("p");
      p.textContent = `Registraties (moves/actions/decisions): ${count}`;
      roundInfo.appendChild(p);

      const list = document.createElement("div");
      snapActions.forEach((aDoc) => {
        const a = aDoc.data();
        const line = document.createElement("div");
        line.textContent = `${a.playerName || a.playerId}: ${a.phase} – ${
          a.choice
        }`;
        list.appendChild(line);
      });
      roundInfo.appendChild(list);
    });
  });

  // ==== PLAYERS SNAPSHOT / COMMUNITY BOARD ====
  onSnapshot(playersColRef, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push({ id: pDoc.id, ...pDoc.data() });
    });
    latestPlayers = players;

    playersDiv.innerHTML = "<h2>Spelers / Scorebord</h2>";

    if (!players.length) {
      const empty = document.createElement("p");
      empty.textContent = "Nog geen spelers verbonden.";
      empty.className = "score-empty";
      playersDiv.appendChild(empty);
      return;
    }

    // Volgorde o.b.v. joinOrder
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

    const activeOrdered = ordered.filter(
      (p) => p.inYard !== false && !p.dashed
    );
    const baseList = activeOrdered.length ? activeOrdered : ordered;

    let leadIdx =
      latestGame && typeof latestGame.leadIndex === "number"
        ? latestGame.leadIndex
        : 0;

    if (leadIdx < 0) leadIdx = 0;
    if (baseList.length) {
      leadIdx = leadIdx % baseList.length;
    } else {
      leadIdx = 0;
    }

    let leadFoxName = "";
    let leadFoxId = null;
    if (baseList.length) {
      const lead = baseList[leadIdx];
      if (lead) {
        leadFoxName = lead.name || "";
        leadFoxId = lead.id;
      }
    }

    // LEAD FOX-banner bovenaan
    if (leadFoxName) {
      const lf = document.createElement("div");
      lf.className = "lead-fox-banner";
      lf.innerHTML = `
        <span class="lead-label">LEAD FOX</span>
        <span class="lead-name">${leadFoxName}</span>
      `;
      playersDiv.appendChild(lf);
    }

    // Scorebord met status-badges
    const list = document.createElement("div");
    list.className = "scoreboard-list";

    const byScore = [...players].sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );

    byScore.forEach((p) => {
      const row = document.createElement("div");
      row.className = "score-row";
      if (leadFoxId && p.id === leadFoxId) {
        row.classList.add("score-row-lead");
      }

      const left = document.createElement("div");
      left.className = "score-main";

      const nameSpan = document.createElement("span");
      nameSpan.className = "score-name";
      nameSpan.textContent = p.name || "(naam onbekend)";
      left.appendChild(nameSpan);

      if (p.isHost) {
        const hostChip = document.createElement("span");
        hostChip.className = "chip chip-host";
        hostChip.textContent = "HOST";
        left.appendChild(hostChip);
      }

      if (leadFoxId && p.id === leadFoxId) {
        const leadChip = document.createElement("span");
        leadChip.className = "chip chip-lead";
        leadChip.textContent = "LEAD";
        left.appendChild(leadChip);
      }

      // Status-badge
      let statusLabel = "";
      let statusClass = "";
      if (p.dashed) {
        statusLabel = "DASHED";
        statusClass = "chip-status chip-status-dashed";
      } else if (p.inYard === false) {
        statusLabel = "CAUGHT";
        statusClass = "chip-status chip-status-caught";
      } else {
        statusLabel = "IN YARD";
        statusClass = "chip-status chip-status-yard";
      }

      const statusSpan = document.createElement("span");
      statusSpan.className = "chip " + statusClass;
      statusSpan.textContent = statusLabel;
      left.appendChild(statusSpan);

      const right = document.createElement("div");
      right.className = "score-score";
      right.textContent = `${p.score || 0} pts`;

      row.appendChild(left);
      row.appendChild(right);

      list.appendChild(row);
    });

    playersDiv.appendChild(list);
  });

  // ==== LOGPANEL ====
  const logCol = collection(db, "games", gameId, "log");
  const logQuery = query(logCol, orderBy("createdAt", "desc"), limit(10));

  onSnapshot(logQuery, (snap) => {
    const entries = [];
    snap.forEach((docSnap) => entries.push(docSnap.data()));
    entries.reverse();

    logPanel.innerHTML = "<h2>Logboek</h2>";
    entries.forEach((e) => {
      const div = document.createElement("div");
      div.className = "log-line";
      div.textContent =
        `[R${e.round ?? "?"} – ${e.phase ?? "?"} – ${e.kind ?? "?"}] ${
          e.message ?? ""
        }`;
      logPanel.appendChild(div);
    });
  });

  // ==== START ROUND (Lead Fox rotatie) ====
  startBtn.addEventListener("click", async () => {
    const game = await initRaidIfNeeded(gameRef);
    if (!game) return;

    if (game.raidEndedByRooster) {
      alert(
        "De raid is geëindigd door de Rooster-limiet. Er kunnen geen nieuwe rondes meer gestart worden."
      );
      return;
    }

    const previousRound = game.round || 0;
    const newRound = previousRound + 1;

    // Bepaal nieuwe Lead Fox (rotatie op basis van joinOrder + actieve vossen)
    const ordered = [...latestPlayers].sort((a, b) => {
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

    const activeOrdered = ordered.filter(
      (p) => p.inYard !== false && !p.dashed
    );
    const baseList = activeOrdered.length ? activeOrdered : ordered;

    let leadIndex =
      typeof game.leadIndex === "number" ? game.leadIndex : 0;

    if (baseList.length) {
      // Normaliseer index binnen huidige lijst
      leadIndex =
        ((leadIndex % baseList.length) + baseList.length) % baseList.length;

      // Vanaf ronde 2 en verder schuift Lead Fox door
      if (previousRound >= 1) {
        leadIndex = (leadIndex + 1) % baseList.length;
      }
    } else {
      leadIndex = 0;
    }

    let leadName = "";
    if (baseList.length) {
      const lf = baseList[leadIndex];
      if (lf) leadName = lf.name || "";
    }

    await updateDoc(gameRef, {
      status: "round",
      round: newRound,
      phase: "MOVE",
      currentEventId: null,
      movedPlayerIds: [],
      opsTurnOrder: [],
      opsTurnIndex: 0,
      opsConsecutivePasses: 0,
      leadIndex,
    });

    await addLog(gameId, {
      round: newRound,
      phase: "MOVE",
      kind: "SYSTEM",
      message: leadName
        ? `Ronde ${newRound} gestart. Lead Fox: ${leadName}.`
        : `Ronde ${newRound} gestart.`,
    });
  });

  // ==== FASE-SWITCHER (MOVE/ACTIONS/DECISION/REVEAL) ====
  nextPhaseBtn.addEventListener("click", async () => {
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const game = snap.data();

    const current     = game.phase || "MOVE";
    const roundNumber = game.round || 0;

    if (game.status !== "round" && game.status !== "raid") {
      alert("Er is geen actieve ronde in de raid.");
      return;
    }

    // MOVE -> ACTIONS (OPS-init)
    if (current === "MOVE") {
      const active = latestPlayers.filter(
        (p) => p.inYard !== false && !p.dashed
      );
      const mustMoveCount = active.length;
      const moved = game.movedPlayerIds || [];

      if (mustMoveCount > 0 && moved.length < mustMoveCount) {
        alert(
          `Niet alle vossen hebben hun MOVE gedaan (${moved.length}/${mustMoveCount}).`
        );
        return;
      }

      if (!active.length) {
        await updateDoc(gameRef, { phase: "DECISION" });
        await addLog(gameId, {
          round: roundNumber,
          phase: "DECISION",
          kind: "SYSTEM",
          message:
            "Geen actieve vossen in de Yard na MOVE – OPS wordt overgeslagen. Door naar DECISION.",
        });
        return;
      }

      const ordered = [...active].sort((a, b) => {
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

      const baseOrder = ordered.map((p) => p.id);

      let leadIndex =
        typeof game.leadIndex === "number" ? game.leadIndex : 0;
      if (leadIndex < 0 || leadIndex >= baseOrder.length) {
        leadIndex = 0;
      }

      const opsTurnOrder = [];
      for (let i = 0; i < baseOrder.length; i++) {
        opsTurnOrder.push(baseOrder[(leadIndex + i) % baseOrder.length]);
      }

      await updateDoc(gameRef, {
        phase: "ACTIONS",
        opsTurnOrder,
        opsTurnIndex: 0,
        opsConsecutivePasses: 0,
      });

      await addLog(gameId, {
        round: roundNumber,
        phase: "ACTIONS",
        kind: "SYSTEM",
        message:
          "OPS-fase gestart. Lead Fox begint met het spelen van Action Cards of PASS.",
      });

      return;
    }

    // ACTIONS -> DECISION (als iedereen na elkaar PASS heeft gekozen)
    if (current === "ACTIONS") {
      const active = latestPlayers.filter(
        (p) => p.inYard !== false && !p.dashed
      );
      const activeCount = active.length;
      const passes = game.opsConsecutivePasses || 0;

      if (activeCount > 0 && passes < activeCount) {
        alert(
          `OPS-fase is nog bezig: opeenvolgende PASSes: ${passes}/${activeCount}.`
        );
        return;
      }

      await updateDoc(gameRef, { phase: "DECISION" });

      await addLog(gameId, {
        round: roundNumber,
        phase: "DECISION",
        kind: "SYSTEM",
        message:
          "Iedereen heeft na elkaar gepast in OPS – door naar DECISION-fase.",
      });

      return;
    }

    // DECISION -> REVEAL
    if (current === "DECISION") {
      const active = latestPlayers.filter(
        (p) => p.inYard !== false && !p.dashed
      );
      const decided = active.filter((p) => !!p.decision).length;

      if (active.length > 0 && decided < active.length) {
        alert(
          `Niet alle vossen hebben een DECISION gekozen (${decided}/${active.length}).`
        );
        return;
      }

      const track = game.eventTrack || [];
      let eventIndex =
        typeof game.eventIndex === "number" ? game.eventIndex : 0;

      if (!track.length || eventIndex >= track.length) {
        alert("Er zijn geen events meer op de Track om te onthullen.");
        return;
      }

      const eventId = track[eventIndex];
      const ev = getEventById(eventId);
      const revealed = game.eventRevealed
        ? [...game.eventRevealed]
        : track.map(() => false);
      revealed[eventIndex] = true;

      let newRoosterSeen = game.roosterSeen || 0;
      let raidEndedByRooster = game.raidEndedByRooster || false;

      const updatePayload = {
        phase: "REVEAL",
        currentEventId: eventId,
        eventRevealed: revealed,
        eventIndex: eventIndex + 1,
      };

      if (eventId === "ROOSTER_CROW") {
        newRoosterSeen += 1;
        updatePayload.roosterSeen = newRoosterSeen;
        if (newRoosterSeen >= 3) {
          raidEndedByRooster = true;
          updatePayload.raidEndedByRooster = true;
        }
      }

      await updateDoc(gameRef, updatePayload);

      await addLog(gameId, {
        round: roundNumber,
        phase: "REVEAL",
        kind: "EVENT",
        cardId: eventId,
        message: ev ? ev.title : eventId,
      });

      if (eventId === "ROOSTER_CROW") {
        await addLog(gameId, {
          round: roundNumber,
          phase: "REVEAL",
          kind: "EVENT",
          cardId: eventId,
          message: `Rooster Crow (${newRoosterSeen}/3).`,
        });
        if (raidEndedByRooster) {
          await addLog(gameId, {
            round: roundNumber,
            phase: "REVEAL",
            kind: "SYSTEM",
            message:
              "Derde Rooster Crow: dashers verdelen de Sack en daarna eindigt de raid.",
          });
        }
      }

      await resolveAfterReveal(gameId);
      return;
    }

    // REVEAL -> terug naar MOVE (voor volgende ronde)
    if (current === "REVEAL") {
      await updateDoc(gameRef, { phase: "MOVE" });

      await addLog(gameId, {
        round: roundNumber,
        phase: "MOVE",
        kind: "SYSTEM",
        message:
          "REVEAL afgerond. Terug naar MOVE-fase voor de volgende ronde (of einde raid als er geen actieve vossen meer zijn).",
      });

      return;
    }
  });

  // Oud test-knopje (scores), laten we nog even staan
  endBtn.addEventListener("click", async () => {
    const gameSnap = await getDoc(gameRef);
    if (!gameSnap.exists()) return;
    const game = gameSnap.data();
    const roundNumber = game.round || 0;

    if (game.status !== "round" || roundNumber === 0) {
      alert("Er is geen actieve ronde om af te sluiten.");
      return;
    }

    const actionsCol = collection(db, "games", gameId, "actions");
    const actionsQuery = query(actionsCol, where("round", "==", roundNumber));
    const actionsSnap = await getDocs(actionsQuery);

    const scoreChanges = {};

    actionsSnap.forEach((aDoc) => {
      const a = aDoc.data();
      if (!a.playerId) return;
      if (a.choice === "GRAB_LOOT") {
        scoreChanges[a.playerId] = (scoreChanges[a.playerId] || 0) + 1;
      }
    });

    const playersSnap = await getDocs(playersColRef);
    const updates = [];
    playersSnap.forEach((pDoc) => {
      const p = pDoc.data();
      const delta = scoreChanges[pDoc.id] || 0;
      const newScore = (p.score || 0) + delta;
      updates.push(updateDoc(pDoc.ref, { score: newScore }));
    });

    await Promise.all(updates);

    const updatedPlayersSnap = await getDocs(playersColRef);
    const standings = [];
    updatedPlayersSnap.forEach((pDoc) => {
      const p = pDoc.data();
      standings.push(`${p.name}: ${p.score || 0}`);
    });

    await addLog(gameId, {
      round: roundNumber,
      phase: "REVEAL",
      kind: "SCORE",
      message: `Tussenstand na ronde ${roundNumber}: ${standings.join(", ")}`,
    });

    await updateDoc(gameRef, {
      status: "lobby",
    });

    alert("Ronde afgesloten en scores bijgewerkt (oude test-teller).");
  });

  // Host als speler openen
  playAsHostBtn.addEventListener("click", async () => {
    const q = query(
      playersColRef,
      where("uid", "==", authUser.uid),
      where("isHost", "==", true)
    );

    const snap = await getDocs(q);
    if (snap.empty) {
      alert(
        "Geen host-speler gevonden. Start het spel opnieuw of join met de code."
      );
      return;
    }

    const playerDoc = snap.docs[0];
    const hostPlayerId = playerDoc.id;

    window.open(
      `player.html?game=${gameId}&player=${hostPlayerId}`,
      "_blank"
    );
  });
});
