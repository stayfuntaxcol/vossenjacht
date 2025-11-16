// VOSSENJACHT player.js – versie met Scent Check confirm + veilige Action-kaarten
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

// Actie-popup elementen
const actionModalOverlay = document.getElementById("actionModalOverlay");
const actionModalTitle   = document.getElementById("actionModalTitle");
const actionModalBody    = document.getElementById("actionModalBody");
const actionModalPlay    = document.getElementById("actionModalPlay");
const actionModalChange  = document.getElementById("actionModalChange");
const actionModalSkip    = document.getElementById("actionModalSkip");

let gameRef = null;
let playerRef = null;

let currentGame = null;
let currentPlayer = null;
let pendingActionIndex = null;

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

function closeActionModal() {
  if (!actionModalOverlay) return;
  actionModalOverlay.classList.add("hidden");
  actionModalOverlay.classList.remove("visible");
}

function openActionModal(index) {
  if (!currentGame || !currentPlayer) return;
  if (!actionModalOverlay || !actionModalTitle || !actionModalBody) {
    // Geen custom modal aanwezig – directe fallback naar spelen
    playActionCard(index);
    return;
  }

  const g = currentGame;
  const p = currentPlayer;
  const canOverall = canPlayActionNow(g, p);
  const myTurn = isMyOpsTurn(g);

  if (g.phase !== "ACTIONS" || !canOverall || !myTurn) {
    alert(
      "Je kunt nu geen Action Card spelen. Wacht tot het jouw beurt is in de ACTIONS-fase."
    );
    return;
  }

  const hand = p.hand || [];
  if (index < 0 || index >= hand.length) return;

  pendingActionIndex = index;
  const card = hand[index];

  actionModalOverlay.classList.remove("hidden");
  actionModalOverlay.classList.add("visible");

  actionModalTitle.textContent = card.name || "Action Card";
  actionModalBody.textContent =
    card.description ||
    "Speel deze kaart nu, of wijzig je keuze als je een andere kaart wilt spelen.";

  if (actionModalPlay) {
    actionModalPlay.onclick = async () => {
      const idx = pendingActionIndex;
      pendingActionIndex = null;
      closeActionModal();
      await playActionCard(idx);
    };
  }

  if (actionModalChange) {
    actionModalChange.onclick = () => {
      pendingActionIndex = null;
      closeActionModal();
    };
  }

  if (actionModalSkip) {
    actionModalSkip.onclick = async () => {
      pendingActionIndex = null;
      closeActionModal();
      await passAction();
    };
  }
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
  });
  actionFeedbackEl.textContent = `[${time}] ${msg}`;
}

// Helpers voor game / player state checks
function isInYardLocal(p) {
  return p.inYard !== false && !p.dashed;
}

function computeNextOpsIndex(game) {
  const order = game.opsTurnOrder || [];
  if (!order.length) return 0;
  const idx =
    typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

function mergeRoundFlags(game) {
  if (!game) return {};
  const base = {
    lockEvents: false,
    scatter: false,
    noPeek: [],
    denImmune: [],
    kickUpDustUsed: false,
    burrowBeaconUsed: false,
    noseForTrouble: [],
    followTail: {},
    scentChecks: [],
    opsLocked: false,
  };
  return { ...base, ...(game.flagsRound || {}) };
}

function canMoveNow(game, player) {
  if (!game || !player) return false;
  if (game.phase !== "MOVE") return false;
  if (!isInYardLocal(player)) return false;
  const moved = Array.isArray(game.movedPlayerIds)
    ? game.movedPlayerIds
    : [];
  return !moved.includes(playerId);
}

function canDecideNow(game, player) {
  if (!game || !player) return false;
  if (game.phase !== "DECISION") return false;
  if (!isInYardLocal(player)) return false;
  if (player.decisionLocked) return false;
  return true;
}

function isMyOpsTurn(game) {
  if (!game) return false;
  if (game.phase !== "ACTIONS") return false;
  const order = Array.isArray(game.opsTurnOrder) ? game.opsTurnOrder : [];
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  if (!order.length) return false;
  const currentId = order[idx % order.length];
  return currentId === playerId;
}

function canPlayActionNow(game, player) {
  if (!game || !player) return false;
  if (game.phase !== "ACTIONS") return false;
  if (!isInYardLocal(player)) return false;

  const flags = mergeRoundFlags(game);
  if (flags.opsLocked) {
    // In de huidige implementatie betekent opsLocked:
    // alleen nog Countermove-kaarten mogen, geen gewone kaarten.
    // Dit wordt verderop in playActionCard afgevangen.
    return true;
  }

  return true;
}

// FIRESTORE & INIT

initAuth(async () => {
  if (!gameId || !playerId) {
    if (gameStatusDiv) {
      gameStatusDiv.textContent =
        "Geen geldige game- of player-parameters in de URL.";
    }
    return;
  }

  gameRef = doc(db, "games", gameId);
  playerRef = doc(db, "games", gameId, "players", playerId);

  const gameSnap = await getDoc(gameRef);
  if (!gameSnap.exists()) {
    if (gameStatusDiv) {
      gameStatusDiv.textContent = `Game ${gameId} niet gevonden.`;
    }
    return;
  }

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) return;
    currentGame = snap.data();
    renderGame();
  });

  onSnapshot(playerRef, (snap) => {
    if (!snap.exists()) return;
    currentPlayer = snap.data();
    renderPlayer();
    renderHand();
    renderLoot();
  });

  if (gameStatusDiv) {
    gameStatusDiv.textContent = `Verbonden met game ${gameId} als speler ${playerId}.`;
  }

  attachButtonHandlers();
});

