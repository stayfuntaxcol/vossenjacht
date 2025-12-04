// VOSSENJACHT player.js – nieuwe UI: fase-panels + loot-meter
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

// ===== DOM ELEMENTS – nieuwe player.html =====

// Header / host board
const gameStatusDiv    = document.getElementById("gameStatus");
const hostStatusLine   = document.getElementById("hostStatusLine");
const hostFeedbackLine = document.getElementById("hostFeedbackLine");

// Hero / spelerkaart
const playerNameEl      = document.getElementById("playerName");
const playerDenColorEl  = document.getElementById("playerDenColor");
const playerStatusEl    = document.getElementById("playerStatus");
const playerScoreEl     = document.getElementById("playerScore");
const lootSummaryEl     = document.getElementById("lootSummary");
const lootMeterEl       = document.getElementById("lootMeter");
const lootMeterFillEl   = lootMeterEl
  ? lootMeterEl.querySelector(".loot-meter-fill")
  : null;

// Event + scout + flags
const eventCurrentDiv      = document.getElementById("eventCurrent");
const eventScoutPreviewDiv = document.getElementById("eventScoutPreview");
const specialFlagsDiv      = document.getElementById("specialFlags");

// Phase panels
const phaseMovePanel     = document.getElementById("phaseMovePanel");
const phaseActionsPanel  = document.getElementById("phaseActionsPanel");
const phaseDecisionPanel = document.getElementById("phaseDecisionPanel");

const moveStateText     = document.getElementById("moveStateText");
const actionsStateText  = document.getElementById("actionsStateText");
const decisionStateText = document.getElementById("decisionStateText");

// Buttons (MOVE / DECISION / ACTIONS)
const btnSnatch = document.getElementById("btnSnatch");
const btnForage = document.getElementById("btnForage");
const btnScout  = document.getElementById("btnScout");
const btnShift  = document.getElementById("btnShift");

const btnLurk   = document.getElementById("btnLurk");
const btnBurrow = document.getElementById("btnBurrow");
const btnDash   = document.getElementById("btnDash");

const btnPass = document.getElementById("btnPass");
const btnHand = document.getElementById("btnHand");
const btnLead = document.getElementById("btnLead");
const btnHint = document.getElementById("btnHint");
const btnLoot = document.getElementById("btnLoot");

// Modals (HAND / LOOT)
const handModalOverlay = document.getElementById("handModalOverlay");
const handModalClose   = document.getElementById("handModalClose");
const handCardsGrid    = document.getElementById("handCardsGrid");

const lootModalOverlay = document.getElementById("lootModalOverlay");
const lootModalClose   = document.getElementById("lootModalClose");
const lootCardsGrid    = document.getElementById("lootCardsGrid");

// ===== Host/Coach – stickers =====
const HOST_BASE = "./assets/";
const HOST_DEFAULT = "host_thumbsup.png";

// 3a) Sticker sets per intent (gebruik exact jouw bestandsnamen)
export const HOST_INTENTS = {
  confirm: ["host_thumbsup.png","host_easypeazy.png"],
  power:   ["host_muscle_flex.png","host_rich_money.png"],
  tip:     ["host_holdup.png","host_nowwhat_stare.png","host_oops_nowwhat.png","host_drink_coffee.png","host_toldyouso.png","host_difficult_sweat.png"],
  warn:    ["host_scared_fear.png","host_disbelief.png","host_jerkmove.png"],
  fail:    ["host_sad_defeated.png","host_reallysad_tears.png","host_crying_tears.png","host_knockedout.png","host_dead.png","host_discusted_flies.png"],
  fun:     ["host_lol_tears.png","host_dontknow.png","host_oops_saint.png","host_inlove.png","host_loveyou_kiss.png"],
  idle:    ["host_sleeping.png"]
};

// 3b) Triggers → intent
export const HOST_TRIGGERS = {
  action_success: "confirm",
  action_buff: "power",
  loot_big: "power",
  need_choice: "tip",
  pre_reveal: "tip",
  timeout: "idle",
  beacon_on: "warn",
  dog_near: "warn",
  bad_map: "warn",
  paint_bomb: "fail",
  caught: "fail",
  round_lost: "fail",
  funny: "fun",
  no_info: "fun"
};

