// VOSSENJACHT player.js – fase 2: geen Countermove, eindscorebord & SCOUT preview
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
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");
const playerId = params.get("player");

const gameStatusDiv    = document.getElementById("gameStatus");
const playerInfoDiv    = document.getElementById("playerInfo");
const eventInfoDiv     = document.getElementById("eventInfo");
const lootPanel        = document.getElementById("lootPanel");
const handPanel        = document.getElementById("handPanel");
const moveState        = document.getElementById("moveState");
const decisionState    = document.getElementById("decisionState");
const opsTurnInfo      = document.getElementById("opsTurnInfo");

// Nieuwe labels in de statusbalk van het spelersscherm
const playerPhaseLabel = document.getElementById("playerPhaseLabel");
const playerRoundLabel = document.getElementById("playerRoundLabel");

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

// Feedback onderin het dashboard ("Laatste actie")
let actionFeedbackEl = null;

function ensureActionFeedbackEl() {
  if (actionFeedbackEl) return;

  // In de nieuwe layout bestaat #actionFeedback al in de mini-log
  const existing = document.getElementById("actionFeedback");
  if (existing) {
    actionFeedbackEl = existing;
    return;
  }

  // Fallback: als hij om wat voor reden dan ook ontbreekt, maken we een simpele <p> onder de hand
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
    // Als je liever de standaardtekst uit de HTML behoudt, kun je hier vroegtijdig returnen.
    // Voor nu wissen we de tekst gewoon.
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

/**
 * flagsRound altijd met alle standaard velden vullen.
 */
function mergeRoundFlags(game) {
  const base = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
  };
  return { ...base, ...(game.flagsRound || {}) };
}

function isInYardLocal(p) {
  return p.inYard !== false && !p.dashed;
}

async function fetchPlayersForGame() {
  const col = collection(db, "games", gameId, "players");
  const snap = await getDocs(col);
  const players = [];
  snap.forEach((docSnap) => {
    players.push({ id: docSnap.id, ...docSnap.data() });
  });
  return players;
}

async function chooseOtherPlayerPrompt(title) {
  const players = await fetchPlayersForGame();
  const others = players.filter(
    (p) => p.id !== playerId && isInYardLocal(p)
  );

  if (!others.length) {
    alert("Er zijn geen andere vossen in de Yard om te kiezen.");
    return null;
  }

  const lines = others.map((p, idx) => `${idx + 1}. ${p.name || "Vos"}`);
  const choiceStr = prompt(
    `${title}\n` + lines.join("\n")
  );
  if (!choiceStr) return null;
  const idx = parseInt(choiceStr, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= others.length) {
    alert("Ongeldige keuze.");
    return null;
  }
  return others[idx];
}

async function maybeShowScentCheckInfo(game) {
  const flags = mergeRoundFlags(game);
  const checks = Array.isArray(flags.scentChecks) ? flags.scentChecks : [];
  const myChecks = checks.filter((c) => c.viewerId === playerId);
  if (!myChecks.length) return;

  for (const ch of myChecks) {
    try {
      const pref = doc(db, "games", gameId, "players", ch.targetId);
      const snap = await getDoc(pref);
      if (!snap.exists()) continue;
      const p = snap.data();
      const name = p.name || "Vos";
      const dec = p.decision || "(nog geen keuze)";
      alert(`[Scent Check] ${name} heeft op dit moment DECISION: ${dec}.`);
    } catch (err) {
      console.error("ScentCheck peek error", err);
    }
  }
}

