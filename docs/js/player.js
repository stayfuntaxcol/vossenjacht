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
let currentPhase  = "MOVE";
let unsubActions  = null;
let currentUid    = null;

initAuth(async (authUser) => {
  currentUid = authUser.uid;

  if (!gameId || !playerId) {
    infoDiv.textContent = "Geen game of speler-id in de URL";
    return;
  }

  // Speler volgen (naam + score)
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

  // Huidige winnaar tonen
  const playersCol = collection(db, "games", gameId, "players");
  const winnerDiv = document.createElement("div");
  winnerDiv.id = "winnerInfo";
  winnerDiv.className = "winner-info";
  infoDiv.insertAdjacentElement("afterend", winnerDiv);

  onSnapshot(playersCol, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push(pDoc.data());
    });

    if (players.length === 0) {
      winnerDiv.textContent = "";
      return;
    }

    players.sort((a, b) => (b.score || 0) - (a.score || 0));
    const topScore = players[0].score || 0;
    const leaders = players.filter((p) => (p.score || 0) === topScore);

    if (topScore === 0) {
      winnerDiv.textContent = "Nog geen punten uitgedeeld.";
      return;
    }

    if (leaders.length === 1) {
      winnerDiv.textContent =
        `Huidige winnaar: ${leaders[0].name} – ${topScore} punten`;
    } else {
      const names = leaders.map((p) => p.name).join(", ");
      winnerDiv.textContent =
        `Gelijkspel: ${names} – ${topScore} punten`;
    }
  });

  // Game volgen (status, ronde, fase, event)
  const gameRef = doc(db, "games", gameId);
  onSnapshot(gameRef, (gameSnap) => {
    if (!gameSnap.exists()) {
      roundDiv.textContent = "Spel niet gevonden";
      return;
    }

    const game = gameSnap.data();
    const roundNumber = game.round || 0;
    currentPhase = game.phase || "MOVE";

    if (game.currentEventId) {
      currentEvent = getEventById(game.currentEventId);
    } else {
      currentEvent = null;
    }

    if (game.status !== "round") {
      roundDiv.textContent = "Wachten op volgende ronde...";
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    if (currentRound === roundNumber && unsubActions) {
      return;
    }

    currentRound = roundNumber;
    watchOwnAction();
  });
});

// Check of deze speler al een keuze heeft
function watchOwnAction() {
  roundDiv.innerHTML = `<p>Ronde ${currentRound} – fase: ${currentPhase}</p>`;

  const actionsCol = collection(db, "games", gameId, "actions");
  const actionsQuery = query(
    actionsCol,
    where("round", "==", currentRound),
    where("playerId", "==", playerId)
  );

  if (unsubActions) unsubActions();
  unsubActions = onSnapshot(actionsQuery, (snap) => {
    if (snap.empty) {
      showChoiceButtons();
    } else {
      const action = snap.docs[0].data();
      roundDiv.innerHTML =
        `<p>Ronde ${currentRound}: je hebt gekozen: ${action.choice}.</p>` +
        `<p>Wachten op de anderen...</p>`;
    }
  });
}

function showChoiceButtons() {
  roundDiv.innerHTML = "";

  const header = document.createElement("p");
  header.textContent = `Ronde ${currentRound} – fase: ${currentPhase}`;
  roundDiv.appendChild(header);

  if (currentEvent) {
    const evTitle = document.createElement("h2");
    evTitle.textContent = currentEvent.title;
    const evText = document.createElement("p");
    evText.textContent = currentEvent.text;
    roundDiv.appendChild(evTitle);
    roundDiv.appendChild(evText);
  } else {
    const title = document.createElement("p");
    title.textContent = "Kies je actie";
    roundDiv.appendChild(title);
  }

  const btnA = document.createElement("button");
  btnA.textContent = "Grijp buit";
  const btnB = document.createElement("button");
  btnB.textContent = "Dek jezelf in";

  btnA.addEventListener("click", () => submitChoice("GRAB_LOOT"));
  btnB.addEventListener("click", () => submitChoice("PLAY_SAFE"));

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
    playerUid: currentUid,
    choice,
    createdAt: serverTimestamp(),
  });
}