// 3c) Mount (1x aanroepen bij init)
export function ensureHostCoachMount() {
  if (document.getElementById("hostCoach")) return;
  const wrap = document.createElement("div");
  wrap.id = "hostCoach";
  wrap.className = "host-coach";
  wrap.innerHTML = `<img class="host-img" alt="">
                    <div class="host-bubble" role="status" aria-live="polite"></div>`;
  document.body.appendChild(wrap);
}

// 3d) API
const HOST_PRIOR = { warn:5, fail:5, confirm:4, power:4, tip:3, fun:2, idle:1 };
let _hostState = { until:0, prior:0 };

export function hostSay(trigger, text) {
  ensureHostCoachMount();
  const el = document.getElementById("hostCoach");
  const now = Date.now();

  const intent = HOST_TRIGGERS[trigger] || "tip";
  const prior = HOST_PRIOR[intent] || 1;

  // anti-spam: alleen overschrijven bij gelijke/hogere prioriteit of als timeout voorbij is
  if (now < _hostState.until && prior < _hostState.prior) return;

  const img = el.querySelector(".host-img");
  const bubble = el.querySelector(".host-bubble");
  const file = pickHostSticker(intent);

  img.src = HOST_BASE + file;
  img.alt = "Host: " + intent;
  bubble.textContent = text || presetText(trigger);

  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(()=> el.classList.remove("show"), 3600);

  _hostState = { until: now + 2200, prior };
}

function pickHostSticker(intent) {
  const list = HOST_INTENTS[intent] || HOST_INTENTS.tip;
  return (list[Math.floor(Math.random()*list.length)]) || HOST_DEFAULT;
}

function presetText(trigger) {
  const T = {
    action_success:"Lekker! Slim gespeeld.",
    action_buff:"Power-up geactiveerd.",
    loot_big:"Zak puilt uit — top!",
    need_choice:"Kies je zet…",
    pre_reveal:"Even stil — reveal komt.",
    timeout:"Koffiepauze?",
    beacon_on:"Alarm aan! Snel en stil.",
    dog_near:"Hond dichtbij — oppassen.",
    bad_map:"Kaart klopt niet…",
    paint_bomb:"Au — zak gereset.",
    caught:"Gepakt! Volgende keer anders.",
    round_lost:"Dawn. Nieuwe ronde.",
    funny:"Hahaha—die zag ik niet.",
    no_info:"Geen data; gok slim."
  };
  return T[trigger] ?? "Ik denk mee…";
}

// 3e) Preload (optioneel, bij start)
export function preloadHost(){
  const files = new Set(Object.values(HOST_INTENTS).flat());
  files.forEach(fn => { const i = new Image(); i.src = HOST_BASE + fn; });
}


// ===== FIRESTORE REFS / STATE =====

let gameRef = null;
let playerRef = null;

let currentGame = null;
let currentPlayer = null;

// ===== HELPERS ROUND FLAGS / PLAYERS =====

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
  const choiceStr = prompt(`${title}\n` + lines.join("\n"));
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

// ===== PHASE & PERMISSIONS =====

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

// ⚠️ Gebruik playerId uit URL
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

// ===== LOOT / SCORE HELPERS + UI =====

function calcLootStats(player) {
  if (!player) {
    return { eggs: 0, hens: 0, prize: 0, score: 0 };
  }

  const loot = Array.isArray(player.loot) ? player.loot : [];

  let eggs  = player.eggs  || 0;
  let hens  = player.hens  || 0;
  let prize = player.prize || 0;

  loot.forEach((card) => {
    const tRaw = card.t || card.type || "";
    const t = String(tRaw).toUpperCase();
    if (t.includes("EGG")) {
      eggs += 1;
    } else if (t.includes("HEN") && !t.includes("PRIZE")) {
      hens += 1;
    } else if (t.includes("PRIZE")) {
      prize += 1;
    }
  });

  const pointsFromCounts = eggs + hens * 2 + prize * 3;

  let otherPoints = 0;
  loot.forEach((card) => {
    const v = typeof card.v === "number" ? card.v : 0;
    const tRaw = card.t || card.type || "";
    const t = String(tRaw).toUpperCase();
    if (["EGG", "HEN", "PRIZE", "PRIZE HEN", "PRIZE_HEN"].includes(t)) return;
    otherPoints += v;
  });

  const recordedScore = typeof player.score === "number" ? player.score : 0;
  const score = Math.max(recordedScore, pointsFromCounts + otherPoints);

  return { eggs, hens, prize, score };
}

