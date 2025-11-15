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
const decisionState = document.getElementById("decisionState");

const btnSnatch  = document.getElementById("btnSnatch");
const btnForage  = document.getElementById("btnForage");
const btnScout   = document.getElementById("btnScout");
const btnShift   = document.getElementById("btnShift");
const btnLurk    = document.getElementById("btnLurk");
const btnBurrow  = document.getElementById("btnBurrow");
const btnDash    = document.getElementById("btnDash");

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

function canDecideNow(game, player) {
  if (!game || !player) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "DECISION") return false;
  if (game.raidEndedByRooster) return false;
  if (player.inYard === false) return false;
  if (player.dashed) return false;
  if (player.decision) return false;
  return true;
}

function canPlayActionNow(game, player) {
  if (!game || !player) return false;
  if (game.status !== "round") return false;
  if (game.phase !== "ACTIONS") return false;
  if (game.raidEndedByRooster) return false;
  if (player.inYard === false) return false;
  if (player.dashed) return false;
  return true;
}

function renderGame() {
  if (!currentGame || !gameStatusDiv || !eventInfoDiv) return;

  const g = currentGame;

  gameStatusDiv.textContent =
    `Code: ${g.code} – Ronde: ${g.round || 0} – Fase: ${g.phase || "?"}`;

  eventInfoDiv.innerHTML = "";
  const ev =
    g.currentEventId && g.phase === "REVEAL"
      ? getEventById(g.currentEventId)
      : null;

  if (!ev) {
    const p = document.createElement("p");
    p.textContent = "Nog geen Event Card onthuld (pas zichtbaar bij REVEAL).";
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
  updateDecisionButtonsState();
  renderHand();
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

  lootPanel.innerHTML = "";
  const loot = p.loot || [];
  if (!loot.length) {
    lootPanel.textContent = "Nog geen buit verzameld.";
  } else {
    const list = document.createElement("div");
    list.style.fontSize = "0.9rem";
    loot.forEach((card, idx) => {
      const label = card.t || "Loot";
      const val = card.v || 0;
      const line = document.createElement("div");
      line.textContent = `${idx + 1}. ${label} (waarde ${val})`;
      list.appendChild(line);
    });
    lootPanel.appendChild(list);
  }

  updateMoveButtonsState();
  updateDecisionButtonsState();
  renderHand();
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

  const g = currentGame;
  const p = currentPlayer;
  const canMove = canMoveNow(g, p);
  const moved = g.movedPlayerIds || [];

  btnSnatch.disabled = !canMove;
  btnForage.disabled = !canMove;
  btnScout.disabled  = !canMove;
  btnShift.disabled  = !canMove;

  if (!canMove) {
    if (g.phase !== "MOVE") {
      moveState.textContent = `Je kunt nu geen MOVE doen (fase: ${g.phase}).`;
    } else if (p.inYard === false) {
      moveState.textContent = "Je bent niet meer in de Yard.";
    } else if (p.dashed) {
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

function updateDecisionButtonsState() {
  if (!btnLurk || !btnBurrow || !btnDash || !decisionState) return;

  if (!currentGame || !currentPlayer) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionState.textContent = "Geen game of speler geladen.";
    return;
  }

  const g = currentGame;
  const p = currentPlayer;

  if (g.phase !== "DECISION") {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionState.textContent = "DECISION is nog niet aan de beurt.";
    return;
  }

  if (p.inYard === false) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionState.textContent =
      "Je zit niet meer in de Yard en doet niet mee aan deze DECISION.";
    return;
  }

  if (p.dashed) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionState.textContent =
      "Je hebt al eerder DASH gekozen en doet niet meer mee in de Yard.";
    return;
  }

  if (p.decision) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionState.textContent = `Je DECISION voor deze ronde is: ${p.decision}.`;
    return;
  }

  const can = canDecideNow(g, p);
  btnLurk.disabled = !can;
  btnBurrow.disabled = !can;
  btnDash.disabled = !can;

  if (can) {
    decisionState.textContent =
      "Kies jouw DECISION: LURK, BURROW of DASH.";
  } else {
    decisionState.textContent =
      "Je kunt nu geen DECISION kiezen.";
  }
}

