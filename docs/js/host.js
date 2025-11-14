import { initAuth } from "./firebase.js";
import { getEventById } from "./cards.js";
import { addLog } from "./log.js";
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

const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];

const ACTION_CARDS_POOL = [
  "Scatter!",
  "Kick Up Dust",
  "Pack Tinker",
  "Den Signal",
  "Countermove",
  "No-Go Zone",
  "Nose for Trouble",
  "Burrow Beacon",
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
  const pool = ACTION_CARDS_POOL;
  for (let i = 0; i < 50; i++) {
    deck.push({ name: pool[i % pool.length] });
  }
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

// Render de Event Track (2x6) zoals EggRun
function renderEventTrack(game) {
  if (!eventTrackDiv) return;

  const track = game.eventTrack || [];
  const eventIndex =
    typeof game.eventIndex === "number" ? game.eventIndex : 0;
  const currentEventId = game.currentEventId || null;
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

  // tel aantal Rooster-kaarten in de track
  const totalRoosters = track.filter((id) => id === "ROOSTER_CROW").length || 3;

  const statusLine = document.createElement("p");
  statusLine.className = "event-track-status";
  statusLine.textContent = `Rooster Crow: ${roosterSeen}/${totalRoosters}`;
  eventTrackDiv.appendChild(statusLine);

  const grid = document.createElement("div");
  grid.className = "event-track-grid";

  // currentIndex = index van huidig event (laatst getrokken)
  // eventIndex wijst naar *volgende* kaart in de track
  const currentIndex =
    currentEventId && eventIndex > 0 ? eventIndex - 1 : -1;

  track.forEach((eventId, i) => {
    const ev = getEventById(eventId);
    let state = "future";

    if (currentIndex === -1) {
      state = "future"; // nog geen ronde gestart
    } else if (i < currentIndex) {
      state = "past";
    } else if (i === currentIndex) {
      state = "current";
    } else {
      state = "future";
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

    if (state === "future") {
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

// Initialiseert een raid à la EggRun v17d als dat nog niet gedaan is
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
    alert("Geen spelers gevonden. Laat eerst spelers joinen voordat je de raid start.");
    return game;
  }

  // Sorteer op joinedAt zodat we een stabiele join-volgorde hebben
  const sorted = [...players].sort((a, b) => {
    const aSec = a.joinedAt && a.joinedAt.seconds ? a.joinedAt.seconds : 0;
    const bSec = b.joinedAt && b.joinedAt.seconds ? b.joinedAt.seconds : 0;
    return aSec - bSec;
  });

  let actionDeck = buildActionDeck();
  const lootDeck = buildLootDeck();
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

  // 1 kaart naar de Sack zoals newRaid -> addLootToSack
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

  // 1) Game live volgen
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    currentRoundNumber = game.round || 0;
    currentPhase = game.phase || "MOVE";
    const event = game.currentEventId
      ? getEventById(game.currentEventId)
      : null;

    // Event Track altijd renderen
    renderEventTrack(game);

    let extraStatus = "";
    if (game.raidEndedByRooster) {
      extraStatus = " – Raid geëindigd door Rooster Crow (3/3)";
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

    // Actions voor huidige ronde volgen
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
      p.textContent = `Keuzes ontvangen: ${count}`;
      roundInfo.appendChild(p);

      const list = document.createElement("div");
      snapActions.forEach((aDoc) => {
        const a = aDoc.data();
        const line = document.createElement("div");
        line.textContent = `${a.playerName || a.playerId}: ${a.choice}`;
        list.appendChild(line);
      });
      roundInfo.appendChild(list);
    });
  });

  // 2) Spelers volgen (scorebord + LEAD FOX)
  onSnapshot(playersColRef, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push({ id: pDoc.id, ...pDoc.data() });
    });

    playersDiv.innerHTML = "<h2>Spelers / Scorebord</h2>";

    // Lead Fox indicatief (eerste op joinOrder)
    let leadFoxName = "";
    if (players.length > 0) {
      const byOrder = [...players].sort((a, b) => {
        const ao =
          typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
        const bo =
          typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
        return ao - bo;
      });
      const lead = byOrder[0];
      if (lead) {
        leadFoxName = lead.name;
      }
    }

    if (leadFoxName) {
      const lf = document.createElement("div");
      lf.textContent = `LEAD FOX (indicatief): ${leadFoxName}`;
      lf.className = "lead-fox";
      playersDiv.appendChild(lf);
    }

    const byScore = [...players].sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );

    byScore.forEach((p, index) => {
      const plek = index + 1;
      const div = document.createElement("div");
      div.textContent =
        `${plek}. ${p.name} ${p.isHost ? "(host)" : ""} – score: ${p.score || 0}`;
      playersDiv.appendChild(div);
    });
  });

  // 3) Logboek volgen
  const logCol = collection(db, "games", gameId, "log");
  const logQuery = query(logCol, orderBy("createdAt", "desc"), limit(10));

  onSnapshot(logQuery, (snap) => {
    const entries = [];
    snap.forEach((docSnap) => entries.push(docSnap.data()));
    entries.reverse(); // oud → nieuw

    logPanel.innerHTML = "<h2>Logboek</h2>";
    entries.forEach((e) => {
      const div = document.createElement("div");
      div.className = "log-line";
      div.textContent =
        `[R${e.round ?? "?"} – ${e.phase ?? "?"} – ${e.kind ?? "?"}] ${e.message ?? ""}`;
      logPanel.appendChild(div);
    });
  });

  // 4) Start (volgende) ronde
  startBtn.addEventListener("click", async () => {
    const game = await initRaidIfNeeded(gameRef);
    if (!game) return;

    if (game.raidEndedByRooster) {
      alert(
        "De raid is geëindigd door de derde Rooster Crow. Er kunnen geen nieuwe rondes meer gestart worden."
      );
      return;
    }

    const newRound = (game.round || 0) + 1;

    const track = game.eventTrack || [];
    let index =
      typeof game.eventIndex === "number" ? game.eventIndex : 0;

    let eventId = null;
    let event = null;

    if (track.length > 0) {
      if (index >= track.length) {
        // eenvoudige wrap-around als je meer dan 12 rondes speelt
        index = 0;
      }
      eventId = track[index];
      event = getEventById(eventId);
    }

    // Rooster Crow teller bijhouden
    const prevRoosterSeen = game.roosterSeen || 0;
    let newRoosterSeen = prevRoosterSeen;
    let raidEndedByRooster = game.raidEndedByRooster || false;

    if (event && event.type === "ROOSTER") {
      newRoosterSeen = prevRoosterSeen + 1;
      if (newRoosterSeen >= 3) {
        raidEndedByRooster = true;
      }
    }

    await updateDoc(gameRef, {
      status: "round",
      round: newRound,
      phase: "MOVE",
      currentEventId: eventId,
      eventIndex: track.length > 0 ? index + 1 : index,
      roosterSeen: newRoosterSeen,
      raidEndedByRooster,
    });

    await addLog(gameId, {
      round: newRound,
      phase: "MOVE",
      kind: "SYSTEM",
      message: `Ronde ${newRound} gestart.`,
    });

    if (event) {
      await addLog(gameId, {
        round: newRound,
        phase: "MOVE",
        kind: "EVENT",
        cardId: eventId,
        message: event.title,
      });
    }

    if (event && event.type === "ROOSTER") {
      await addLog(gameId, {
        round: newRound,
        phase: "MOVE",
        kind: "EVENT",
        cardId: eventId,
        message: `Rooster Crow (${newRoosterSeen}/3).`,
      });

      if (newRoosterSeen >= 3) {
        await addLog(gameId, {
          round: newRound,
          phase: "MOVE",
          kind: "SYSTEM",
          message:
            "Derde Rooster Crow: na deze ronde eindigt de raid. Er kunnen geen nieuwe rondes meer gestart worden.",
        });
      }
    }
  });

  // 5) Volgende fase (MOVE → ACTIONS → DECISION → REVEAL → MOVE)
  nextPhaseBtn.addEventListener("click", async () => {
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const game = snap.data();

    const current = game.phase || "MOVE";
    let next = "MOVE";
    if (current === "MOVE") next = "ACTIONS";
    else if (current === "ACTIONS") next = "DECISION";
    else if (current === "DECISION") next = "REVEAL";
    else if (current === "REVEAL") next = "MOVE";

    await updateDoc(gameRef, { phase: next });

    const roundNumber = game.round || 0;
    await addLog(gameId, {
      round: roundNumber,
      phase: next,
      kind: "SYSTEM",
      message: `Fase veranderd naar ${next}.`,
    });
  });

  // 6) Ronde afsluiten + scores updaten (nog simpele versie)
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
      // PLAY_SAFE => 0 punten
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

    // Tussenstand loggen
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

    alert("Ronde afgesloten en scores bijgewerkt.");
  });

  // 7) Speel mee als host
  playAsHostBtn.addEventListener("click", async () => {
    const q = query(
      playersColRef,
      where("uid", "==", authUser.uid),
      where("isHost", "==", true)
    );

    const snap = await getDocs(q);
    if (snap.empty) {
      alert("Geen host-speler gevonden. Start het spel opnieuw of join met de code.");
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
