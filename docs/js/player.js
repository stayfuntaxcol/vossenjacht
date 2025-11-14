import { initAuth } from "./firebase.js";
import { addLog } from "./log.js";
import { getEventById } from "./cards.js";
import {
  getFirestore,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  collection,
  addDoc,
  serverTimestamp,
  arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");
const playerId = params.get("player");

const gameStatusDiv = document.getElementById("gameStatus");
const playerInfoDiv = document.getElementById("playerInfo");
const eventInfoDiv  = document.getElementById("eventInfo");
const lootPanel     = document.getElementById("lootPanel");
const handPanel     = document.getElementById("handPanel");
const moveState     = document.getElementById("moveState");

const btnSnatch = document.getElementById("btnSnatch");
const btnForage = document.getElementById("btnForage");
const btnScout  = document.getElementById("btnScout");
const btnShift  = document.getElementById("btnShift");

let gameRef = null;
let playerRef = null;

let currentGame = null;
let currentPlayer = null;

if (!gameId || !playerId) {
  if (gameStatusDiv) {
    gameStatusDiv.textContent = "Ontbrekende game- of speler-id in de URL.";
  }
}

function canMoveNow(game, player) {
  if (!game || !player) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "MOVE") return false;
  if (game.raidEndedByRooster) return false;
  if (player.inYard === false) return false;
  if (player.dashed) return false;

  const moved = game.movedPlayerIds || [];
  return !moved.includes(playerId);
}

function renderGame() {
  if (!currentGame || !gameStatusDiv || !eventInfoDiv) return;

  const g = currentGame;

  gameStatusDiv.textContent =
    `Code: ${g.code} – Ronde: ${g.round || 0} – Fase: ${g.phase || "?"}`;

  // Event info
  eventInfoDiv.innerHTML = "";
  const ev = g.currentEventId ? getEventById(g.currentEventId) : null;

  if (!ev) {
    const p = document.createElement("p");
    p.textContent = "Nog geen event geactiveerd.";
    eventInfoDiv.appendChild(p);
  } else {
    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.textContent = ev.title;
    const text = document.createElement("div");
    text.style.fontSize = "0.9rem";
    text.style.opacity = "0.85";
    text.textContent = ev.text || "";
    eventInfoDiv.appendChild(title);
    eventInfoDiv.appendChild(text);
  }

  updateMoveButtonsState();
}

function renderPlayer() {
  if (!currentPlayer || !playerInfoDiv) return;

  const p = currentPlayer;
  playerInfoDiv.innerHTML = "";

  const nameLine = document.createElement("div");
  nameLine.textContent = p.name || "(naam onbekend)";
  nameLine.style.fontWeight = "600";
  playerInfoDiv.appendChild(nameLine);

  const colorLine = document.createElement("div");
  colorLine.style.fontSize = "0.9rem";
  colorLine.style.opacity = "0.85";
  colorLine.textContent = `Den kleur: ${p.color || "nog niet toegewezen"}`;
  playerInfoDiv.appendChild(colorLine);

  const stateLine = document.createElement("div");
  stateLine.style.fontSize = "0.9rem";
  stateLine.style.marginTop = "0.25rem";

  if (p.dashed) {
    stateLine.textContent = "Status: DASHED (je hebt de Yard verlaten met buit).";
  } else if (p.inYard === false) {
    stateLine.textContent = "Status: gevangen (niet meer in de Yard).";
  } else {
    stateLine.textContent = "Status: in de Yard.";
  }
  playerInfoDiv.appendChild(stateLine);

  // Loot tonen
  lootPanel.innerHTML = "";
  const loot = p.loot || [];
  if (!loot.length) {
    lootPanel.textContent = "Nog geen buit verzameld.";
  } else {
    const list = document.createElement("div");
    list.style.fontSize = "0.9rem";
    loot.forEach((card, idx) => {
      const line = document.createElement("div");
      const label = card.t || "Loot";
      const val = card.v || 0;
      line.textContent = `${idx + 1}. ${label} (waarde ${val})`;
      list.appendChild(line);
    });
    lootPanel.appendChild(list);
  }

  // Hand (voor later – nu alleen debug weergave)
  handPanel.innerHTML = "";
  const hand = p.hand || [];
  if (!hand.length) {
    handPanel.textContent =
      "Je hebt nog geen Actiekaarten of ze zijn nog niet getrokken.";
  } else {
    const h = document.createElement("div");
    h.style.fontSize = "0.9rem";
    h.textContent =
      "Je hand (wordt later actief in de OPS-fase): " +
      hand.map((c) => c.name).join(", ");
    handPanel.appendChild(h);
  }

  updateMoveButtonsState();
}