// RENDERING

function renderGame() {
  if (!currentGame) return;

  const g = currentGame;

  if (gameStatusDiv) {
    const phase = g.phase || "onbekend";
    const round = g.roundNumber || 1;
    gameStatusDiv.textContent = `Game ${gameId} · Ronde ${round} · Fase: ${phase}`;
  }

  renderEventInfo();
  updateMoveButtonsState();
  updateDecisionButtonsState();
  updateOpsState();
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

  const statusLine = document.createElement("div");
  statusLine.style.fontSize = "0.85rem";
  statusLine.style.opacity = "0.9";
  if (p.dashed) {
    statusLine.textContent = "Status: DASHED (weggerend met buit).";
  } else if (p.inYard === false) {
    statusLine.textContent = "Status: CAUGHT (gevangen).";
  } else {
    statusLine.textContent = "Status: In de Yard.";
  }
  playerInfoDiv.appendChild(statusLine);

  const burrowLine = document.createElement("div");
  burrowLine.style.fontSize = "0.8rem";
  burrowLine.style.opacity = "0.8";
  burrowLine.textContent = p.burrowUsed
    ? "Burrow: al gebruikt deze raid."
    : "Burrow: nog beschikbaar.";
  playerInfoDiv.appendChild(burrowLine);
}

function renderEventInfo() {
  if (!eventInfoDiv || !currentGame) return;
  const g = currentGame;

  eventInfoDiv.innerHTML = "";

  if (!Array.isArray(g.eventTrack) || g.eventTrack.length === 0) {
    eventInfoDiv.textContent = "Geen event track geladen.";
    return;
  }

  const idx =
    typeof g.currentEventIndex === "number" ? g.currentEventIndex : 0;
  const currentEventId = g.eventTrack[idx];
  if (!currentEventId) {
    eventInfoDiv.textContent = "Geen huidig event geselecteerd.";
    return;
  }

  const ev = getEventById(currentEventId);
  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.textContent = ev ? ev.title : currentEventId;
  eventInfoDiv.appendChild(title);

  if (ev && ev.subtitle) {
    const subt = document.createElement("div");
    subt.style.fontSize = "0.85rem";
    subt.style.opacity = "0.85";
    subt.textContent = ev.subtitle;
    eventInfoDiv.appendChild(subt);
  }

  const phaseInfo = document.createElement("div");
  phaseInfo.style.fontSize = "0.8rem";
  phaseInfo.style.opacity = "0.8";
  phaseInfo.style.marginTop = "0.35rem";
  phaseInfo.textContent = `Deze kaart wordt toegepast in de REVEAL-fase. De Community Board laat de volledige effecten zien.`;
  eventInfoDiv.appendChild(phaseInfo);
}

function renderLoot() {
  if (!lootPanel) return;

  lootPanel.innerHTML = "";

  if (!currentPlayer) {
    lootPanel.textContent = "Nog geen speler geladen.";
    return;
  }

  const loot = currentPlayer.loot || [];
  if (!loot.length) {
    lootPanel.textContent = "Je hebt nog geen buit verzameld.";
    return;
  }

  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let total = 0;

  loot.forEach((card) => {
    if (!card || typeof card.v !== "number") return;
    total += card.v;
    const label = (card.t || "").toLowerCase();
    if (label.includes("prize")) {
      prize += 1;
    } else if (label.includes("hen")) {
      hens += 1;
    } else {
      eggs += 1;
    }
  });

  const line = document.createElement("div");
  line.style.fontSize = "0.9rem";
  line.textContent = `Eggs: ${eggs} · Hens: ${hens} · Prize Hens: ${prize} · Totaal punten: ${total}`;
  lootPanel.appendChild(line);
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

  const canPlayOverall = canPlayActionNow(g, p);
  const myTurnOverall = isMyOpsTurn(g);

  if (!hand.length) {
    handPanel.textContent = "Je hebt geen Action Cards op hand.";
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
    btn.textContent = "Play Next";
    btn.disabled = !(canPlayOverall && myTurnOverall);
    btn.addEventListener("click", () => openActionModal(index));

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
        "Jij bent nu aan de beurt in OPS – kies een kaart met Play Next of PASS.";
    }
  }

  if (btnPass) {
    btnPass.disabled = !(canPlayOverall && myTurnOverall);
  }

  ensureActionFeedbackEl();
}

