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

const gameInfo      = document.getElementById("gameInfo");
const playersDiv    = document.getElementById("playersList");
const roundInfo     = document.getElementById("roundInfo");
const startBtn      = document.getElementById("startRoundBtn");
const endBtn        = document.getElementById("endRoundBtn");
const playAsHostBtn = document.getElementById("playAsHostBtn");

let currentRound = 0;
let unsubActions = null;

if (!gameId) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async (authUser) => {
  if (!gameId) return;

  const gameRef = doc(db, "games", gameId);

  // 1) Game live volgen (code, status, ronde, event + acties)
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    const roundNumber = game.round || 0;
    const event = game.currentEventId
      ? getEventById(game.currentEventId)
      : null;

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

    // Als de ronde al bekend is en we hebben al een listener, niets doen
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

  // 2) Spelers live volgen (gesorteerd scorebord)
  const playersCol = collection(db, "games", gameId, "players");
  onSnapshot(playersCol, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push({ id: pDoc.id, ...pDoc.data() });
    });

    // sorteer op score (hoog naar laag)
    players.sort((a, b) => (b.score || 0) - (a.score || 0));

    playersDiv.innerHTML = "<h2>Spelers / Scorebord</h2>";
    players.forEach((p, index) => {
      const plek = index + 1;
      const div = document.createElement("div");
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

    const scoreChanges = {}; // playerId -> delta score

    actionsSnap.forEach((aDoc) => {
      const a = aDoc.data();
      if (!a.playerId) return;
      if (a.choice === "GRAB_LOOT") {
        scoreChanges[a.playerId] = (scoreChanges[a.playerId] || 0) + 1;
      }
      // PLAY_SAFE => 0 punten
    });

    // spelers ophalen en scores bijwerken
    const playersColRef = collection(db, "games", gameId, "players");
    const playersSnap   = await getDocs(playersColRef);

    const updates = [];
    playersSnap.forEach((pDoc) => {
      const p = pDoc.data();
      const delta = scoreChanges[pDoc.id] || 0;
      const newScore = (p.score || 0) + delta;
      updates.push(updateDoc(pDoc.ref, { score: newScore }));
    });

    await Promise.all(updates);

    // game terug naar lobby
    await updateDoc(gameRef, {
      status: "lobby",
    });

    alert("Ronde afgesloten en scores bijgewerkt.");
  });

  // 5) Speel mee als host → open player.html voor host-speler
  playAsHostBtn.addEventListener("click", async () => {
    const playersColRef = collection(db, "games", gameId, "players");
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
    const playerId = playerDoc.id;

    // open speler-scherm in nieuwe tab
    window.open(`player.html?game=${gameId}&player=${playerId}`, "_blank");
  });
});
