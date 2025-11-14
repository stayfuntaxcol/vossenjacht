import { initAuth } from "./firebase.js";
import {
  getFirestore,
  doc,
  getDoc,
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

let playerName   = "";
let currentRound = 0;
let unsubActions = null;

initAuth(async () => {
  if (!gameId || !playerId) {
    infoDiv.textContent = "Geen game of speler-id in de URL";
    return;
  }

  // 1) Speler inladen
  const playerRef = doc(db, "games", gameId, "players", playerId);
  const snap = await getDoc(playerRef);

  if (!snap.exists()) {
    infoDiv.textContent = "Speler niet gevonden";
    return;
  }

  const player = snap.data();
  playerName = player.name;
  infoDiv.textContent = `Je bent: ${player.name}`;

  // 2) Game volgen om te zien wanneer een ronde actief is
  const gameRef = doc(db, "games", gameId);
  onSnapshot(gameRef, (gameSnap) => {
    if (!gameSnap.exists()) {
      roundDiv.textContent = "Spel niet gevonden";
      return;
    }

    const game = gameSnap.data();
    const roundNumber = game.round || 0;

    if (game.status !== "round") {
      roundDiv.textContent = "Wachten op volgende ronde...";
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    // Nieuwe ronde? → nieuwe listener op eigen keuze
    if (currentRound === roundNumber && unsubActions) {
      return;
    }

    currentRound = roundNumber;
    watchOwnAction();
  });
});

// 3) Luisteren of jij al een keuze hebt gemaakt in deze ronde
function watchOwnAction() {
  roundDiv.innerHTML = `<p>Ronde ${currentRound}: laad...</p>`;

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

  const title = document.createElement("p");
  title.textContent = `Ronde ${currentRound}: kies je actie`;

  const btnA = document.createElement("button");
  btnA.textContent = "Grijp buit";
  const btnB = document.createElement("button");
  btnB.textContent = "Dek jezelf in";

  btnA.addEventListener("click", () => submitChoice("GRAB_LOOT"));
  btnB.addEventListener("click", () => submitChoice("PLAY_SAFE"));

  roundDiv.appendChild(title);
  roundDiv.appendChild(btnA);
  roundDiv.appendChild(document.createTextNode(" "));
  roundDiv.appendChild(btnB);
}

async function submitChoice(choice) {
  roundDiv.innerHTML = "<p>Keuze verzenden...</p>";

  const actionsCol = collection(db, "games", gameId, "actions");
  await addDoc(actionsCol, {
    round: currentRound,
    playerId,
    playerName,
    choice,
    createdAt: serverTimestamp(),
  });

  // UI wordt daarna door onSnapshot() geüpdatet
}