function updateMoveButtonsState() {
  if (!currentGame || !currentPlayer) return;

  const can = canMoveNow(currentGame, currentPlayer);

  [btnSnatch, btnForage, btnScout, btnShift].forEach((b) => {
    if (!b) return;
    b.disabled = !can;
  });

  if (moveState) {
    if (!can) {
      if (currentGame.phase !== "MOVE") {
        moveState.textContent = "MOVE-fase is niet actief.";
      } else if (!isInYardLocal(currentPlayer)) {
        moveState.textContent =
          "Je kunt niet bewegen (je bent niet in de Yard of al gedashed).";
      } else {
        moveState.textContent = "Je MOVE is al gedaan voor deze ronde.";
      }
    } else {
      moveState.textContent =
        "Kies precies één MOVE-actie: SNATCH, FORAGE, SCOUT of SHIFT.";
    }
  }
}

function updateDecisionButtonsState() {
  if (!currentGame || !currentPlayer) return;

  const can = canDecideNow(currentGame, currentPlayer);

  [btnLurk, btnBurrow, btnDash].forEach((b) => {
    if (!b) return;
    b.disabled = !can;
  });

  if (decisionState) {
    const p = currentPlayer;
    if (!can) {
      if (currentGame.phase !== "DECISION") {
        decisionState.textContent = "DECISION-fase is niet actief.";
      } else if (!isInYardLocal(p)) {
        decisionState.textContent =
          "Je kunt geen DECISION kiezen (je bent niet meer in de Yard).";
      } else if (p.decisionLocked) {
        decisionState.textContent = `Je DECISION is al bevestigd: ${
          p.decision || "onbekend"
        }.`;
      } else {
        decisionState.textContent = "Je kunt nu geen DECISION kiezen.";
      }
    } else {
      decisionState.textContent =
        "Kies: LURK (blijven), BURROW (schuilen) of DASH (weg met je buit).";
    }
  }
}

function updateOpsState() {
  if (!currentGame || !currentPlayer) return;
  renderHand();
}

// BUTTON HANDLERS

function attachButtonHandlers() {
  if (btnSnatch) {
    btnSnatch.addEventListener("click", () => performSnatch());
  }
  if (btnForage) {
    btnForage.addEventListener("click", () => performForage());
  }
  if (btnScout) {
    btnScout.addEventListener("click", () => performScout());
  }
  if (btnShift) {
    btnShift.addEventListener("click", () => performShift());
  }

  if (btnLurk) {
    btnLurk.addEventListener("click", () => selectDecision("LURK"));
  }
  if (btnBurrow) {
    btnBurrow.addEventListener("click", () => selectDecision("BURROW"));
  }
  if (btnDash) {
    btnDash.addEventListener("click", () => selectDecision("DASH"));
  }

  if (btnPass) {
    btnPass.addEventListener("click", () => passAction());
  }
}

// MOVE-ACTIES

async function performSnatch() {
  if (!currentGame || !currentPlayer) return;

  if (!canMoveNow(currentGame, currentPlayer)) {
    alert("Je kunt nu niet SNATCH doen.");
    return;
  }

  const g = currentGame;

  if (!Array.isArray(g.lootDeck) || g.lootDeck.length === 0) {
    alert("Er zijn geen loot-kaarten meer in de Deck.");
    return;
  }

  const newLootDeck = [...g.lootDeck];
  const card = newLootDeck.shift();

  const playerLoot = Array.isArray(currentPlayer.loot)
    ? [...currentPlayer.loot]
    : [];
  playerLoot.push(card);

  const moved = Array.isArray(g.movedPlayerIds)
    ? [...g.movedPlayerIds, playerId]
    : [playerId];

  await Promise.all([
    updateDoc(gameRef, {
      lootDeck: newLootDeck,
      movedPlayerIds: moved,
    }),
    updateDoc(playerRef, {
      loot: playerLoot,
    }),
    addActionDoc("MOVE_SNATCH_FROM_DECK"),
  ]);

  setActionFeedback("SNATCH: je hebt een loot-kaart van de Deck gepakt.");
}