function sortPlayersByJoinOrder(players) {
  return [...players].sort((a, b) => {
    const ao =
      typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo =
      typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
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

// ⚠️ Belangrijk: gebruik playerId uit de URL, niet player.id
function isMyOpsTurn(game) {
  if (!game) return false;
  if (game.phase !== "ACTIONS") return false;
  const order = game.opsTurnOrder || [];
  if (!order.length) return false;
  const idx =
    typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  if (idx < 0 || idx >= order.length) return false;
  return order[idx] === playerId;
}

// === SCOREBORD speler-scherm ===

async function renderPlayerFinalScoreboard() {
  if (!eventInfoDiv) return;
  const g = currentGame;
  if (!g) return;

  const players = await fetchPlayersForGame();
  if (!players.length) {
    eventInfoDiv.textContent = "Geen scorebord beschikbaar.";
    return;
  }

  const sorted = players.sort((a, b) => (b.score || 0) - (a.score || 0));
  const bestScore = sorted.length ? (sorted[0].score || 0) : 0;
  const winners = sorted.filter((p) => (p.score || 0) === bestScore);
  const winnerIds = new Set(winners.map((w) => w.id));

  eventInfoDiv.innerHTML = "";

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.textContent = "Eindscore – Fox Raid";
  eventInfoDiv.appendChild(title);

  const pIntro = document.createElement("div");
  pIntro.style.fontSize = "0.9rem";
  pIntro.style.opacity = "0.85";
  pIntro.textContent = "Het spel is afgelopen. Dit is de ranglijst:";
  eventInfoDiv.appendChild(pIntro);

  if (winners.length && bestScore >= 0) {
    const pWin = document.createElement("div");
    const names = winners.map((w) => w.name || "Vos").join(", ");
    pWin.style.marginTop = "0.25rem";
    pWin.textContent = `🏆 Winnaar(s): ${names} met ${bestScore} punten.`;
    eventInfoDiv.appendChild(pWin);
  }

  const list = document.createElement("ol");
  list.className = "scoreboard-list";
  list.style.marginTop = "0.5rem";

  sorted.forEach((pl) => {
    const li = document.createElement("li");
    const eggs  = pl.eggs  || 0;
    const hens  = pl.hens  || 0;
    const prize = pl.prize || 0;
    const score = pl.score || 0;
    const meTag = pl.id === playerId ? " (jij)" : "";
    const isWinner = winnerIds.has(pl.id);
    const prefix = isWinner ? "🏆 " : "";

    li.textContent = `${prefix}${pl.name || "Vos"} – ${score} punten (P:${prize} H:${hens} E:${eggs})${meTag}`;
    if (isWinner) {
      li.classList.add("scoreboard-winner");
    }
    list.appendChild(li);
  });

  eventInfoDiv.appendChild(list);
}

// === RENDERING ===

function renderGame() {
  if (!currentGame || !gameStatusDiv || !eventInfoDiv) return;

  const g = currentGame;
  const roundLabel = g.round ?? 0;
  const phaseLabel = g.phase || "?";

  // Bovenbalk (header)
  gameStatusDiv.textContent =
    `Code: ${g.code} – Ronde: ${roundLabel} – Fase: ${phaseLabel}`;

  // Statusbalk in het dashboard
  if (playerRoundLabel) {
    playerRoundLabel.textContent = String(roundLabel);
  }
  if (playerPhaseLabel) {
    playerPhaseLabel.textContent = phaseLabel;
  }

  // Spel afgelopen? → alles uit, scorebord tonen
  if (g.status === "finished" || g.phase === "END") {
    setActionFeedback("");
    if (opsTurnInfo) {
      opsTurnInfo.textContent =
        "Het spel is afgelopen – het scorebord is zichtbaar op het Community Board en hieronder.";
    }
    if (btnPass) btnPass.disabled = true;
    renderPlayerFinalScoreboard();
    updateMoveButtonsState();
    updateDecisionButtonsState();
    return;
  }

  // OPS-feedback wissen zodra we uit ACTIONS gaan
  if (g.phase !== "ACTIONS") {
    setActionFeedback("");
  }

  // Event info (SCOUT preview of REVEAL)
  eventInfoDiv.innerHTML = "";
  let ev = null;
  let label = "";

  if (g.phase === "REVEAL" && g.currentEventId) {
    ev = getEventById(g.currentEventId);
    label = "Actueel Event (REVEAL)";
  } else if (
    currentPlayer &&
    currentPlayer.scoutPeek &&
    typeof currentPlayer.scoutPeek.index === "number" &&
    currentPlayer.scoutPeek.round === (g.round || 0)
  ) {
    const peek = currentPlayer.scoutPeek;
    const track = g.eventTrack || [];
    const idx = peek.index;
    if (idx >= 0 && idx < track.length && track[idx] === peek.eventId) {
      ev = getEventById(peek.eventId);
      label = "SCOUT preview (alleen zichtbaar voor jou)";
    }
  }

  if (!ev) {
    const p = document.createElement("p");
    p.textContent =
      "Nog geen Event Card onthuld (pas zichtbaar bij REVEAL of via jouw eigen SCOUT).";
    eventInfoDiv.appendChild(p);
  } else {
    const sub = document.createElement("div");
    sub.style.fontSize = "0.8rem";
    sub.style.opacity = "0.7";
    sub.style.marginBottom = "0.25rem";
    sub.textContent = label;

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.textContent = ev.title;

    const text = document.createElement("div");
    text.style.fontSize = "0.9rem";
    text.style.opacity = "0.85";
    text.textContent = ev.text || "";

    eventInfoDiv.appendChild(sub);
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

  // 1e regel: naam
  const nameLine = document.createElement("div");
  nameLine.textContent = p.name || "(naam onbekend)";
  nameLine.style.fontWeight = "600";
  playerInfoDiv.appendChild(nameLine);

  // 2e regel: Den kleur (tekstueel) – CSS gebruikt nth-child(2)
  const colorLine = document.createElement("div");
  colorLine.style.fontSize = "0.9rem";
  colorLine.style.opacity = "0.85";
  colorLine.textContent = `Den kleur: ${p.color || "nog niet toegewezen"}`;
  playerInfoDiv.appendChild(colorLine);

  // 3e regel: status (YARD / DASH / CAUGHT) – CSS gebruikt nth-child(3)
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

  if (g.status === "finished" || g.phase === "END") {
    btnSnatch.disabled = true;
    btnForage.disabled = true;
    btnScout.disabled  = true;
    btnShift.disabled  = true;
    moveState.textContent =
      "Het spel is afgelopen – je kunt geen MOVE meer doen.";
    return;
  }

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

  if (g.status === "finished" || g.phase === "END") {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionState.textContent =
      "Het spel is afgelopen – geen DECISION meer nodig.";
    return;
  }

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

  if (g.status === "finished" || g.phase === "END") {
    handPanel.textContent =
      "Het spel is afgelopen – je kunt geen Action Cards meer spelen.";
    if (opsTurnInfo) {
      opsTurnInfo.textContent = "Het spel is afgelopen.";
    }
    if (btnPass) btnPass.disabled = true;
    ensureActionFeedbackEl();
    return;
  }

  const hand = p.hand || [];

  const canPlayOverall = canPlayActionNow(g, p);
  const myTurnOverall  = isMyOpsTurn(g);

  if (!hand.length) {
    handPanel.textContent = "Je hebt geen Actiekaarten in je hand.";
    if (opsTurnInfo) {
      if (g.phase !== "ACTIONS") {
        opsTurnInfo.textContent = "OPS-fase is nu niet actief.";
      } else if (!canPlayOverall) {
        opsTurnInfo.textContent =
          "Je kunt nu geen Action Cards spelen (niet in de Yard of al gedashed).";
      } else if (!myTurnOverall) {
        opsTurnInfo.textContent =
          "Niet jouw beurt in OPS – wacht tot je weer aan de beurt bent. Je kunt wel PASS kiezen als je aan de beurt bent.";
      } else {
        opsTurnInfo.textContent =
          "Jij bent nu aan de beurt in OPS – je hebt geen kaarten, je kunt alleen PASS kiezen.";
      }
    }
    if (btnPass) {
      btnPass.disabled = !(canPlayOverall && myTurnOverall);
    }
    ensureActionFeedbackEl();
    return;
  }

  // Simpele tekstweergave per kaart met een Speel-knop
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
    btn.disabled = !(canPlayOverall && myTurnOverall);
    btn.addEventListener("click", () => playActionCard(index));

    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  });

  handPanel.appendChild(list);

  if (opsTurnInfo) {
    if (g.phase !== "ACTIONS") {
      opsTurnInfo.textContent = "OPS-fase is nu niet actief.";
    } else if (!canPlayOverall) {
      opsTurnInfo.textContent =
        "Je kunt nu geen Action Cards spelen (niet in de Yard of al gedashed).";
    } else if (!myTurnOverall) {
      opsTurnInfo.textContent =
        "Niet jouw beurt in OPS – wacht tot je weer aan de beurt bent.";
    } else {
      opsTurnInfo.textContent =
        "Jij bent nu aan de beurt in OPS – speel één kaart of kies PASS.";
    }
  }

  if (btnPass) {
    btnPass.disabled = !(canPlayOverall && myTurnOverall);
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

  const flags = mergeRoundFlags(game);
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

  // Voor deze ronde een persoonlijke preview bijhouden
  await updateDoc(playerRef, {
    scoutPeek: {
      round: game.round || 0,
      index: idx,
      eventId,
    },
  });

  await updateDoc(gameRef, {
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, `MOVE_SCOUT_${pos}`, "MOVE");

  setActionFeedback(
    `SCOUT: je hebt event #${pos} bekeken. Deze ronde zie je deze kaart als persoonlijke preview.`
  );
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

  const flags = mergeRoundFlags(game);
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

  // Eerst Scent Check info tonen, als die er is
  await maybeShowScentCheckInfo(game);

  const flags = mergeRoundFlags(game);
  const ft = flags.followTail || {};
  if (ft[playerId]) {
    setActionFeedback(
      "Follow the Tail is actief: jouw uiteindelijke DECISION zal gelijk worden aan de keuze van de gekozen vos."
    );
  }

  if (!canDecideNow(game, player)) {
    alert("Je kunt nu geen DECISION kiezen.");
    return;
  }

  if (kind === "BURROW" && player.burrowUsed) {
    alert("Je hebt BURROW al eerder gebruikt deze raid.");
    return;
  }

  const label =
    kind === "LURK"
      ? "LURK (blijven)"
      : kind === "BURROW"
      ? "BURROW (schuilen)"
      : kind === "DASH"
      ? "DASH (wegrennen)"
      : kind;

  const ok = confirm(
    `Je staat op het punt ${label} te kiezen als jouw definitieve beslissing voor deze ronde. Bevestigen?`
  );
  if (!ok) {
    setActionFeedback(
      "Je DECISION is nog niet vastgelegd – je kunt nog even nadenken."
    );
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

  if (!isMyOpsTurn(game)) {
    alert("Je bent niet aan de beurt in de OPS-fase.");
    return;
  }

  const hand = Array.isArray(player.hand) ? [...player.hand] : [];
  if (index < 0 || index >= hand.length) return;

  const card = hand[index];
  const cardName = card.name;

  // Hold Still: opsLocked = true → niemand mag nog actiekaarten spelen
  const flagsBefore = mergeRoundFlags(game);
  if (flagsBefore.opsLocked) {
    alert(
      "Hold Still is actief: er mogen geen nieuwe Action Cards meer worden gespeeld. Je kunt alleen PASS kiezen."
    );
    setActionFeedback(
      "Hold Still is actief – speel geen kaarten meer, kies PASS als je aan de beurt bent."
    );
    return;
  }

  // Probeer het effect eerst uit te voeren; alleen bij succes verdwijnt de kaart uit je hand
  let executed = false;

  switch (cardName) {
    case "Scatter!":
      executed = await playScatter(game, player);
      break;
    case "Den Signal":
      executed = await playDenSignal(game, player);
      break;
    case "No-Go Zone":
      executed = await playNoGoZone(game, player);
      break;
    case "Kick Up Dust":
      executed = await playKickUpDust(game, player);
      break;
    case "Burrow Beacon":
      executed = await playBurrowBeacon(game, player);
      break;
    case "Molting Mask":
      executed = await playMoltingMask(game, player);
      break;
    case "Hold Still":
      executed = await playHoldStill(game, player);
      break;
    case "Nose for Trouble":
      executed = await playNoseForTrouble(game, player);
      break;
    case "Scent Check":
      executed = await playScentCheck(game, player);
      break;
    case "Follow the Tail":
      executed = await playFollowTail(game, player);
      break;
    case "Alpha Call":
      executed = await playAlphaCall(game, player);
      break;
    case "Pack Tinker":
      executed = await playPackTinker(game, player);
      break;
    case "Mask Swap":
      executed = await playMaskSwap(game, player);
      break;
    default:
      alert(
        "Deze kaart is nog niet volledig geïmplementeerd in de online versie. Gebruik eventueel de fysieke regels als huisregel."
      );
      executed = false;
      break;
  }

  if (!executed) {
    setActionFeedback(
      `De kaart "${cardName}" kon nu niet worden gespeeld. Hij blijft in je hand.`
    );
    return;
  }

  // kaart uit de hand halen, loggen en beurt doorgeven
  hand.splice(index, 1);
  await updateDoc(playerRef, { hand });

  await logMoveAction(game, player, `ACTION_${cardName}`, "ACTIONS");

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

  if (!isMyOpsTurn(game)) {
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
  const flags = mergeRoundFlags(game);
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

  setActionFeedback(
    "Scatter! is actief – niemand mag Scouten deze ronde."
  );

  return true;
}

// Den Signal – 1 Den kleur immuun
async function playDenSignal(game, player) {
  const colorInput = prompt(
    "Den Signal – welke Den kleur wil je beschermen? (RED / BLUE / GREEN / YELLOW)"
  );
  if (!colorInput) return false;
  const color = colorInput.trim().toUpperCase();
  if (!["RED", "BLUE", "GREEN", "YELLOW"].includes(color)) {
    alert("Ongeldige kleur.");
    return false;
  }

  const flags = mergeRoundFlags(game);

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

  setActionFeedback(
    `Den Signal: Den ${color} is immuun voor vang-events deze ronde.`
  );

  return true;
}

// No-Go Zone – blokkeer 1 eventpositie voor Scout
async function playNoGoZone(game, player) {
  const track = game.eventTrack || [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return false;
  }

  const maxPos = track.length;
  const posStr = prompt(`No-Go Zone – blokkeer een eventpositie (1-${maxPos})`);
  if (!posStr) return false;
  const pos = parseInt(posStr, 10);
  if (Number.isNaN(pos) || pos < 1 || pos > maxPos) {
    alert("Ongeldige positie.");
    return false;
  }

  const flags = mergeRoundFlags(game);

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

  setActionFeedback(
    `No-Go Zone: positie ${pos} kan deze ronde niet gescout worden.`
  );

  return true;
}

// Kick Up Dust – twee events random wisselen
async function playKickUpDust(game, player) {
  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert(
      "Burrow Beacon is actief – de Event Track is gelocked en kan niet meer veranderen."
    );
    return false;
  }

  const track = game.eventTrack ? [...game.eventTrack] : [];
  if (track.length < 2) {
    alert("Te weinig events om te shuffelen.");
    return false;
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

  setActionFeedback(
    "Kick Up Dust: twee Event Cards hebben van positie gewisseld."
  );

  return true;
}

// Burrow Beacon – Event Track kan niet meer veranderen
async function playBurrowBeacon(game, player) {
  const flags = mergeRoundFlags(game);
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

  setActionFeedback(
    "Burrow Beacon: de Event Track is gelocked – geen SHIFT of schudden meer deze ronde."
  );

  return true;
}

// Molting Mask – nieuwe Den kleur (simpele digitale variant)
async function playMoltingMask(game, player) {
  const colors = ["RED", "BLUE", "GREEN", "YELLOW"];
  const current = (player.color || "").toUpperCase();
  const pool = colors.filter((c) => c !== current);
  const newColor =
    pool.length > 0
      ? pool[Math.floor(Math.random() * pool.length)]
      : colors[Math.floor(Math.random() * colors.length)];

  await updateDoc(playerRef, { color: newColor });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Molting Mask – nieuwe Den kleur: ${newColor}.`,
  });

  setActionFeedback(
    `Molting Mask: je Den kleur is nu ${newColor}.`
  );

  return true;
}

// Hold Still – lockt OPS: geen Action Cards meer, alleen PASS
async function playHoldStill(game, player) {
  const flags = mergeRoundFlags(game);
  flags.opsLocked = true;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message:
      `${player.name || "Speler"} speelt Hold Still – geen nieuwe Action Cards meer deze ronde, alleen PASS.`,
  });

  setActionFeedback(
    "Hold Still is actief – er mogen geen Action Cards meer gespeeld worden, alleen PASS."
  );

  return true;
}

// Nose for Trouble – voorspel het volgende Event (alfabetische lijst)
async function playNoseForTrouble(game, player) {
  const track = game.eventTrack || [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return false;
  }

  // Unieke events + titel ophalen en alfabetisch sorteren
  const map = new Map();
  for (const id of track) {
    if (!map.has(id)) {
      const ev = getEventById(id);
      map.set(id, ev ? ev.title : id);
    }
  }

  const options = Array.from(map.entries()).map(([id, title]) => ({
    id,
    title,
  }));
  options.sort((a, b) => a.title.localeCompare(b.title, "nl"));

  const menuLines = options.map(
    (opt, idx) => `${idx + 1}. ${opt.title}`
  );

  const choiceStr = prompt(
    "Nose for Trouble – kies het volgende Event dat je verwacht:\n" +
      menuLines.join("\n")
  );
  if (!choiceStr) return false;
  const idx = parseInt(choiceStr, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
    alert("Ongeldige keuze.");
    return false;
  }

  const chosen = options[idx];
  const chosenId = chosen.id;
  const ev = getEventById(chosenId);

  const flags = mergeRoundFlags(game);
  const preds = Array.isArray(flags.predictions)
    ? [...flags.predictions]
    : [];
  preds.push({
    playerId,
    eventId: chosenId,
  });
  flags.predictions = preds;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Nose for Trouble – voorspelt: ${
      ev ? ev.title : chosenId
    }.`,
  });

  setActionFeedback(
    `Nose for Trouble: je hebt "${ev ? ev.title : chosenId}" voorspeld als volgende Event.`
  );

  return true;
}

// Scent Check – kijk naar DECISION van 1 speler en koppel voor deze ronde
async function playScentCheck(game, player) {
  const target = await chooseOtherPlayerPrompt(
    "Scent Check – kies een vos om te besnuffelen"
  );
  if (!target) return false;

  // Directe peek, als er al een DECISION is
  try {
    const pref = doc(db, "games", gameId, "players", target.id);
    const snap = await getDoc(pref);
    if (snap.exists()) {
      const t = snap.data();
      const dec = t.decision || "(nog geen keuze)";
      alert(
        `[Scent Check] ${t.name || "Vos"} heeft op dit moment DECISION: ${dec}.`
      );
    }
  } catch (err) {
    console.error("ScentCheck immediate peek error", err);
  }

  const flags = mergeRoundFlags(game);
  const list = Array.isArray(flags.scentChecks)
    ? [...flags.scentChecks]
    : [];
  list.push({
    viewerId: playerId,
    targetId: target.id,
  });
  flags.scentChecks = list;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Scent Check op ${
      target.name || "een vos"
    }.`,
  });

  setActionFeedback(
    `Scent Check: je volgt deze ronde de beslissingen van ${target.name || "de gekozen vos"} van dichtbij.`
  );

  return true;
}

// Follow the Tail – jouw DECISION volgt die van een andere speler
async function playFollowTail(game, player) {
  const target = await chooseOtherPlayerPrompt(
    "Follow the Tail – kies een vos om te volgen"
  );
  if (!target) return false;

  const flags = mergeRoundFlags(game);
  const ft = flags.followTail || {};
  ft[playerId] = target.id;
  flags.followTail = ft;

  await updateDoc(gameRef, {
    flagsRound: flags,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Follow the Tail en volgt de keuze van ${
      target.name || "een vos"
    }.`,
  });

  setActionFeedback(
    `Follow the Tail: jouw uiteindelijke DECISION zal gelijk zijn aan die van ${target.name || "de gekozen vos"}.`
  );

  return true;
}

// Alpha Call – kies een nieuwe Lead Fox
async function playAlphaCall(game, player) {
  const players = await fetchPlayersForGame();
  const ordered = sortPlayersByJoinOrder(players);

  if (!ordered.length) {
    alert("Geen spelers gevonden om Lead Fox van te maken.");
    return false;
  }

  const lines = ordered.map((p, idx) => `${idx + 1}. ${p.name || "Vos"}`);
  const choiceStr = prompt(
    "Alpha Call – kies wie de nieuwe Lead Fox wordt:\n" + lines.join("\n")
  );
  if (!choiceStr) return false;
  const idx = parseInt(choiceStr, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= ordered.length) {
    alert("Ongeldige keuze.");
    return false;
  }

  const newLead = ordered[idx];

  await updateDoc(gameRef, {
    leadIndex: idx,
  });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Alpha Call – Lead Fox wordt nu ${
      newLead.name || "een vos"
    }.`,
  });

  setActionFeedback(
    `Alpha Call: Lead Fox is nu ${newLead.name || "de gekozen vos"}.`
  );

  return true;
}

// Pack Tinker – wissel 2 Event-posities naar keuze
async function playPackTinker(game, player) {
  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert(
      "Burrow Beacon is actief – de Event Track is gelocked en kan niet meer veranderen."
    );
    return false;
  }

  const track = game.eventTrack ? [...game.eventTrack] : [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return false;
  }

  const maxPos = track.length;
  const p1Str = prompt(`Pack Tinker – eerste eventpositie (1-${maxPos})`);
  if (!p1Str) return false;
  const p2Str = prompt(`Pack Tinker – tweede eventpositie (1-${maxPos})`);
  if (!p2Str) return false;

  const pos1 = parseInt(p1Str, 10);
  const pos2 = parseInt(p2Str, 10);
  if (
    Number.isNaN(pos1) ||
    Number.isNaN(pos2) ||
    pos1 < 1 ||
    pos1 > maxPos ||
    pos2 < 1 ||
    pos2 > maxPos ||
    pos1 === pos2
  ) {
    alert("Ongeldige posities voor Pack Tinker.");
    return false;
  }

  const i1 = pos1 - 1;
  const i2 = pos2 - 1;

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
    message: `${player.name || "Speler"} speelt Pack Tinker – events op posities ${pos1} en ${pos2} wisselen van plek.`,
  });

  setActionFeedback(
    `Pack Tinker: je hebt events op posities ${pos1} en ${pos2} gewisseld.`
  );

  return true;
}

// Mask Swap – shuffle alle Den-kleuren van vossen in de Yard
async function playMaskSwap(game, player) {
  const players = await fetchPlayersForGame();
  const inYard = players.filter(isInYardLocal);

  if (inYard.length < 2) {
    alert("Te weinig vossen in de Yard om Mask Swap uit te voeren.");
    return false;
  }

  const colors = inYard.map((p) => (p.color || "").toUpperCase());
  for (let i = colors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }

  const updates = [];
  inYard.forEach((p, idx) => {
    const pref = doc(db, "games", gameId, "players", p.id);
    updates.push(updateDoc(pref, { color: colors[idx] || null }));
  });
  await Promise.all(updates);

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Mask Swap – alle Den-kleuren in de Yard worden gehusseld.`,
  });

  setActionFeedback(
    "Mask Swap: Den-kleuren van alle vossen in de Yard zijn gehusseld."
  );

  return true;
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

  if (btnSnatch) btnSnatch.addEventListener("click", performSnatch);
  if (btnForage) btnForage.addEventListener("click", performForage);
  if (btnScout)  btnScout.addEventListener("click", performScout);
  if (btnShift)  btnShift.addEventListener("click", performShift);

  if (btnLurk)   btnLurk.addEventListener("click", () => selectDecision("LURK"));
  if (btnBurrow) btnBurrow.addEventListener("click", () => selectDecision("BURROW"));
  if (btnDash)   btnDash.addEventListener("click", () => selectDecision("DASH"));

  if (btnPass)   btnPass.addEventListener("click", passAction);
});