function updateLootUi(player) {
  if (!lootSummaryEl || !lootMeterFillEl) return;
  const { eggs, hens, prize, score } = calcLootStats(player || {});

  if (eggs === 0 && hens === 0 && prize === 0 && score === 0) {
    lootSummaryEl.textContent = "Nog geen buit verzameld.";
  } else {
    lootSummaryEl.textContent = `P:${prize} H:${hens} E:${eggs} – totaal ~${score} punten.`;
  }

  // Totaal 12+ punten ~ volle zak (mag je later tweaken)
  const baseMax = 12;
  const rawPct = baseMax > 0 ? (score / baseMax) * 100 : 0;
  const meterPct = Math.max(5, Math.min(100, Math.round(rawPct)));
  lootMeterFillEl.style.width = `${meterPct}%`;

  if (playerScoreEl) {
    playerScoreEl.textContent = `Score: ${score} (P:${prize} H:${hens} E:${eggs})`;
  }
}

// ===== HOST FEEDBACK =====

function setActionFeedback(msg) {
  if (!hostFeedbackLine) return;

  if (!msg) {
    hostFeedbackLine.textContent = "";
    return;
  }

  const time = new Date().toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  hostFeedbackLine.textContent = `[${time}] ${msg}`;
}

// ===== UI: PHASE PANELS + GAME / EVENT RENDERING =====

function updatePhasePanels(game, player) {
  if (!phaseMovePanel || !phaseActionsPanel || !phaseDecisionPanel) return;

  phaseMovePanel.classList.remove("active");
  phaseActionsPanel.classList.remove("active");
  phaseDecisionPanel.classList.remove("active");

  if (!game) {
    if (hostStatusLine) {
      hostStatusLine.textContent = "Wachten op game-data…";
    }
    return;
  }

  const phase = game.phase || "";
  const status = game.status || "";

  if (status === "finished" || phase === "END") {
    if (hostStatusLine) {
      hostStatusLine.textContent =
        "Raid is afgelopen – er worden geen keuzes meer gevraagd.";
    }
    updateMoveButtonsState();
    updateDecisionButtonsState();
    renderHand();
    return;
  }

  if (phase === "MOVE") {
    phaseMovePanel.classList.add("active");
    if (hostStatusLine) {
      if (player && canMoveNow(game, player)) {
        hostStatusLine.textContent =
          "MOVE-fase – kies één actie: SNATCH / FORAGE / SCOUT / SHIFT.";
      } else {
        hostStatusLine.textContent =
          "MOVE-fase – je kunt nu geen MOVE doen (al bewogen, niet in de Yard of al DASHED).";
      }
    }
  } else if (phase === "ACTIONS") {
    phaseActionsPanel.classList.add("active");
    if (hostStatusLine) {
      if (player && canPlayActionNow(game, player)) {
        if (isMyOpsTurn(game)) {
          hostStatusLine.textContent =
            "ACTIONS-fase – jij bent aan de beurt. Speel een kaart via HAND of kies PASS.";
        } else {
          hostStatusLine.textContent =
            "ACTIONS-fase – wacht tot je weer aan de beurt bent.";
        }
      } else {
        hostStatusLine.textContent =
          "ACTIONS-fase – je doet niet (meer) mee in deze ronde (niet in de Yard of al DASHED).";
      }
    }
  } else if (phase === "DECISION") {
    phaseDecisionPanel.classList.add("active");
    if (hostStatusLine) {
      if (player && canDecideNow(game, player)) {
        hostStatusLine.textContent =
          "DECISION-fase – kies LURK (blijven), HIDE (Burrow) of DASH (wegrennen).";
      } else if (player && player.decision) {
        hostStatusLine.textContent = `DECISION-fase – jouw keuze staat al vast: ${player.decision}.`;
      } else {
        hostStatusLine.textContent =
          "DECISION-fase – je doet niet mee (niet in de Yard of al DASHED).";
      }
    }
  } else if (phase === "REVEAL") {
    if (hostStatusLine) {
      hostStatusLine.textContent =
        "REVEAL – Event wordt toegepast. Kijk mee op het grote scherm.";
    }
  } else {
    if (hostStatusLine) {
      hostStatusLine.textContent =
        "Wacht op de volgende ronde of een nieuwe raid.";
    }
  }

  updateMoveButtonsState();
  updateDecisionButtonsState();
  renderHand();
}