async function performForage() {
  if (!currentGame || !currentPlayer) return;

  if (!canMoveNow(currentGame, currentPlayer)) {
    alert("Je kunt nu niet FORAGE doen.");
    return;
  }

  const g = currentGame;

  if (!Array.isArray(g.actionDeck) || g.actionDeck.length === 0) {
    alert("Er zijn geen Action Cards meer in de Deck.");
    return;
  }

  const newActionDeck = [...g.actionDeck];
  const drawn = newActionDeck.splice(0, 2);

  const newHand = Array.isArray(currentPlayer.hand)
    ? [...currentPlayer.hand, ...drawn]
    : [...drawn];

  const moved = Array.isArray(g.movedPlayerIds)
    ? [...g.movedPlayerIds, playerId]
    : [playerId];

  await Promise.all([
    updateDoc(gameRef, {
      actionDeck: newActionDeck,
      movedPlayerIds: moved,
    }),
    updateDoc(playerRef, {
      hand: newHand,
    }),
    addActionDoc("MOVE_FORAGE_2_ACTIONS"),
  ]);

  setActionFeedback("FORAGE: je hebt 2 Action Cards getrokken.");
}

async function performScout() {
  if (!currentGame || !currentPlayer) return;

  if (!canMoveNow(currentGame, currentPlayer)) {
    alert("Je kunt nu niet SCOUT doen.");
    return;
  }

  const g = currentGame;
  const flags = mergeRoundFlags(g);

  if (flags.scatter) {
    alert("SCOUT is geblokkeerd door Scatter! deze ronde.");
    return;
  }

  if (!Array.isArray(g.eventTrack) || g.eventTrack.length === 0) {
    alert("Geen event track om te scouten.");
    return;
  }

  const posStr = prompt(
    `Welke positie wil je scouten? (1-${g.eventTrack.length})\nNo-Go posities: ${
      flags.noPeek && flags.noPeek.length ? flags.noPeek.join(", ") : "geen"
    }`
  );
  if (!posStr) return;
  const pos = parseInt(posStr, 10);
  if (
    Number.isNaN(pos) ||
    pos < 1 ||
    pos > g.eventTrack.length ||
    (flags.noPeek || []).includes(pos - 1)
  ) {
    alert("Ongeldige keuze of No-Go Zone.");
    return;
  }

  const eventId = g.eventTrack[pos - 1];
  const ev = getEventById(eventId);
  const msg = ev
    ? `SCOUT op positie ${pos}: ${ev.title} – ${ev.subtitle || ""}`
    : `SCOUT op positie ${pos}: ${eventId}`;
  alert(msg);

  const moved = Array.isArray(g.movedPlayerIds)
    ? [...g.movedPlayerIds, playerId]
    : [playerId];

  await Promise.all([
    updateDoc(gameRef, {
      movedPlayerIds: moved,
    }),
    addActionDoc(`MOVE_SCOUT_POS_${pos}`),
  ]);

  setActionFeedback(`SCOUT: je hebt positie ${pos} bekeken.`);
}

async function performShift() {
  if (!currentGame || !currentPlayer) return;

  if (!canMoveNow(currentGame, currentPlayer)) {
    alert("Je kunt nu niet SHIFT doen.");
    return;
  }

  const g = currentGame;
  const flags = mergeRoundFlags(g);

  if (!Array.isArray(g.eventTrack) || g.eventTrack.length < 2) {
    alert("Te weinig events om te verschuiven.");
    return;
  }

  if (flags.lockEvents) {
    alert("SHIFT is geblokkeerd door Burrow Beacon / Events locked.");
    return;
  }

  const len = g.eventTrack.length;
  const firstStr = prompt(`Welke eerste positie wil je wisselen? (1-${len})`);
  if (!firstStr) return;
  const first = parseInt(firstStr, 10);
  if (Number.isNaN(first) || first < 1 || first > len) {
    alert("Ongeldige eerste positie.");
    return;
  }

  const secondStr = prompt(
    `Welke tweede positie wil je wisselen met ${first}? (1-${len})`
  );
  if (!secondStr) return;
  const second = parseInt(secondStr, 10);
  if (
    Number.isNaN(second) ||
    second < 1 ||
    second > len ||
    second === first
  ) {
    alert("Ongeldige tweede positie.");
    return;
  }

  const newTrack = [...g.eventTrack];
  const tmp = newTrack[first - 1];
  newTrack[first - 1] = newTrack[second - 1];
  newTrack[second - 1] = tmp;

  const moved = Array.isArray(g.movedPlayerIds)
    ? [...g.movedPlayerIds, playerId]
    : [playerId];

  await Promise.all([
    updateDoc(gameRef, {
      eventTrack: newTrack,
      movedPlayerIds: moved,
    }),
    addActionDoc(`MOVE_SHIFT_${first}_${second}`),
  ]);

  setActionFeedback(
    `SHIFT: je hebt de events op positie ${first} en ${second} gewisseld.`
  );
}

// DECISION