function renderHand() {
  if (!handPanel) return;

  handPanel.innerHTML = "";

  if (!currentPlayer || !currentGame) {
    handPanel.textContent = "Geen hand geladen.";
    return;
  }

  const hand = currentPlayer.hand || [];
  if (!hand.length) {
    handPanel.textContent = "Je hebt geen Actiekaarten in je hand.";
    return;
  }

  const canPlay = canPlayActionNow(currentGame, currentPlayer);

  const list = document.createElement("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "0.25rem";

  hand.forEach((card, index) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";

    const label = document.createElement("div");
    label.textContent = `${index + 1}. ${card.name}`;
    label.style.fontSize = "0.9rem";

    const btn = document.createElement("button");
    btn.textContent = "Speel";
    btn.disabled = !canPlay;
    btn.addEventListener("click", () => playActionCard(index));

    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  });

  const phaseInfo = document.createElement("p");
  phaseInfo.style.fontSize = "0.8rem";
  phaseInfo.style.opacity = "0.7";

  if (!canPlay) {
    phaseInfo.textContent =
      "Je kunt alleen kaarten spelen in de ACTIONS-fase terwijl je in de Yard staat.";
  } else {
    phaseInfo.textContent =
      "Speel één of meerdere Actiekaarten. Host bepaalt wanneer de fase eindigt.";
  }

  handPanel.appendChild(list);
  handPanel.appendChild(phaseInfo);
}

async function logMoveAction(game, player, choice, phase = "MOVE") {
  const actionsCol = collection(db, "games", gameId, "actions");
  await addDoc(actionsCol, {
    round: game.round || 0,
    phase,
    playerId,
    playerName: player.name || "",
    choice,
    createdAt: serverTimestamp(),
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase,
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"}: ${choice}`,
  });
}

// ====== MOVE acties ======

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

  await logMoveAction(game, player, "MOVE_SNATCH");
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

  const actionDeck = game.actionDeck ? [...game.actionDeck] : [];
  const hand = player.hand ? [...player.hand] : [];

  if (!actionDeck.length) {
    alert("De Action-deck is leeg. Er zijn geen extra kaarten meer.");
    return;
  }

  let drawn = 0;
  for (let i = 0; i < 2; i++) {
    if (!actionDeck.length) break;
    hand.push(actionDeck.pop());
    drawn++;
  }

  await updateDoc(playerRef, {
    hand,
  });

  await updateDoc(gameRef, {
    actionDeck,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, `MOVE_FORAGE_${drawn}cards`);
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

  const flags = game.flagsRound || {};
  if (flags.scatter) {
    alert("Scatter! is gespeeld: niemand mag Scouten deze ronde.");
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

  const noPeek = flags.noPeek || [];
  if (noPeek.includes(pos)) {
    alert("Deze positie is geblokkeerd door een No-Go Zone.");
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

  await logMoveAction(game, player, `MOVE_SCOUT_${pos}`);
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

  await logMoveAction(game, player, `MOVE_SHIFT_${pos1}<->${pos2}`);
}

// ====== DECISION acties ======

async function selectDecision(kind) {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();

  const playerSnap = await getDoc(playerRef);
  if (!playerSnap.exists()) return;
  const player = playerSnap.data();

  if (!canDecideNow(game, player)) {
    alert("Je kunt nu geen DECISION kiezen.");
    return;
  }

  if (kind === "BURROW" && player.burrowUsed) {
    alert("Je hebt BURROW al eerder gebruikt deze raid.");
    return;
  }

  const update = {
    decision: kind,
  };
  if (kind === "BURROW" && !player.burrowUsed) {
    update.burrowUsed = true;
  }

  await updateDoc(playerRef, update);

  await logMoveAction(game, player, `DECISION_${kind}`, "DECISION");
}

// ====== OPS / Action kaarten ======

async function playActionCard(index) {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) return;
  const game = gameSnap.data();

  const playerSnap = await getDoc(playerRef);
  if (!playerSnap.exists()) return;
  const player = playerSnap.data();

  if (!canPlayActionNow(game, player)) {
    alert("Je kunt nu geen Actiekaarten spelen.");
    return;
  }

  const hand = player.hand ? [...player.hand] : [];
  if (index < 0 || index >= hand.length) return;

  const card = hand[index];
  const cardName = card.name;

  // kaart uit de hand halen
  hand.splice(index, 1);
  await updateDoc(playerRef, { hand });

  await logMoveAction(game, player, `ACTION_${cardName}`, "ACTIONS");

  // effect toepassen voor subset kaarten
  switch (cardName) {
    case "Scatter!":
      await playScatter(gameRef, game, player);
      break;
    case "Den Signal":
      await playDenSignal(gameRef, game, player);
      break;
    case "No-Go Zone":
      await playNoGoZone(gameRef, game, player);
      break;
    case "Kick Up Dust":
      await playKickUpDust(gameRef, game, player);
      break;
    case "Burrow Beacon":
      await playBurrowBeacon(gameRef, game, player);
      break;
    default:
      alert(
        "Deze kaart is nog niet volledig geïmplementeerd in de online versie. Gebruik evt. de fysieke regels als huisregel."
      );
      break;
  }
}

async function playScatter(gameRef, game, player) {
  const flags = {
    lockEvents: false,
    scatter: true,
    denImmune: {},
    noPeek: [],
    predictions: [],
    ...(game.flagsRound || {}),
  };

  flags.scatter = true;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Scatter! – niemand mag Scouten deze ronde.`,
  });
}

async function playDenSignal(gameRef, game, player) {
  const colorInput = prompt(
    "Den Signal – welke Den kleur wil je beschermen? (RED / BLUE / GREEN / YELLOW)"
  );
  if (!colorInput) return;
  const color = colorInput.trim().toUpperCase();
  if (!["RED", "BLUE", "GREEN", "YELLOW"].includes(color)) {
    alert("Ongeldige kleur.");
    return;
  }

  const flags = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    ...(game.flagsRound || {}),
  };

  flags.denImmune = flags.denImmune || {};
  flags.denImmune[color] = true;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Den Signal – Den ${color} is immuun voor vang-events deze ronde.`,
  });
}

