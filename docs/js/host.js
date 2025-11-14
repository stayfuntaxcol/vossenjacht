import { initAuth } from "./firebase.js";
import { getEventForRound, getEventById } from "./cards.js";
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

let currentRoundNumber      = 0;
let currentRoundForActions  = 0;
let currentPhase            = "MOVE";
let unsubActions            = null;

if (!gameId && gameInfo) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async (authUser) => {
  if (!gameId) return;

  const gameRef = doc(db, "games", gameId);

  // 1) Game live volgen
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    currentRoundNumber = game.round || 0;
    currentPhase       = game.phase || "MOVE";
    const event        = game.currentEventId
      ? getEventById(game.currentEventId)
      : null;

    gameInfo.textContent =
      `Code: ${game.code} – Status: ${game.status} – ` +
      `Ronde: ${currentRoundNumber} – Fase: ${currentPhase}`;

    if (game.status !== "round") {
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

    const actionsCol   = collection(db, "games", gameId, "actions");
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
  const playersColRef = collection(db, "games", gameId, "players");
  onSnapshot(playersColRef, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push({ id: pDoc.id, ...pDoc.data() });
    });

    playersDiv.innerHTML = "<h2>Spelers / Scorebord</h2>";

    // LEAD FOX op basis van join-volgorde
    let leadFoxName = "";
    if (players.length > 0 && currentRoundNumber > 0) {
      const byJoin = [...players].sort((a, b) => {
        if (!a.joinedAt || !b.joinedAt) return 0;
        const aSec = a.joinedAt.seconds || 0;
        const bSec = b.joinedAt.seconds || 0;
        return aSec - bSec;
      });
      const leadIndex = (currentRoundNumber - 1) % byJoin.length;
      leadFoxName = byJoin[leadIndex].name;
    }

    if (leadFoxName) {
      const lf = document.createElement("div");
      lf.textContent = `LEAD FOX deze ronde: ${leadFoxName}`;
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
  const logCol   = collection(db, "games", gameId, "log");
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
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const game = snap.data();

    const newRound = (game.round || 0) + 1;
    const event = getEventForRound(newRound);

    await updateDoc(gameRef, {
      status: "round",
      round: newRound,
      phase: "MOVE",
      currentEventId: event ? event.id : null,
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
        cardId: event.id,
        message: event.title,
      });
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

  // 6) Ronde afsluiten + scores updaten
  endBtn.addEventListener("click", async () => {
    const gameSnap = await getDoc(gameRef);
    if (!gameSnap.exists()) return;
    const game = gameSnap.data();
    const roundNumber = game.round || 0;

    if (game.status !== "round" || roundNumber === 0) {
      alert("Er is geen actieve ronde om af te sluiten.");
      return;
    }

    const actionsCol   = collection(db, "games", gameId, "actions");
    const actionsQuery = query(actionsCol, where("round", "==", roundNumber));
    const actionsSnap  = await getDocs(actionsQuery);

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