async function selectDecision(decision) {
  if (!currentGame || !currentPlayer) return;

  if (!canDecideNow(currentGame, currentPlayer)) {
    alert("Je kunt nu geen DECISION kiezen.");
    return;
  }

  const p = currentPlayer;

  if (decision === "BURROW" && p.burrowUsed) {
    alert("Je hebt Burrow al gebruikt in deze raid.");
    return;
  }

  // Scent Check check
  await maybeShowScentCheckInfo(currentGame);

  const confirmMsg =
    decision === "LURK"
      ? "Je blijft in de Yard en neemt het event frontaal. Bevestigen?"
      : decision === "BURROW"
      ? "Je duikt onder (Burrow) om te schuilen voor vang-events. Bevestigen?"
      : "Je gaat DASH doen en rent weg met je huidige buit. Bevestigen?";

  const ok = confirm(confirmMsg);
  if (!ok) return;

  const updates = {
    decision,
    decisionLocked: true,
  };

  if (decision === "BURROW") {
    updates.burrowUsed = true;
  }

  await Promise.all([
    updateDoc(playerRef, updates),
    addActionDoc(`DECISION_${decision}`),
  ]);

  setActionFeedback(`DECISION: je hebt gekozen voor ${decision}.`);
}

// ACTION CARDS

