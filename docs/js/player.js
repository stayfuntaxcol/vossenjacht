console.log("player.js geladen");
// Straks: eigen speler-data laden, keuzes tonen
import { initAuth } from "./firebase.js";
import {
  getFirestore,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params   = new URLSearchParams(window.location.search);
const gameId   = params.get("game");
const playerId = params.get("player");

const infoDiv = document.getElementById("playerInfo");

initAuth(async () => {
  if (!gameId || !playerId) {
    infoDiv.textContent = "Geen game of speler-id in de URL";
    return;
  }

  const playerRef = doc(db, "games", gameId, "players", playerId);
  const snap = await getDoc(playerRef);

  if (!snap.exists()) {
    infoDiv.textContent = "Speler niet gevonden";
    return;
  }

  const player = snap.data();
  infoDiv.textContent = `Je bent: ${player.name}`;
});