function renderGame() {
  if (!currentGame || !gameStatusDiv) return;

  const g = currentGame;

  gameStatusDiv.textContent =
    `Code: ${g.code} – Ronde: ${g.round || 0} – Fase: ${g.phase || "?"}`;

  // Spel afgelopen
  if (g.status === "finished" || g.phase === "END") {
    setActionFeedback(
      "Het spel is afgelopen – het scorebord staat op het Community Board."
    );
    if (eventCurrentDiv) {
      eventCurrentDiv.textContent =
        "Spel afgelopen. Bekijk het scorebord op het grote scherm.";
    }
    if (eventScoutPreviewDiv) eventScoutPreviewDiv.textContent = "";
    if (specialFlagsDiv) specialFlagsDiv.innerHTML = "";
    updatePhasePanels(g, currentPlayer);
    return;
  }

  // Buiten ACTIONS: feedback resetten
  if (g.phase !== "ACTIONS") {
    setActionFeedback("");
  }

  // EVENT + SCOUT
  if (eventCurrentDiv) eventCurrentDiv.innerHTML = "";
  if (eventScoutPreviewDiv) eventScoutPreviewDiv.textContent = "";
  if (specialFlagsDiv) specialFlagsDiv.innerHTML = "";

  let ev = null;
  let label = "";

  // REVEAL → actueel event
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
      label = `SCOUT preview – positie ${idx + 1}`;
    }
  }

  if (ev && eventCurrentDiv) {
    const labelDiv = document.createElement("div");
    labelDiv.style.fontSize = "0.78rem";
    labelDiv.style.opacity = "0.75";
    labelDiv.style.marginBottom = "0.2rem";
    labelDiv.textContent = label || "Event";

    const titleDiv = document.createElement("div");
    titleDiv.style.fontWeight = "600";
    titleDiv.textContent = ev.title || "Event";

    const textDiv = document.createElement("div");
    textDiv.style.fontSize = "0.85rem";
    textDiv.style.opacity = "0.9";
    textDiv.textContent = ev.text || "";

    eventCurrentDiv.appendChild(labelDiv);
    eventCurrentDiv.appendChild(titleDiv);
    eventCurrentDiv.appendChild(textDiv);
  } else if (eventCurrentDiv) {
    eventCurrentDiv.textContent =
      "Nog geen Event Card onthuld (pas zichtbaar bij REVEAL of via SCOUT).";
  }

  // Extra SCOUT preview tekst (alleen voor jou)
  if (eventScoutPreviewDiv && currentPlayer && currentPlayer.scoutPeek) {
    const peek = currentPlayer.scoutPeek;
    if (peek.round === (g.round || 0)) {
      const evPeek = getEventById(peek.eventId);
      if (evPeek) {
        eventScoutPreviewDiv.textContent =
          `SCOUT preview (alleen voor jou): positie ${peek.index + 1} – ${evPeek.title}`;
      }
    }
  }

  // Flags tonen als chips
  if (specialFlagsDiv) {
    const flags = mergeRoundFlags(g);

    if (flags.scatter) {
      const chip = document.createElement("span");
      chip.className = "event-flag-chip event-flag-chip--danger";
      chip.textContent = "Scatter! – niemand mag Scouten deze ronde";
      specialFlagsDiv.appendChild(chip);
    }
    if (flags.lockEvents) {
      const chip = document.createElement("span");
      chip.className = "event-flag-chip event-flag-chip--safe";
      chip.textContent = "Burrow Beacon – Event Track gelocked";
      specialFlagsDiv.appendChild(chip);
    }
  }

  updatePhasePanels(g, currentPlayer);
}