async function playActionCard(index) {
  if (!currentGame || !currentPlayer) return;

  const g = currentGame;
  const p = currentPlayer;

  if (!canPlayActionNow(g, p)) {
    alert("Je kunt nu geen Action Card spelen.");
    return;
  }

  if (!isMyOpsTurn(g)) {
    alert("Het is niet jouw beurt in de ACTIONS-fase.");
    return;
  }

  const hand = p.hand || [];
  if (!hand.length || index < 0 || index >= hand.length) {
    alert("Ongeldige kaartkeuze.");
    return;
  }

  const card = hand[index];
  const flags = mergeRoundFlags(g);

  // Hold Still: alleen Countermove-kaarten mogen nog
  if (flags.opsLocked && card.type !== "COUNTERMOVE") {
    alert(
      "Alleen Countermove-kaarten mogen nog gespeeld worden na Hold Still."
    );
    return;
  }

  let gameUpdates = {};
  let playerUpdates = {};
  let logKind = "PLAY_ACTION";
  let logChoice = card.name || card.id || "ACTION";

  // wordt true zodra er echt een kaart succesvol is gespeeld
  let cardPlayed = false;

  async function commitUpdates(extraLogMessage) {
    const newHand = [...hand];
    newHand.splice(index, 1);
    playerUpdates.hand = newHand;

    const updates = [];
    if (Object.keys(gameUpdates).length) {
      updates.push(updateDoc(gameRef, gameUpdates));
    }
    if (Object.keys(playerUpdates).length) {
      updates.push(updateDoc(playerRef, playerUpdates));
    }

    updates.push(addActionDoc(logKind, logChoice, extraLogMessage));

    await Promise.all(updates);
  }

  switch (card.id) {
    case "SCATTER": {
      const flagsRound = mergeRoundFlags(g);
      flagsRound.scatter = true;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates("Scatter! SCOUT is geblokkeerd deze ronde.");
      setActionFeedback("Scatter!: SCOUT is geblokkeerd deze ronde.");
      cardPlayed = true;
      break;
    }

    case "DEN_SIGNAL": {
      const color = prompt(
        "Welke Den-kleur wil je beschermen? (bijv. RED, BLUE, GREEN, YELLOW)"
      );
      if (!color) {
        alert("Actie geannuleerd.");
        return;
      }
      const c = color.trim().toUpperCase();
      const valid = ["RED", "BLUE", "GREEN", "YELLOW"];
      if (!valid.includes(c)) {
        alert("Ongeldige Den-kleur.");
        return;
      }
      const flagsRound = mergeRoundFlags(g);
      const arr = Array.isArray(flagsRound.denImmune)
        ? [...flagsRound.denImmune]
        : [];
      if (!arr.includes(c)) arr.push(c);
      flagsRound.denImmune = arr;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates(`Den Signal op ${c}.`);
      setActionFeedback(`Den Signal: Den-kleur ${c} is beschermd.`);
      cardPlayed = true;
      break;
    }

    case "NO_GO_ZONE": {
      if (!Array.isArray(g.eventTrack) || g.eventTrack.length === 0) {
        alert("Geen events om een No-Go Zone op te zetten.");
        return;
      }
      const posStr = prompt(
        `Kies een positie voor de No-Go Zone (1-${g.eventTrack.length}).`
      );
      if (!posStr) return;
      const pos = parseInt(posStr, 10);
      if (Number.isNaN(pos) || pos < 1 || pos > g.eventTrack.length) {
        alert("Ongeldige positie.");
        return;
      }
      const flagsRound = mergeRoundFlags(g);
      const noPeekArr = Array.isArray(flagsRound.noPeek)
        ? [...flagsRound.noPeek]
        : [];
      if (!noPeekArr.includes(pos - 1)) {
        noPeekArr.push(pos - 1);
      }
      flagsRound.noPeek = noPeekArr;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates(`No-Go Zone op positie ${pos}.`);
      setActionFeedback(`No-Go Zone: positie ${pos} mag niet gescout worden.`);
      cardPlayed = true;
      break;
    }

    case "KICK_UP_DUST": {
      if (!Array.isArray(g.eventTrack) || g.eventTrack.length < 2) {
        alert("Te weinig events om door elkaar te gooien.");
        return;
      }
      const flagsRound = mergeRoundFlags(g);
      if (flagsRound.lockEvents) {
        alert(
          "Event Track is gelocked (Burrow Beacon), je kunt nu geen Kick Up Dust gebruiken."
        );
        return;
      }
      const newTrack = [...g.eventTrack];
      for (let i = newTrack.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = newTrack[i];
        newTrack[i] = newTrack[j];
        newTrack[j] = tmp;
      }
      gameUpdates.eventTrack = newTrack;
      await commitUpdates("Kick Up Dust: Event Track door elkaar gegooid.");
      setActionFeedback(
        "Kick Up Dust: de Event Track is door elkaar gegooid."
      );
      cardPlayed = true;
      break;
    }

    case "BURROW_BEACON": {
      const flagsRound = mergeRoundFlags(g);
      flagsRound.lockEvents = true;
      flagsRound.burrowBeaconUsed = true;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates("Burrow Beacon: events zijn gelocked.");
      setActionFeedback(
        "Burrow Beacon: SHIFT / Kick Up Dust / Pack Tinker zijn geblokkeerd."
      );
      cardPlayed = true;
      break;
    }

    case "MOLTING_MASK": {
      const newColor = prompt(
        "Naar welke Den-kleur wil je wisselen? (RED, BLUE, GREEN of YELLOW)"
      );
      if (!newColor) {
        alert("Actie geannuleerd.");
        return;
      }
      const c = newColor.trim().toUpperCase();
      const valid = ["RED", "BLUE", "GREEN", "YELLOW"];
      if (!valid.includes(c)) {
        alert("Ongeldige kleur.");
        return;
      }
      playerUpdates.color = c;
      await commitUpdates(`Molting Mask: kleur gewijzigd naar ${c}.`);
      setActionFeedback(`Molting Mask: jouw Den-kleur is nu ${c}.`);
      cardPlayed = true;
      break;
    }

    case "HOLD_STILL": {
      const flagsRound = mergeRoundFlags(g);
      flagsRound.opsLocked = true;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates("Hold Still: alleen Countermoves mogen nog.");
      setActionFeedback(
        "Hold Still: vanaf nu mogen alleen Countermove-kaarten worden gespeeld."
      );
      cardPlayed = true;
      break;
    }

    case "NOSE_FOR_TROUBLE": {
      if (!Array.isArray(g.eventTrack) || g.eventTrack.length === 0) {
        alert("Geen event track om te voorspellen.");
        return;
      }
      const posStr = prompt(
        `Welke positie wil je voorspellen als het volgende event? (1-${g.eventTrack.length})`
      );
      if (!posStr) return;
      const pos = parseInt(posStr, 10);
      if (Number.isNaN(pos) || pos < 1 || pos > g.eventTrack.length) {
        alert("Ongeldige positie.");
        return;
      }
      const flagsRound = mergeRoundFlags(g);
      const arr = Array.isArray(flagsRound.noseForTrouble)
        ? [...flagsRound.noseForTrouble]
        : [];
      arr.push({
        playerId,
        pos: pos - 1,
      });
      flagsRound.noseForTrouble = arr;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates(`Nose for Trouble: voorspelling op pos ${pos}.`);
      setActionFeedback(
        `Nose for Trouble: je hebt positie ${pos} voorspeld als het volgende event.`
      );
      cardPlayed = true;
      break;
    }

    case "SCENT_CHECK": {
      const target = await chooseOtherPlayerPrompt(
        "Voor wie wil je Scent Check gebruiken?"
      );
      if (!target) {
        alert("Geen geldige speler gekozen.");
        return;
      }

      const flagsRound = mergeRoundFlags(g);
      const arr = Array.isArray(flagsRound.scentChecks)
        ? [...flagsRound.scentChecks]
        : [];
      arr.push({
        viewerId: playerId,
        targetId: target.id,
      });
      flagsRound.scentChecks = arr;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates(`Scent Check op ${target.name || target.id}.`);
      setActionFeedback(
        `Scent Check: je krijgt straks een blik op de DECISION van ${target.name ||
          target.id} voordat jij bevestigt.`
      );
      cardPlayed = true;
      break;
    }

    case "FOLLOW_THE_TAIL": {
      const target = await chooseOtherPlayerPrompt(
        "Wiens keuze wil je volgen met Follow the Tail?"
      );
      if (!target) {
        alert("Geen geldige speler gekozen.");
        return;
      }

      const flagsRound = mergeRoundFlags(g);
      const follow = { ...(flagsRound.followTail || {}) };
      follow[playerId] = target.id;
      flagsRound.followTail = follow;
      gameUpdates.flagsRound = flagsRound;
      await commitUpdates(`Follow the Tail op ${target.name || target.id}.`);
      setActionFeedback(
        `Follow the Tail: jouw DECISION zal die van ${target.name ||
          target.id} volgen.`
      );
      cardPlayed = true;
      break;
    }

    case "ALPHA_CALL": {
      const target = await chooseOtherPlayerPrompt(
        "Wie moet de nieuwe Lead Fox worden?"
      );
      if (!target) {
        alert("Geen geldige speler gekozen.");
        return;
      }

      const players = await fetchPlayersForGame();
      const sorted = sortPlayersByJoinOrder(players);
      const idx = sorted.findIndex((pl) => pl.id === target.id);
      if (idx === -1) {
        alert("Kon de Lead Fox niet goed bepalen.");
        return;
      }

      const newLeadIndex = idx;
      const nextLead = sorted[newLeadIndex];

      const updates = [];
      updates.push(
        updateDoc(gameRef, {
          leadIndex: newLeadIndex,
        })
      );

      sorted.forEach((pl, i) => {
        const pref = doc(db, "games", gameId, "players", pl.id);
        updates.push(
          updateDoc(pref, {
            isLeadFox: i === newLeadIndex,
          })
        );
      });

      await Promise.all(updates);
      await commitUpdates(`Alpha Call – nieuwe Lead Fox: ${nextLead.name ||
        nextLead.id}.`);
      setActionFeedback(
        `Alpha Call: ${nextLead.name ||
          nextLead.id} is nu de Lead Fox voor deze raid.`
      );
      cardPlayed = true;
      break;
    }

    case "PACK_TINKER": {
      if (!Array.isArray(g.eventTrack) || g.eventTrack.length < 2) {
        alert("Te weinig events om te wisselen.");
        return;
      }
      const flagsRound = mergeRoundFlags(g);
      if (flagsRound.lockEvents) {
        alert("Event Track is gelocked, Pack Tinker kan niet gebruikt worden.");
        return;
      }

      const len = g.eventTrack.length;
      const firstStr = prompt(
        `Welke eerste positie wil je wisselen? (1-${len})`
      );
      if (!firstStr) return;
      const first = parseInt(firstStr, 10);
      if (Number.isNaN(first) || first < 1 || first > len) {
        alert("Ongeldige eerste positie.");
        return;
      }

      const secondStr = prompt(
        `Welke tweede positie wil je wisselen met ${first}? (1-${len})`
      );
      if (!secondStr) return;
      const second = parseInt(secondStr, 10);
      if (
        Number.isNaN(second) ||
        second < 1 ||
        second > len ||
        second === first
      ) {
        alert("Ongeldige tweede positie.");
        return;
      }

      const newTrack = [...g.eventTrack];
      const tmp = newTrack[first - 1];
      newTrack[first - 1] = newTrack[second - 1];
      newTrack[second - 1] = tmp;

      gameUpdates.eventTrack = newTrack;
      await commitUpdates(`Pack Tinker: wissel ${first} en ${second}.`);
      setActionFeedback(
        `Pack Tinker: je hebt de events op positie ${first} en ${second} gewisseld.`
      );
      cardPlayed = true;
      break;
    }

    case "MASK_SWAP": {
      const players = await fetchPlayersForGame();
      const inYard = players.filter((pl) => isInYardLocal(pl));
      if (inYard.length < 2) {
        alert("Er zijn te weinig vossen in de Yard om Mask Swap te gebruiken.");
        return;
      }

      const colors = inYard.map((pl) => pl.color || pl.denColor || "GRAY");
      for (let i = colors.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = colors[i];
        colors[i] = colors[j];
        colors[j] = tmp;
      }

      const updates = [];
      inYard.forEach((pl, i) => {
        const pref = doc(db, "games", gameId, "players", pl.id);
        updates.push(
          updateDoc(pref, {
            color: colors[i],
          })
        );
      });

      await Promise.all(updates);
      await commitUpdates("Mask Swap: Den-kleuren door elkaar geschud.");
      setActionFeedback(
        "Mask Swap: alle Den-kleuren van vossen in de Yard zijn door elkaar geschud."
      );
      cardPlayed = true;
      break;
    }

    case "COUNTERMOVE": {
      await commitUpdates("Countermove placeholder – nog geen speciaal effect.");
      setActionFeedback(
        "Countermove: placeholder – telt als gespeelde kaart, maar nog geen specifiek effect."
      );
      cardPlayed = true;
      break;
    }

    default: {
      await commitUpdates("Onbekende Action Card – standaard gespeeld.");
      setActionFeedback(
        `Je hebt een Action Card gespeeld: ${card.name ||
          card.id ||
          "Unknown"}.`
      );
      cardPlayed = true;
      break;
    }
  }

  // Als er daadwerkelijk een kaart gespeeld is: beurt naar de volgende speler,
  // en de PASS-streak resetten.
  if (cardPlayed) {
    const nextIndex = computeNextOpsIndex(g);
    await updateDoc(gameRef, {
      opsTurnIndex: nextIndex,
      opsConsecutivePasses: 0,
    });
  }
}

