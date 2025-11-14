import { initAuth } from "./firebase.js";
import { getEventForRound, getEventById } from "./cards.js";
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
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");

const gameInfo   = document.getElementById("gameInfo");
const playersDiv = document.getElementById("playersList");
const roundInfo  = document.getElementById("roundInfo");
const startBtn   = document.getElementById("startRoundBtn");
const endBtn     = document.getElementById("endRoundBtn");
const finishBtn  = document.getElementById("finishGameBtn");

let currentRound = 0;
let unsubActions = null;

if (!gameId) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async () => {
  if (!gameId) return;

  const gameRef = doc(db, "games", gameId);

  // 1) Game live volgen (code, status, ronde, event)
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    const roundNumber = game.round || 0;
    const event =
      game.currentEventId ? getEventById(game.currentEventId) : null;

    gameInfo.textContent =
      `Code: ${game.code} – Status: ${game.status} – Ronde: ${roundNumber}`;

    if (game.status !== "round") {
      if (game.status === "finished") {
        roundInfo.textContent = "Spel afgelopen. Bekijk de eindstand hieronder.";
      } else {
        roundInfo.textContent = "Nog geen actieve ronde.";
      }
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    // Als de ronde verandert: nieuwe listener op acties
    if (currentRound === roundNumber && unsubActions) {
      return;
    }

    currentRound = roundNumber;

    const actionsCol   = collection(db, "games", gameId, "actions");
    const actionsQuery = query(actionsCol, where("round", "==", currentRound));

    if (unsubActions) unsubActions();
    unsubActions = onSnapshot(actionsQuery, (snapActions) => {
      roundInfo.innerHTML = "";

      // Event-kaart tonen
      if (event) {
        const h2 = document.createElement("h2");
        h2.textContent = `Ronde ${roundNumber}: ${event.title}`;
        const pText = document.createElement("p");
        pText.textContent = event.text;
        roundInfo.appendChild(h2);
        roundInfo.appendChild(pText);
      } else {
        const h2 = document.createElement("h2");
        h2.textContent = `Ronde ${roundNumber}`;
        roundInfo.appendChild(h2);
      }

      // Overzicht keuzes
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

  // 2) Spelers live volgen (en eindstand tonen)
  const playersCol = collection(db, "games", gameId, "players");
  onSnapshot(playersCol, (snapshot) => {
    // sorteer op score aflopend
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push({ id: pDoc.id, ...pDoc.data() });
    });
    players.sort((a, b) => (b.score || 0) - (a.score || 0));

    playersDiv.innerHTML = "<h2>Spelers / Eindstand</h2>";
    players.forEach((p, index) => {
      const div = document.createElement("div");
      const plek = index + 1;
      div.textContent =
        `${plek}. ${p.name} ${p.isHost ? "(host)" : ""} – score: ${p.score || 0}`;
      playersDiv.appendChild(div);
    });
  });

  // 3) Start (volgende) ronde
  startBtn.addEventListener("click", async () => {
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const game = snap.data();

    // Als spel al finished is: niet meer starten
    if (game.status === "finished") {
      alert("Spel is al beëindigd.");
      return;
    }

    const newRound = (game.round || 0) + 1;
    const event = getEventForRound(newRound);

    await updateDoc(gameRef, {
      status: "round",
      round: newRound,
      currentEventId: event ? event.id : null,
    });
  });

  // 4) Ronde afsluiten + scores updaten
  endBtn.addEventListener("click", async () => {
    const gameSnap = await getDoc(gameRef);
    if (!gameSnap.exists()) return;
    const game = gameSnap.data();
    const roundNumber = game.round || 0;

    if (game.status !== "round" || roundNumber === 0) {
      alert("Er is geen actieve ronde om af te sluiten.");
      return;
    }

    // alle acties van deze ronde ophalen
    const actionsCol   = collection(db, "games", gameId, "actions");
    const actionsQuery = query(actionsCol, where("round", "==", roundNumber));
    const actionsSnap  = await getDocs(actionsQuery);

    // simpele regel:
    // GRAB_LOOT  => +1 punt
    // PLAY_SAFE  => 0 punten
    const scoreChanges = {}; // playerId -> delta score

    actionsSnap.forEach((aDoc) => {
      const a = aDoc.data();
      if (!a.playerId) return;
      if (a.choice === "GRAB_LOOT") {
        scoreChanges[a.playerId] = (scoreChanges[a.playerId] || 0) + 1;
      }
    });

    // spelers ophalen en scores bijwerken
    const playersCol   = collection(db, "games", gameId, "players");
    const playersSnap  = await getDocs(playersCol);

    const updates = [];
    playersSnap.forEach((pDoc) => {
      const p = pDoc.data();
      const delta = scoreChanges[pDoc.id] || 0;
      const newScore = (p.score || 0) + delta;
      updates.push(updateDoc(pDoc.ref, { score: newScore }));
    });

    await Promise.all(updates);

    // game terug naar lobby (nog niet finished)
    await updateDoc(gameRef, {
      status: "lobby",
    });

    alert("Ronde afgesloten en scores bijgewerkt.");
  });

  // 5) Spel definitief beëindigen
  finishBtn.addEventListener("click", async () => {
    const confirmEnd = confirm("Spel beëindigen? Dit is de eindstand.");
    if (!confirmEnd) return;

    await updateDoc(gameRef, {
      status: "finished",
    });

    alert("Spel beëindigd. Eindstand staat op het scherm.");
  });
});
