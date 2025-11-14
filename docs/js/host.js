import { initAuth } from "./firebase.js";
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");

const gameInfo   = document.getElementById("gameInfo");
const playersDiv = document.getElementById("playersList");

if (!gameId) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async () => {
  const gameRef = doc(db, "games", gameId);
  const gameSnap = await getDoc(gameRef);

  if (!gameSnap.exists()) {
    gameInfo.textContent = "Spel niet gevonden";
    return;
  }

  const game = gameSnap.data();
  gameInfo.textContent = `Code: ${game.code} – Status: ${game.status}`;

  const playersCol = collection(db, "games", gameId, "players");
  onSnapshot(playersCol, (snapshot) => {
    playersDiv.innerHTML = "<h2>Spelers</h2>";
    snapshot.forEach((pDoc) => {
      const p = pDoc.data();
      const div = document.createElement("div");
      div.textContent = `${p.name} ${p.isHost ? "(host)" : ""}`;
      playersDiv.appendChild(div);
    });
  });
});