function renderPlayer() {
  if (!currentPlayer) return;

  const p = currentPlayer;

  if (playerNameEl) {
    playerNameEl.textContent = p.name || "Onbekende vos";
  }

  if (playerDenColorEl) {
    const color = (p.color || "").toUpperCase();
    let label = "Den: onbekend";
    if (color === "RED") label = "Den: RED";
    else if (color === "BLUE") label = "Den: BLUE";
    else if (color === "GREEN") label = "Den: GREEN";
    else if (color === "YELLOW") label = "Den: YELLOW";
    playerDenColorEl.textContent = label;
  }

  if (playerStatusEl) {
    let statusText;
    if (p.dashed) {
      statusText =
        "Status: DASHED – je hebt de Yard verlaten met je buit.";
    } else if (p.inYard === false) {
      statusText = "Status: CAUGHT – je bent gevangen.";
    } else {
      statusText = "Status: in de Yard.";
    }
    if (p.decision) {
      statusText += ` (Decision deze ronde: ${p.decision})`;
    }
    playerStatusEl.textContent = statusText;
  }

  updateLootUi(p);
  updatePhasePanels(currentGame, p);
}

// ===== MOVE / DECISION BUTTON STATE =====

function updateMoveButtonsState() {
  if (!btnSnatch || !btnForage || !btnScout || !btnShift || !moveStateText)
    return;

  if (!currentGame || !currentPlayer) {
    btnSnatch.disabled = true;
    btnForage.disabled = true;
    btnScout.disabled  = true;
    btnShift.disabled  = true;
    moveStateText.textContent = "Geen game of speler geladen.";
    return;
  }

  const g = currentGame;
  const p = currentPlayer;

  if (g.status === "finished" || g.phase === "END") {
    btnSnatch.disabled = true;
    btnForage.disabled = true;
    btnScout.disabled  = true;
    btnShift.disabled  = true;
    moveStateText.textContent =
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
      moveStateText.textContent = `Je kunt nu geen MOVE doen (fase: ${g.phase}).`;
    } else if (p.inYard === false) {
      moveStateText.textContent = "Je bent niet meer in de Yard.";
    } else if (p.dashed) {
      moveStateText.textContent =
        "Je hebt al DASH gekozen in een eerdere ronde.";
    } else if (moved.includes(playerId)) {
      moveStateText.textContent = "Je hebt jouw MOVE voor deze ronde al gedaan.";
    } else if (g.status !== "round") {
      moveStateText.textContent = "Er is nog geen actieve ronde.";
    } else {
      moveStateText.textContent = "Je kunt nu geen MOVE doen.";
    }
  } else {
    moveStateText.textContent =
      "Je kunt één MOVE doen: SNATCH, FORAGE, SCOUT of SHIFT.";
  }
}

function updateDecisionButtonsState() {
  if (!btnLurk || !btnBurrow || !btnDash || !decisionStateText) return;

  if (!currentGame || !currentPlayer) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent = "Geen game of speler geladen.";
    return;
  }

  const g = currentGame;
  const p = currentPlayer;

  if (g.status === "finished" || g.phase === "END") {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent =
      "Het spel is afgelopen – geen DECISION meer nodig.";
    return;
  }

  if (g.phase !== "DECISION") {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent = "DECISION is nog niet aan de beurt.";
    return;
  }

  if (p.inYard === false) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent =
      "Je zit niet meer in de Yard en doet niet mee aan deze DECISION.";
    return;
  }

  if (p.dashed) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent =
      "Je hebt al eerder DASH gekozen en doet niet meer mee in de Yard.";
    return;
  }

  if (p.decision) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent = `Je DECISION voor deze ronde is: ${p.decision}.`;
    return;
  }

  const can = canDecideNow(g, p);
  btnLurk.disabled = !can;
  btnBurrow.disabled = !can;
  btnDash.disabled = !can;

  if (can) {
    decisionStateText.textContent =
      "Kies jouw DECISION: LURK, HIDE (Burrow) of DASH.";
  } else {
    decisionStateText.textContent =
      "Je kunt nu geen DECISION kiezen.";
  }
}

// ===== HAND UI (ACTIONS) =====

