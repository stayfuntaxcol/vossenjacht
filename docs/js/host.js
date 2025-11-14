import { initAuth } from "./firebase.js";
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  onSnapshot,
  updateDoc,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");

const gameInfo   = document.getElementById("gameInfo");
const playersDiv = document.getElementById("playersList");
const roundInfo  = document.getElementById("roundInfo");
const startBtn   = document.getElementById("startRoundBtn");

let currentRound = 0;
let unsubActions = null;

if (!gameId) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async () => {
  if (!gameId) return;

  const gameRef = doc(db, "games", gameId);

  // 1) Game live volgen (code, status, ronde)
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    const roundNumber = game.round || 0;

    gameInfo.textContent =
      `Code: ${game.code} – Status: ${game.status} – Ronde: ${roundNumber}`;

    if (game.status !== "round") {
      roundInfo.textContent = "Nog geen actieve ronde.";
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
      roundInfo.innerHTML = `<h2>Ronde ${currentRound}</h2>`;
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

  // 2) Spelers live volgen
  const playersCol = collection(db, "games", gameId, "players");
  onSnapshot(playersCol, (snapshot) => {
    playersDiv.innerHTML = "<h2>Spelers</h2>";
    snapshot.forEach((pDoc) => {
      const p = pDoc.data();
      const div = document.createElement("div");
      div.textContent = `${p.name} ${p.isHost ? "(host)" : ""} – score: ${p.score}`;
      playersDiv.appendChild(div);
    });
  });

  // 3) Start (volgende) ronde
  startBtn.addEventListener("click", async () => {
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const game = snap.data();

    const newRound = (game.round || 0) + 1;

    await updateDoc(gameRef, {
      status: "round",
      round: newRound,
    });
  });
});
