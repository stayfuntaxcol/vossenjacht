import { initAuth } from "./firebase.js";
import { getEventById } from "./cards.js";
import {
  getFirestore,
  doc,
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params   = new URLSearchParams(window.location.search);
const gameId   = params.get("game");
const playerId = params.get("player");

const infoDiv  = document.getElementById("playerInfo");
const roundDiv = document.getElementById("roundArea");

let playerName    = "";
let currentRound  = 0;
let currentEvent  = null;
let unsubActions  = null;

initAuth(async () => {
  if (!gameId || !playerId) {
    infoDiv.textContent = "Geen game of speler-id in de URL";
    return;
  }

  // 1) Speler live volgen (naam + score)
  const playerRef = doc(db, "games", gameId, "players", playerId);

  onSnapshot(playerRef, (snap) => {
    if (!snap.exists()) {
      infoDiv.textContent = "Speler niet gevonden";
      return;
    }
    const player = snap.data();
    playerName = player.name;
    const score = player.score || 0;
    infoDiv.textContent = `Je bent: ${player.name} – score: ${score}`;
  });

  // 2) Game volgen: status, ronde, event
  const gameRef = doc(db, "games", gameId);

  onSnapshot(gameRef, (gameSnap) => {
    if (!gameSnap.exists()) {
      roundDiv.textContent = "Spel niet gevonden";
      return;
    }

    const game = gameSnap.data();
    const roundNumber = game.round || 0;

    if (game.currentEventId) {
      currentEvent = getEventById(game.currentEventId);
    } else {
      currentEvent = null;
    }

    // spel is afgelopen
    if (game.status === "finished") {
      roundDiv.textContent =
        "Spel afgelopen. Bekijk de eindstand op het grote scherm.";
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    // geen actieve ronde
    if (game.status !== "round") {
      roundDiv.textContent = "Wachten op volgende ronde...";
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    // Nieuwe ronde? → nieuwe listener op eigen actie
    if (currentRound === roundNumber && unsubActions) {
      return;
    }

    currentRound = roundNumber;
    watchOwnAction();
  });
});

// 3) Luisteren of jij al een keuze hebt gemaakt in deze ronde
function watchOwnAction() {
  roundDiv.innerHTML = `<p>Ronde ${currentRound}: laden...</p>`;

  const actionsCol = collection(db, "games", gameId, "actions");
  const actionsQuery = query(
    actionsCol,
    where("round", "==", currentRound),
    where("playerId", "==", playerId)
  );

  if (unsubActions) unsubActions();
  unsubActions = onSnapshot(actionsQuery, (snap) => {
    if (snap.empty) {
      // Nog geen keuze → knoppen tonen
      showChoiceButtons();
    } else {
      // Keuze al gemaakt
      const action = snap.docs[0].data();
      roundDiv.innerHTML =
        `<p>Ronde ${currentRound}: je hebt gekozen: ${action.choice}.</p>` +
        `<p>Wachten op de anderen...</p>`;
    }
  });
}

function showChoiceButtons() {
  roundDiv.innerHTML = "";

  // Event-kaart tonen boven de knoppen
  if (currentEvent) {
    const evTitle = document.createElement("h