function renderHand() {
  if (!actionsStateText) return;

  if (!currentPlayer || !currentGame) {
    actionsStateText.textContent = "Geen hand geladen.";
    if (btnHand) btnHand.disabled = true;
    if (btnPass) btnPass.disabled = true;
    return;
  }

  const g = currentGame;
  const p = currentPlayer;
  const hand = Array.isArray(p.hand) ? p.hand : [];

  const canPlayOverall = canPlayActionNow(g, p);
  const myTurnOverall  = isMyOpsTurn(g);

  if (!hand.length) {
    if (g.status === "finished" || g.phase === "END") {
      actionsStateText.textContent =
        "Het spel is afgelopen – je kunt geen Action Cards meer spelen.";
    } else {
      actionsStateText.textContent = "Je hebt geen Action Cards in je hand.";
    }
    if (btnHand) btnHand.disabled = true;
    if (btnPass) btnPass.disabled = !(canPlayOverall && myTurnOverall);
    return;
  }

  if (btnHand) {
    btnHand.disabled = !canPlayOverall;
  }

  if (g.phase !== "ACTIONS") {
    actionsStateText.textContent =
      `ACTIONS-fase is nu niet actief. Je hebt ${hand.length} kaart(en) klaarstaan.`;
  } else if (!canPlayOverall) {
    actionsStateText.textContent =
      "Je kunt nu geen Action Cards spelen (niet in de Yard of al DASHED).";
  } else if (!myTurnOverall) {
    actionsStateText.textContent =
      `Je hebt ${hand.length} kaart(en), maar het is nu niet jouw beurt.`;
  } else {
    actionsStateText.textContent =
      `Jij bent aan de beurt – kies een kaart via HAND of kies PASS. Je hebt ${hand.length} kaart(en).`;
  }

  if (btnPass) {
    btnPass.disabled = !(canPlayOverall && myTurnOverall);
  }
}
// ==========================================
// HAND MODAL – ACTION CARDS ALS VJ-CARDS
// ==========================================

function openHandModal() {
  if (!handModalOverlay || !handCardsGrid) return;
  if (!currentGame || !currentPlayer) return;

  renderHandGrid();                       // eerst het raster tonen
  handModalOverlay.classList.remove("hidden");
}

function closeHandModal() {
  if (!handModalOverlay) return;
  handModalOverlay.classList.add("hidden");
}

/**
 * Raster-weergave: alle kaarten als kleine vj-cards met label.
 * Klik op een kaart opent de detail-view.
 */
function renderHandGrid() {
  if (!handCardsGrid) return;

  handCardsGrid.innerHTML = "";

  const g = currentGame;
  const p = currentPlayer;
  if (!g || !p) {
    const msg = document.createElement("p");
    msg.textContent = "Game of speler niet geladen.";
    msg.style.fontSize = "0.85rem";
    msg.style.opacity = "0.85";
    handCardsGrid.appendChild(msg);
    return;
  }

  const hand = Array.isArray(p.hand) ? p.hand : [];

  if (!hand.length) {
    const msg = document.createElement("p");
    msg.textContent = "Je hebt geen Action Cards in je hand.";
    msg.style.fontSize = "0.85rem";
    msg.style.opacity = "0.85";
    handCardsGrid.appendChild(msg);
    return;
  }

  hand.forEach((card, idx) => {
    // Eén tegel per kaart
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "hand-card-tile";

    // De 'kaart' zelf (visueel blok, art via CSS placeholder)
    const cardDiv = document.createElement("div");
    cardDiv.className = "vj-card hand-card";

    // Label onderaan op de kaart
    const label = document.createElement("div");
    label.className = "hand-card-label";
    label.textContent = card.name || `Kaart #${idx + 1}`;

    cardDiv.appendChild(label);
    tile.appendChild(cardDiv);

    // Klik → detail-view van deze kaart
    tile.addEventListener("click", () => openHandCardDetail(idx));

    handCardsGrid.appendChild(tile);
  });
}

/**
 * Detail-view: grote kaart + tekst + knoppen
 */
