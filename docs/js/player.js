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
const opsTurnInfo   = document.getElementById("opsTurnInfo");

const btnSnatch  = document.getElementById("btnSnatch");
const btnForage  = document.getElementById("btnForage");
const btnScout   = document.getElementById("btnScout");
const btnShift   = document.getElementById("btnShift");
const btnLurk    = document.getElementById("btnLurk");
const btnBurrow  = document.getElementById("btnBurrow");
const btnDash    = document.getElementById("btnDash");
const btnPass    = document.getElementById("btnPass");

let gameRef = null;
let playerRef = null;

let currentGame = null;
let currentPlayer = null;

// Feedback onder OPS-panel
let actionFeedbackEl = null;

function ensureActionFeedbackEl() {
  if (actionFeedbackEl) return;
  const parent = handPanel ? handPanel.parentElement : null;
  if (!parent) return;

  const p = document.createElement("p");
  p.id = "actionFeedback";
  p.className = "small-note";
  p.style.marginTop = "0.5rem";
  p.style.fontSize = "0.85rem";
  p.style.opacity = "0.8";

  parent.appendChild(p);
  actionFeedbackEl = p;
}

function setActionFeedback(msg) {
  ensureActionFeedbackEl();
  if (!actionFeedbackEl) return;

  if (!msg) {
    actionFeedbackEl.textContent = "";
    return;
  }

  const time = new Date().toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  actionFeedbackEl.textContent = `[${time}] ${msg}`;
}

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

function isMyOpsTurn(game, player) {
  if (!game || !player) return false;
  if (game.phase !== "ACTIONS") return false;
  const order = game.opsTurnOrder || [];
  if (!order.length) return false;
  const idx =
    typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  if (idx < 0 || idx >= order.length) return false;
  return order[idx] === player.id;
}

// === RENDERING ===

function renderGame() {
  if (!currentGame || !gameStatusDiv || !eventInfoDiv) return;

  const g = currentGame;

  gameStatusDiv.textContent =
    `Code: ${g.code} – Ronde: ${g.round || 0} – Fase: ${g.phase || "?"}`;

  // OPS-feedback wissen zodra we uit ACTIONS gaan
  if (g.phase !== "ACTIONS") {
    setActionFeedback("");
  }

  // Event info alleen tonen bij REVEAL
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
    stateLine.textContent =
      "Status: DASHED (je hebt de Yard verlaten met buit).";
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
      moveState.textContent =
        "Je hebt al DASH gekozen in een eerdere ronde.";
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
    if (opsTurnInfo) opsTurnInfo.textContent = "";
    return;
  }

  const g = currentGame;
  const p = currentPlayer;

  const hand = p.hand || [];
  if (!hand.length) {
    handPanel.textContent = "Je hebt geen Actiekaarten in je hand.";
  } else {
    const canPlay = canPlayActionNow(g, p);
    const myTurn  = isMyOpsTurn(g, p);

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
      btn.disabled = !(canPlay && myTurn);
      btn.addEventListener("click", () => playActionCard(index));

      row.appendChild(label);
      row.appendChild(btn);
      list.appendChild(row);
    });

    handPanel.appendChild(list);

    const canPlay = canPlayActionNow(g, p);
    const myTurn2 = isMyOpsTurn(g, p);

    if (opsTurnInfo) {
      if (g.phase !== "ACTIONS") {
        opsTurnInfo.textContent = "OPS-fase is nu niet actief.";
      } else if (!canPlay) {
        opsTurnInfo.textContent =
          "Je kunt nu geen Action Cards spelen (niet in de Yard of al gedashed).";
      } else if (!myTurn2) {
        opsTurnInfo.textContent =
          "Niet jouw beurt in OPS – wacht tot je weer aan de beurt bent.";
      } else {
        opsTurnInfo.textContent =
          "Jij bent nu aan de beurt in OPS – speel één kaart of kies PASS.";
      }
    }

    if (btnPass) {
      btnPass.disabled = !(canPlay && myTurn2);
    }
  }

  if (!hand.length && btnPass) {
    const g = currentGame;
    const p = currentPlayer;
    const canPlay = canPlayActionNow(g, p);
    const myTurn  = isMyOpsTurn(g, p);
    btnPass.disabled = !(canPlay && myTurn);
  }

  ensureActionFeedbackEl();
}

// === Log helper ===

async function logMoveAction(
  game,
  player,
  choice,
  phase = "MOVE",
  extra = null
) {
  const actionsCol = collection(db, "games", gameId, "actions");
  const payload = {
    round: game.round || 0,
    phase,
    playerId,
    playerName: player.name || "",
    choice,
    createdAt: serverTimestamp(),
  };
  if (extra) {
    payload.extra = extra;
  }

  await addDoc(actionsCol, payload);

  await addLog(gameId, {
    round: game.round || 0,
    phase,
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"}: ${choice}`,
  });
}