function updateMoveButtonsState() {
  if (!btnSnatch || !btnForage || !btnScout || !btnShift || !moveState) return;

  if (!currentGame || !currentPlayer) {
    btnSnatch.disabled = true;
    btnForage.disabled = true;
    btnScout.disabled  = true;
    btnShift.disabled  = true;
    moveState.textContent = "Geen game of speler geladen.";
    return;
  }

  const canMove = canMoveNow(currentGame, currentPlayer);

  btnSnatch.disabled = !canMove;
  btnForage.disabled = !canMove;
  btnScout.disabled  = !canMove;
  btnShift.disabled  = !canMove;

  const g = currentGame;
  const moved = g.movedPlayerIds || [];

  if (!canMove) {
    if (g.phase !== "MOVE") {
      moveState.textContent = `Je kunt nu geen MOVE doen (fase: ${g.phase}).`;
    } else if (currentPlayer.inYard === false) {
      moveState.textContent = "Je bent niet meer in de Yard.";
    } else if (currentPlayer.dashed) {
      moveState.textContent = "Je hebt al DASH gekozen in een eerdere ronde.";
    } else if (moved.includes(playerId)) {
      moveState.textContent = "Je hebt jouw MOVE voor deze ronde al gedaan.";
    } else if (g.status !== "round") {
      moveState.textContent = "Er is nog geen actieve ronde.";
    } else {
      moveState.textContent = "Je kunt nu geen MOVE doen.";
    }
  } else {
    moveState.textContent =
      "Je kunt één MOVE doen: Snatch, Forage, Scout of Shift.";
  }
}

async function logMoveAction(game, player, choice) {
  const actionsCol = collection(db, "games", gameId, "actions");
  await addDoc(actionsCol, {
    round: game.round || 0,
    phase: "MOVE",
    playerId,
    playerName: player.name || "",
    choice,
    createdAt: serverTimestamp(),
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "MOVE",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} doet MOVE: ${choice}`,
  });
}

async function performSnatch() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();

  const playerSnap = await getDoc(playerRef);
  if (!playerSnap.exists()) return;
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const sack = game.sack ? [...game.sack] : [];
  if (!sack.length) {
    alert("Er ligt geen buit in de Sack om te pakken.");
    return;
  }

  const card = sack.pop();
  const loot = player.loot ? [...player.loot] : [];
  loot.push(card);

  await updateDoc(playerRef, {
    loot,
  });

  await updateDoc(gameRef, {
    sack,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, "SNATCH");
}

async function performForage() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();

  const playerSnap = await getDoc(playerRef);
  if (!playerSnap.exists()) return;
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const lootDeck = game.lootDeck ? [...game.lootDeck] : [];
  const sack = game.sack ? [...game.sack] : [];

  if (!lootDeck.length) {
    alert("De loot-deck is leeg. Er is geen extra buit meer te vinden.");
    return;
  }

  const card = lootDeck.pop();
  sack.push(card);

  await updateDoc(gameRef, {
    lootDeck,
    sack,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, "FORAGE");
}

async function performScout() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();

  const playerSnap = await getDoc(playerRef);
  if (!playerSnap.exists()) return;
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const track = game.eventTrack || [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return;
  }

  const posStr = prompt(
    `Welke event-positie wil je scouten? (1-${track.length})`
  );
  if (!posStr) return;
  const pos = parseInt(posStr, 10);
  if (Number.isNaN(pos) || pos < 1 || pos > track.length) {
    alert("Ongeldige positie.");
    return;
  }

  const idx = pos - 1;
  const eventId = track[idx];
  const ev = getEventById(eventId);

  alert(
    `Je scout Event #${pos}: ` + (ev ? ev.title : eventId || "Onbekend event")
  );

  await updateDoc(gameRef, {
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, `SCOUT #${pos}`);
}

async function performShift() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();

  const playerSnap = await getDoc(playerRef);
  if (!playerSnap.exists()) return;
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const flags = game.flagsRound || {};
  if (flags.lockEvents) {
    alert("Events zijn gelocked (Beacon actief). Je kunt niet meer shiften.");
    return;
  }

  const track = game.eventTrack ? [...game.eventTrack] : [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return;
  }

  const maxPos = track.length;
  const pos1Str = prompt(`SHIFT – eerste positie (1-${maxPos})`);
  if (!pos1Str) return;
  const pos2Str = prompt(`SHIFT – tweede positie (1-${maxPos})`);
  if (!pos2Str) return;

  const pos1 = parseInt(pos1Str, 10);
  const pos2 = parseInt(pos2Str, 10);

  if (
    Number.isNaN(pos1) ||
    Number.isNaN(pos2) ||
    pos1 < 1 ||
    pos1 > maxPos ||
    pos2 < 1 ||
    pos2 > maxPos ||
    pos1 === pos2
  ) {
    alert("Ongeldige posities voor SHIFT.");
    return;
  }

  const i1 = pos1 - 1;
  const i2 = pos2 - 1;

  const tmp = track[i1];
  track[i1] = track[i2];
  track[i2] = tmp;

  await updateDoc(gameRef, {
    eventTrack: track,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, `SHIFT ${pos1}<->${pos2}`);
}

// Init
initAuth(async (user) => {
  if (!gameId || !playerId) return;

  gameRef = doc(db, "games", gameId);
  playerRef = doc(db, "games", gameId, "players", playerId);

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      if (gameStatusDiv) gameStatusDiv.textContent = "Spel niet gevonden.";
      return;
    }
    currentGame = { id: snap.id, ...snap.data() };
    renderGame();
  });

  onSnapshot(playerRef, (snap) => {
    if (!snap.exists()) {
      if (playerInfoDiv) playerInfoDiv.textContent = "Speler niet gevonden.";
      return;
    }
    currentPlayer = { id: snap.id, ...snap.data() };
    renderPlayer();
  });

  // Buttons
  btnSnatch.addEventListener("click", performSnatch);
  btnForage.addEventListener("click", performForage);
  btnScout.addEventListener("click", performScout);
  btnShift.addEventListener("click", performShift);
});