function openHandCardDetail(index) {
  if (!handCardsGrid) return;
  if (!currentGame || !currentPlayer) return;

  const g = currentGame;
  const p = currentPlayer;
  const hand = Array.isArray(p.hand) ? p.hand : [];

  if (index < 0 || index >= hand.length) return;
  const card = hand[index];

  handCardsGrid.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "hand-card-detail";

  // Grote kaart
  const bigCard = document.createElement("div");
  bigCard.className = "vj-card hand-card hand-card-large";

  const label = document.createElement("div");
  label.className = "hand-card-label";
  label.textContent = card.name || `Kaart #${index + 1}`;
  bigCard.appendChild(label);

  // Tekstblok met titel + beschrijving
  const textBox = document.createElement("div");
  textBox.className = "hand-card-detail-text";

  const titleEl = document.createElement("h3");
  titleEl.textContent = card.name || "Onbekende kaart";

  const descEl = document.createElement("p");
  const desc =
    card.desc ||
    card.text ||
    "Deze kaart heeft nog geen digitale beschrijving. Gebruik de fysieke spelregels of speel hem op gevoel.";
  descEl.textContent = desc;

  textBox.appendChild(titleEl);
  textBox.appendChild(descEl);

  // Actieknoppen
  const actions = document.createElement("div");
  actions.className = "hand-card-detail-actions";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "phase-btn phase-btn-primary";
  playBtn.textContent = "Speel deze kaart";

  // Alleen actief als je nu echt mag spelen
  const canPlayNow = canPlayActionNow(g, p) && isMyOpsTurn(g);
  playBtn.disabled = !canPlayNow;

  playBtn.addEventListener("click", async () => {
    // Laat playActionCard alles afhandelen (log, hand updaten, OPS-rotatie)
    await playActionCard(index);
    closeHandModal(); // modal dicht, kaart is uit je hand als het spelen gelukt is
  });

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "phase-btn phase-btn-secondary";
  backBtn.textContent = "Terug naar hand";

  // Terug naar raster – kaart blijft gewoon in je hand
  backBtn.addEventListener("click", () => {
    renderHandGrid();
  });

  actions.appendChild(playBtn);
  actions.appendChild(backBtn);

  wrapper.appendChild(bigCard);
  wrapper.appendChild(textBox);
  wrapper.appendChild(actions);

  handCardsGrid.appendChild(wrapper);
}

// ==========================================
// LOOT MODAL – BUITKAARTEN ALS VJ-CARDS
// ==========================================

function renderLootModal() {
  if (!lootCardsGrid) return;

  lootCardsGrid.innerHTML = "";

  if (!currentPlayer) {
    const msg = document.createElement("p");
    msg.textContent = "Speler niet geladen.";
    msg.style.fontSize = "0.85rem";
    msg.style.opacity = "0.85";
    lootCardsGrid.appendChild(msg);
    return;
  }

  const p = currentPlayer;

  // 1) Echte loot-kaarten op de speler
  let loot = Array.isArray(p.loot) ? [...p.loot] : [];

  // 2) Als er geen losse loot-kaarten zijn, maak pseudo-kaarten
  //    van eggs / hens / prize (score)
  if (!loot.length) {
    const eggs  = p.eggs  || 0;
    const hens  = p.hens  || 0;
    const prize = p.prize || 0;

    if (!eggs && !hens && !prize) {
      const msg = document.createElement("p");
      msg.textContent = "Je hebt nog geen buit verzameld.";
      msg.style.fontSize = "0.85rem";
      msg.style.opacity = "0.85";
      lootCardsGrid.appendChild(msg);
      return;
    }

    if (prize > 0) {
      loot.push({ t: "Prize Hen", v: 3, count: prize });
    }
    if (hens > 0) {
      loot.push({ t: "Hen", v: 2, count: hens });
    }
    if (eggs > 0) {
      loot.push({ t: "Egg", v: 1, count: eggs });
    }
  }

  loot.forEach((card, index) => {
    const tile = document.createElement("div");
    tile.className = "loot-card-tile";

    const cardDiv = document.createElement("div");
    cardDiv.className = "vj-card loot-card";

    const label = document.createElement("div");
    label.className = "loot-card-label";

    const type  = card.t || card.type || "Loot";
    const val   = card.v ?? "?";
    const count = card.count || 1;

    label.textContent = `${type} x${count} (waarde ${val})`;

    cardDiv.appendChild(label);
    tile.appendChild(cardDiv);
    lootCardsGrid.appendChild(tile);
  });
}

function openLootModal() {
  if (!lootModalOverlay) return;
  renderLootModal();
  lootModalOverlay.classList.remove("hidden");
}

function closeLootModal() {
  if (!lootModalOverlay) return;
  lootModalOverlay.classList.add("hidden");
}

// ===== LOGGING HELPER =====

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