// Kleine helper voor OPS-doorrotatie
function computeNextOpsIndex(game) {
  const order = game.opsTurnOrder || [];
  if (!order.length) return 0;
  const idx =
    typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

// === MOVE acties ===

// SNATCH: trek uit buitstapel (lootDeck), NIET uit de Sack
async function performSnatch() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const lootDeck = Array.isArray(game.lootDeck) ? [...game.lootDeck] : [];

  if (!lootDeck.length) {
    alert("De buitstapel is leeg. Je kunt nu geen SNATCH doen.");
    return;
  }

  const card = lootDeck.pop(); // bovenste kaart
  const loot = Array.isArray(player.loot) ? [...player.loot] : [];
  loot.push(card);

  await updateDoc(playerRef, { loot });

  await updateDoc(gameRef, {
    lootDeck,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, "MOVE_SNATCH_FROM_DECK", "MOVE", {
    lootCard: card,
  });

  const label = card.t || "Loot";
  const val = card.v ?? "?";
  setActionFeedback(
    `SNATCH: je hebt een ${label} (waarde ${val}) uit de buitstapel getrokken.`
  );
}

async function performForage() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const actionDeck = Array.isArray(game.actionDeck)
    ? [...game.actionDeck]
    : [];
  const hand = Array.isArray(player.hand) ? [...player.hand] : [];

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

  await updateDoc(playerRef, { hand });

  await updateDoc(gameRef, {
    actionDeck,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, `MOVE_FORAGE_${drawn}cards`, "MOVE");
}

async function performScout() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
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

  await logMoveAction(game, player, `MOVE_SCOUT_${pos}`, "MOVE");
}

async function performShift() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
  const player = playerSnap.data();

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const flags = game.flagsRound || {};
  if (flags.lockEvents) {
    alert("Events zijn gelocked (Burrow Beacon). Je kunt niet meer shiften.");
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

  await logMoveAction(game, player, `MOVE_SHIFT_${pos1}<->${pos2}`, "MOVE");
}

// === DECISION acties ===

async function selectDecision(kind) {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
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

// === OPS / Action kaarten ===

async function playActionCard(index) {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
  const player = playerSnap.data();

  if (!canPlayActionNow(game, player)) {
    alert("Je kunt nu geen Actiekaarten spelen.");
    return;
  }

  if (!isMyOpsTurn(game, player)) {
    alert("Je bent niet aan de beurt in de OPS-fase.");
    return;
  }

  const hand = Array.isArray(player.hand) ? [...player.hand] : [];
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
      await playScatter(game, player);
      break;
    case "Den Signal":
      await playDenSignal(game, player);
      break;
    case "No-Go Zone":
      await playNoGoZone(game, player);
      break;
    case "Kick Up Dust":
      await playKickUpDust(game, player);
      break;
    case "Burrow Beacon":
      await playBurrowBeacon(game, player);
      break;
    default:
      alert(
        "Deze kaart is nog niet volledig geïmplementeerd in de online versie. Gebruik eventueel de fysieke regels als huisregel."
      );
      break;
  }

  // beurt doorgeven in OPS – en passes resetten
  const nextIndex = computeNextOpsIndex(game);
  await updateDoc(gameRef, {
    opsTurnIndex: nextIndex,
    opsConsecutivePasses: 0,
  });

  setActionFeedback(
    `Je speelde "${cardName}". Het effect is uitgevoerd (zie ook de Community log).`
  );
}

async function passAction() {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
  const player = playerSnap.data();

  if (!canPlayActionNow(game, player)) {
    alert("Je kunt nu geen PASS doen in deze fase.");
    return;
  }

  if (!isMyOpsTurn(game, player)) {
    alert("Je bent niet aan de beurt in de OPS-fase.");
    return;
  }

  const nextIndex = computeNextOpsIndex(game);
  const newPasses = (game.opsConsecutivePasses || 0) + 1;

  await updateDoc(gameRef, {
    opsTurnIndex: nextIndex,
    opsConsecutivePasses: newPasses,
  });

  await logMoveAction(game, player, "ACTION_PASS", "ACTIONS");

  setActionFeedback(
    "Je hebt PASS gekozen. Als de ronde omgaat en iemand weer een kaart speelt, kun je later opnieuw meedoen."
  );
}

// Scatter! – niemand mag Scouten deze ronde
async function playScatter(game, player) {
  const flags = {
    lockEvents: false,
    scatter: false,
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

// Den Signal – 1 Den kleur immuun
async function playDenSignal(game, player) {
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

// No-Go Zone – blokkeer 1 eventpositie voor Scout
async function playNoGoZone(game, player) {
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
    message: `${player.name || "Speler"} speelt No-Go Zone – Scouten op positie ${pos} is verboden.`,
  });
}

// Kick Up Dust – twee events random wisselen
async function playKickUpDust(game, player) {
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

// Burrow Beacon – Event Track kan niet meer veranderen
async function playBurrowBeacon(game, player) {
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

// === INIT ===

initAuth(async () => {
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

  btnPass.addEventListener("click", passAction);
});