async function playNoGoZone(gameRef, game, player) {
  const track = game.eventTrack || [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return;
  }

  const maxPos = track.length;
  const posStr = prompt(`No-Go Zone – blokkeer een eventpositie (1-${maxPos})`);
  if (!posStr) return;
  const pos = parseInt(posStr, 10);
  if (Number.isNaN(pos) || pos < 1 || pos > maxPos) {
    alert("Ongeldige positie.");
    return;
  }

  const flags = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    ...(game.flagsRound || {}),
  };

  const noPeek = flags.noPeek || [];
  if (!noPeek.includes(pos)) noPeek.push(pos);
  flags.noPeek = noPeek;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt No-Go Zone – scout op positie ${pos} is verboden.`,
  });
}

async function playKickUpDust(gameRef, game, player) {
  const track = game.eventTrack ? [...game.eventTrack] : [];
  if (track.length < 2) {
    alert("Te weinig events om te shuffelen.");
    return;
  }

  const i1 = Math.floor(Math.random() * track.length);
  let i2 = Math.floor(Math.random() * track.length);
  if (i2 === i1) {
    i2 = (i2 + 1) % track.length;
  }

  const tmp = track[i1];
  track[i1] = track[i2];
  track[i2] = tmp;

  await updateDoc(gameRef, {
    eventTrack: track,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Kick Up Dust – twee events wisselen willekeurig van plek.`,
  });
}

async function playBurrowBeacon(gameRef, game, player) {
  const flags = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    ...(game.flagsRound || {}),
  };

  flags.lockEvents = true;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Burrow Beacon – Event Track kan deze ronde niet meer veranderen.`,
  });
}

// ====== INIT ======

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

  btnSnatch.addEventListener("click", performSnatch);
  btnForage.addEventListener("click", performForage);
  btnScout.addEventListener("click", performScout);
  btnShift.addEventListener("click", performShift);

  btnLurk.addEventListener("click", () => selectDecision("LURK"));
  btnBurrow.addEventListener("click", () => selectDecision("BURROW"));
  btnDash.addEventListener("click", () => selectDecision("DASH"));
});