async function passAction() {
  if (!currentGame || !currentPlayer) return;

  const g = currentGame;
  const p = currentPlayer;

  if (g.phase !== "ACTIONS") {
    alert("Je kunt alleen PASSen tijdens de ACTIONS-fase.");
    return;
  }

  if (!isMyOpsTurn(g)) {
    alert("Het is niet jouw beurt om te PASSen.");
    return;
  }

  const nextIndex = computeNextOpsIndex(g);
  const newPasses = (g.opsConsecutivePasses || 0) + 1;

  await Promise.all([
    updateDoc(gameRef, {
      opsTurnIndex: nextIndex,
      opsConsecutivePasses: newPasses,
    }),
    addActionDoc("PASS", "PASS"),
  ]);

  setActionFeedback("Je hebt gekozen voor PASS in de ACTIONS-fase.");
}

// LOG / ACTION DOC HELPER

async function addActionDoc(kind, choice, extraMessage) {
  const actionsCol = collection(db, "games", gameId, "actions");
  const payload = {
    kind: kind || "UNKNOWN",
    choice: choice || null,
    extraMessage: extraMessage || null,
    gameId,
    playerId,
    playerName: currentPlayer ? currentPlayer.name || null : null,
    round: currentGame ? currentGame.roundNumber || 1 : 1,
    phase: currentGame ? currentGame.phase || null : null,
    createdAt: serverTimestamp(),
  };
  await addDoc(actionsCol, payload);

  await addLog(gameId, {
    kind: "PLAYER_ACTION",
    message:
      extraMessage ||
      `${payload.playerName || "Speler"} doet ${kind}${
        choice ? ` (${choice})` : ""
      }`,
    playerId: payload.playerId,
    playerName: payload.playerName,
    phase: payload.phase,
    round: payload.round,
  });
}