// OPS-doorrotatie
function computeNextOpsIndex(game) {
  const order = game.opsTurnOrder || [];
  if (!order.length) return 0;
  const idx =
    typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

// ===== MOVE-ACTIES =====

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

  const card = lootDeck.pop();
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

// ===== DECISION ACTIES =====

async function selectDecision(kind) {
  if (!gameRef || !playerRef) return;

  const gameSnap = await getDoc(gameRef);
  const playerSnap = await getDoc(playerRef);
  if (!gameSnap.exists() || !playerSnap.exists()) return;

  const game = gameSnap.data();
  const player = playerSnap.data();

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

// ===== ACTION CARDS / OPS =====

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

// ===== CONCRETE ACTION CARD EFFECTS =====
// (ongewijzigde logica, alleen feedback via setActionFeedback)

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

  setActionFeedback("Scatter! is actief – niemand mag Scouten deze ronde.");

  return true;
}

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

  setActionFeedback(`Molting Mask: je Den kleur is nu ${newColor}.`);

  return true;
}

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

async function playNoseForTrouble(game, player) {
  const track = game.eventTrack || [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return false;
  }

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

async function playScentCheck(game, player) {
  const target = await chooseOtherPlayerPrompt(
    "Scent Check – kies een vos om te besnuffelen"
  );
  if (!target) return false;

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

// ===== INIT / LISTENERS =====

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
      if (playerNameEl) playerNameEl.textContent = "Speler niet gevonden.";
      return;
    }
    currentPlayer = { id: snap.id, ...snap.data() };
    renderPlayer();
  });

// bij player-init
ensureHostCoachMount(); preloadHost();

// na succesvolle actie
hostSay("action_success");

// voor event reveal
hostSay("pre_reveal");

// paint-bomb
if (event.id === "PAINT_BOMB_NEST") hostSay("paint_bomb");

// speler gepakt
if (player.caught) hostSay("caught");

// ronde voorbij (rooster==3)
if (game.roosterCount === 3) hostSay("round_lost");

// geen input 25s
let idleT; window.addEventListener("mousemove", resetIdle);
window.addEventListener("keydown", resetIdle);
function resetIdle(){ clearTimeout(idleT); idleT=setTimeout(()=>hostSay("timeout"), 25000); }

  
  // MOVE
  if (btnSnatch) btnSnatch.addEventListener("click", performSnatch);
  if (btnForage) btnForage.addEventListener("click", performForage);
  if (btnScout)  btnScout.addEventListener("click", performScout);
  if (btnShift)  btnShift.addEventListener("click", performShift);

  // DECISION
  if (btnLurk)
    btnLurk.addEventListener("click", () => selectDecision("LURK"));
  if (btnBurrow)
    btnBurrow.addEventListener("click", () => selectDecision("BURROW"));
  if (btnDash)
    btnDash.addEventListener("click", () => selectDecision("DASH"));

  // ACTIONS
  if (btnPass) btnPass.addEventListener("click", passAction);
  if (btnHand) btnHand.addEventListener("click", openHandModal);
  if (btnLoot) btnLoot.addEventListener("click", openLootModal);

  if (btnLead) {
    btnLead.addEventListener("click", async () => {
      if (!currentGame) {
        alert("Geen game geladen.");
        return;
      }
      const players = await fetchPlayersForGame();
      const ordered = sortPlayersByJoinOrder(players);
      const idx =
        typeof currentGame.leadIndex === "number"
          ? currentGame.leadIndex
          : 0;
      const lead = ordered[idx];
      if (!lead) {
        alert("Er is nog geen Lead Fox aangewezen.");
        return;
      }
      alert(`Lead Fox is: ${lead.name || "Vos"} (Den ${lead.color || "?"})`);
    });
  }

  if (btnHint) {
    btnHint.addEventListener("click", () => {
      alert(
        "Hint-bot volgt later. Voor nu: probeer jouw buit te maximaliseren zonder te lang in de Yard te blijven…"
      );
    });
  }

  // Modals sluiten
  if (handModalClose) {
    handModalClose.addEventListener("click", closeHandModal);
  }
  if (handModalOverlay) {
    handModalOverlay.addEventListener("click", (e) => {
      if (e.target === handModalOverlay) closeHandModal();
    });
  }

  if (lootModalClose) {
    lootModalClose.addEventListener("click", closeLootModal);
  }
  if (lootModalOverlay) {
    lootModalOverlay.addEventListener("click", (e) => {
      if (e.target === lootModalOverlay) closeLootModal();
    });
  }
});