// HULPFUNCTIES VOOR Scent Check + andere kaarten

async function fetchPlayersForGame() {
  const col = collection(db, "games", gameId, "players");
  const snap = await getDocs(col);
  const players = [];
  snap.forEach((docSnap) => {
    players.push({ id: docSnap.id, ...docSnap.data() });
  });
  return players;
}

function sortPlayersByJoinOrder(players) {
  return [...players].sort((a, b) => {
    const aj = a.joinOrder ?? 0;
    const bj = b.joinOrder ?? 0;
    return aj - bj;
  });
}

async function chooseOtherPlayerPrompt(title) {
  const players = await fetchPlayersForGame();
  const others = players.filter((pl) => pl.id !== playerId);

  if (!others.length) {
    alert("Geen andere spelers gevonden.");
    return null;
  }

  const sorted = sortPlayersByJoinOrder(others);
  const names = sorted
    .map((pl, idx) => `${idx + 1}. ${pl.name || pl.id}`)
    .join("\n");

  const choiceStr = prompt(
    `${title}\n\n${names}\n\nVoer het nummer in van de speler die je kiest:`
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

  const players = await fetchPlayersForGame();
  const map = new Map(players.map((p) => [p.id, p]));

  const p = currentPlayer;
  if (!p || !p.decision) {
    const targetIds = myChecks.map((c) => c.targetId);
    const targetNames = targetIds
      .map((id) => (map.get(id) ? map.get(id).name || id : id))
      .join(", ");
    alert(
      `Scent Check actief op: ${targetNames}.\n\nZodra zij hun DECISION hebben gekozen, zie je hun keuze voordat jij bevestigt.`
    );
    return;
  }

  myChecks.forEach((check) => {
    const t = map.get(check.targetId);
    if (!t || !t.decision) return;
    alert(
      `Scent Check: ${t.name ||
        t.id} heeft DECISION gekozen: ${t.decision}. Dit zie jij voordat je je eigen keuze bevestigt.`
    );
  });
}
