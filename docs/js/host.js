// host.js — VOSSENJACHT (clean host + bots in botRunner.js)
// + PhaseGate (NextPhase READY/NOT READY)
// + Raid Pause/Resume + auto-advance after 5s when paused
// + REVEAL suspense: 10s countdown + "Onthul nu" + reveal triggers resolveAfterReveal

import { initAuth } from "./firebase.js";
import { getEventById, CARD_BACK, getActionDefByName } from "./cards.js";
import { resolveAfterReveal } from "./engine.js";
import { renderPlayerSlotCard } from "./cardRenderer.js";
import { addBotToCurrentGame, startBotRunner } from "./bots/botRunner.js";
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
  addDoc,
  serverTimestamp,
  runTransaction, } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const AUTO_FLOW = true;
const AUTO_PAUSE_MS = 5000; // jouw “adempauze”
const db = getFirestore();

const params = new URLSearchParams(window.location.search);
let gameId = params.get("game");
const mode = params.get("mode") || "host"; // "host" | "board"
const isBoardOnly = mode === "board";

let gameRef = null;
let playersColRef = null;

if (gameId) {
  gameRef = doc(db, "games", gameId);
  playersColRef = collection(db, "games", gameId, "players");
}

// ===============================
// Basis host UI
// ===============================
const gameInfo = document.getElementById("gameInfo");
const roundInfo = document.getElementById("roundInfo");
const logPanel = document.getElementById("logPanel");

// Logpaneel verbergen in Community Board modus
if (isBoardOnly && logPanel) logPanel.style.display = "none";

const startBtn = document.getElementById("startRoundBtn");
const endBtn = document.getElementById("endRoundBtn"); // oude testknop
const nextPhaseBtn = document.getElementById("nextPhaseBtn");
const playAsHostBtn = document.getElementById("playAsHostBtn");
const newRaidBtn = document.getElementById("newRaidBtn");
const addBotBtn = document.getElementById("addBotBtn");

// Board / zones
const eventTrackDiv = document.getElementById("eventTrack");
const yardZone = document.getElementById("yardZone");
const caughtZone = document.getElementById("caughtZone");
const dashZone = document.getElementById("dashZone");

// Status cards
const phaseCard = document.getElementById("phaseCard");
const leadFoxCard = document.getElementById("leadFoxCard");
const roosterCard = document.getElementById("roosterCard");
const beaconCard = document.getElementById("beaconCard");
const scatterCard = document.getElementById("scatterCard");
const fullMoonCard = document.getElementById("fullMoonCard");
const optionACard = document.getElementById("optionACard");
const optionBCard = document.getElementById("optionBCard");
const sackCard = document.getElementById("sackCard");
const lootDeckCard = document.getElementById("lootDeckCard");
const actionDeckCard = document.getElementById("actionDeckCard");
const actionDiscardCard = document.getElementById("actionDiscardCard");


// Fullscreen toggle
const fullscreenBtn = document.getElementById("fullscreenBtn");
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    document.body.classList.toggle("fullscreen-board");
  });
}

// QR Join overlay / controls
const qrJoinOverlay = document.getElementById("qrJoinOverlay");
const qrJoinLabel = document.getElementById("qrJoinLabel");
const qrJoinContainer = document.getElementById("qrJoin");
const qrJoinToggleBtn = document.getElementById("qrJoinToggleBtn");
const qrJoinCloseBtn = document.getElementById("qrJoinCloseBtn");
let qrInstance = null;

// Scoreboard overlay / controls
const scoreOverlay = document.getElementById("scoreOverlay");
const scoreOverlayContent = document.getElementById("scoreOverlayContent");
const showScoreboardBtn = document.getElementById("showScoreboardBtn");
const scoreOverlayCloseBtn = document.getElementById("scoreOverlayCloseBtn");

// Event poster overlay / controls
const eventPosterOverlay = document.getElementById("eventPosterOverlay");
const eventPosterTitle = document.getElementById("eventPosterTitle");
const eventPosterImage = document.getElementById("eventPosterImage");
const eventPosterText = document.getElementById("eventPosterText");
const eventPosterCloseBtn = document.getElementById("eventPosterCloseBtn");
const eventPosterPrevBtn = document.getElementById("eventPosterPrevBtn");
const eventPosterNextBtn = document.getElementById("eventPosterNextBtn");

// Player poster overlay / controls
const playerPosterOverlay = document.getElementById("playerPosterOverlay");
const playerPosterTitle = document.getElementById("playerPosterTitle");
const playerPosterMount = document.getElementById("playerPosterMount");
const playerPosterCloseBtn = document.getElementById("playerPosterCloseBtn");
const playerPosterPrevBtn = document.getElementById("playerPosterPrevBtn");
const playerPosterNextBtn = document.getElementById("playerPosterNextBtn");

// Laatste event dat we fullscreen hebben getoond (UI-key incl. revealed state)
let lastPosterUiKey = null;

// Verberg oude test-knop (endBtn)
if (endBtn) endBtn.style.display = "none";

// ===============================
// NEW: PhaseGate + Pause/AutoAdvance + RevealCountdown config
// ===============================
const REVEAL_COUNTDOWN_MS = 10_000; // 10 sec
const AUTO_ADVANCE_MS = 5_000; // 5 sec

// UI assets
const CARD_BACK_UI = "./assets/card_back_logo.png";
const CARD_PLACEHOLDER_UI = "./assets/card_placeholder.png";

let autoAdvanceTimer = null;
let autoAdvanceKey = null;
let revealCountdownTimer = null;
let revealCountdownEventId = null;

// Carousel state
let eventPosterIndex = null;
let playerPosterIndex = null;
let playerPosterOrder = [];

// UI elements that may not exist in HTML -> we inject safely
function ensureAfter(el, newEl) {
  if (!el || !el.parentElement) return null;
  const parent = el.parentElement;
  if (el.nextSibling) parent.insertBefore(newEl, el.nextSibling);
  else parent.appendChild(newEl);
  return newEl;
}

function ensurePauseButton() {
  let btn = document.getElementById("pauseRaidBtn");
  if (btn) return btn;
  if (!nextPhaseBtn) return null;

  btn = document.createElement("button");
  btn.id = "pauseRaidBtn";
  btn.className = "btn btn-ghost";
  btn.textContent = "Raid pauzeren";

  return ensureAfter(nextPhaseBtn, btn);
}

function ensurePhaseGateHint() {
  let el = document.getElementById("phaseGateHint");
  if (el) return el;
  if (!nextPhaseBtn) return null;

  el = document.createElement("div");
  el.id = "phaseGateHint";
  el.style.marginTop = "6px";
  el.style.fontSize = "12px";
  el.style.opacity = "0.85";
  el.style.maxWidth = "520px";
  el.textContent = "";

  // probeer onder de knoppen te zetten (zelfde parent)
  const parent = nextPhaseBtn.parentElement;
  if (parent) {
    parent.appendChild(el);
    return el;
  }
  return null;
}

const pauseRaidBtn = ensurePauseButton();
const phaseGateHint = ensurePhaseGateHint();

function makeWaitId(game, toPhase) {
  return `${game.id || ""}_${game.round || 0}_${game.phase || ""}_to_${toPhase}_${Date.now()}`;
}

async function schedulePhaseWait(gameRef, game, toPhase, delayMs) {
  const wait = {
    from: game.phase,
    to: toPhase,
    dueAtMs: Date.now() + delayMs,
    id: makeWaitId(game, toPhase),
  };

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists()) return;
    const g = snap.data();

    // Alleen plannen als we nog in dezelfde fase zitten en er nog geen wait loopt
    if (g.phase !== game.phase) return;
    if (g.phaseWait && g.phaseWait.from === g.phase) return;

    tx.update(gameRef, { phaseWait: wait });
  });
}

async function tryExecutePhaseWait(gameRef, game) {
  const w = game.phaseWait;
  if (!w) return false;

  // Alleen uitvoeren als de wait bij de huidige fase hoort
  if (w.from !== game.phase) return false;

  // Nog niet tijd
  if (Date.now() < (w.dueAtMs || 0)) return false;

  // Uitvoeren in transaction (guard tegen dubbel uitvoeren)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists()) return;
    const g = snap.data();
    const ww = g.phaseWait;

    if (!ww) return;
    if (g.phase !== ww.from) return;
    if (ww.id !== w.id) return; // stale
    if (Date.now() < (ww.dueAtMs || 0)) return;

    // ✅ Hier doe je de echte fase-overgang
    // Belangrijk: phaseWait opruimen
    tx.update(gameRef, {
      phase: ww.to,
      phaseWait: null,
      // optioneel:
      // phaseStartedAtMs: Date.now(),
    });
  });

  return true;
}

// ===============================
// State
// ===============================
let hostUid = null;
let stopBots = null;

let currentRoundNumber = 0;
let currentRoundForActions = 0;
let currentPhase = "MOVE";
let unsubActions = null;

let latestPlayers = [];
let latestGame = null;

let currentLeadFoxId = null;
let currentLeadFoxName = "";

let latestPlayersCacheForScoreboard = [];

const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];

// ===============================
// Helpers
// ===============================
function isActiveRaidStatus(status) {
  return status === "raid" || status === "round";
}

function isGameFinished(game) {
  return !game || game.status === "finished" || game.phase === "END";
}

function isInYardLocal(p) {
  return p?.inYard !== false && !p?.dashed;
}
function isInYardForEvents(p) {
  return isInYardLocal(p);
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===============================
// NEW: PhaseGate logic (READY/NOT READY) + UI helpers
// ===============================
function getActiveYardPlayers(players) {
  return (players || []).filter(isInYardForEvents);
}

function computePhaseGate(game, players) {
  const g = game || {};
  const phase = g.phase || "MOVE";

  if (isGameFinished(g)) {
    return { ready: false, reason: "Spel is afgelopen.", missing: [] };
  }
  if (!isActiveRaidStatus(g.status)) {
    return { ready: false, reason: "Nog geen actieve ronde.", missing: [] };
  }

  const active = getActiveYardPlayers(players);
  const activeCount = active.length;

  // MOVE -> ACTIONS
  if (phase === "MOVE") {
    const moved = Array.isArray(g.movedPlayerIds) ? g.movedPlayerIds : [];
    const mustMoveCount = activeCount;

    if (mustMoveCount === 0) {
      return { ready: true, reason: "Geen actieve vossen in de Yard — OPS wordt overgeslagen.", missing: [] };
    }
    if (moved.length >= mustMoveCount) {
      return { ready: true, reason: `Iedereen heeft MOVE gedaan (${moved.length}/${mustMoveCount}).`, missing: [] };
    }
    return {
      ready: false,
      reason: `Wacht op MOVE: ${moved.length}/${mustMoveCount}.`,
      missing: [],
    };
  }

  // ACTIONS -> DECISION
  if (phase === "ACTIONS") {
    const passes = Number(g.opsConsecutivePasses || 0);
    const opsLocked = !!g.flagsRound?.opsLocked;

    if (opsLocked) {
      return { ready: true, reason: "OPS is gelocked — door naar DECISION.", missing: [] };
    }
    if (activeCount === 0) {
      return { ready: true, reason: "Geen actieve vossen — OPS klaar.", missing: [] };
    }
    if (passes >= activeCount) {
      return { ready: true, reason: `Iedereen heeft na elkaar gepast (${passes}/${activeCount}).`, missing: [] };
    }
    return {
      ready: false,
      reason: `OPS bezig: opeenvolgende PASSes ${passes}/${activeCount}.`,
      missing: [],
    };
  }

  // DECISION -> REVEAL
  if (phase === "DECISION") {
    if (activeCount === 0) {
      return { ready: true, reason: "Geen actieve vossen — door naar REVEAL.", missing: [] };
    }
    const decided = active.filter((p) => !!p.decision).length;
    if (decided >= activeCount) {
      return { ready: true, reason: `Iedereen heeft DECISION gekozen (${decided}/${activeCount}).`, missing: [] };
    }
    return { ready: false, reason: `Wacht op DECISION: ${decided}/${activeCount}.`, missing: [] };
  }

  // REVEAL -> MOVE/END
// REVEAL = einde van de ronde (nooit auto door)
if (phase === "REVEAL") {
  const pr = g.pendingReveal;

  // zolang countdown loopt: niet ready
  if (pr && pr.eventId === g.currentEventId && pr.revealed !== true) {
    const now = Date.now();
    const revealAt = Number(pr.revealAtMs || 0);
    const leftSec = Math.ceil(Math.max(0, revealAt - now) / 1000);
    return { ready: false, reason: `Event onthulling bezig… (${leftSec}s)`, missing: [] };
  }
}

  // ook als al onthuld: ronde stopt hier
  return { ready: false, reason: "REVEAL = einde ronde. Klik ‘Nieuwe ronde’.", missing: [] };
}

function clearAutoAdvance() {
  if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = null;
  autoAdvanceKey = null;
}

function applyNextPhaseUi(gate, game) {
  if (!nextPhaseBtn) return;

  // ✅ alleen “indicator”: we laten de bestaande alerts/guards intact
  nextPhaseBtn.classList.remove("btn-ready", "btn-notready");
  nextPhaseBtn.classList.add(gate?.ready ? "btn-ready" : "btn-notready");

  // tooltip voor snel inzicht
  nextPhaseBtn.title = gate?.reason || "";

  if (phaseGateHint) {
    phaseGateHint.textContent = gate?.reason || "";
  }

  // Pause button label (als aanwezig)
  if (pauseRaidBtn) {
    const paused = !!game?.raidPaused;
    pauseRaidBtn.textContent = paused ? "Raid hervatten" : "Raid pauzeren";
    pauseRaidBtn.classList.toggle("btn-paused", paused);
  }
}

async function maybeScheduleAutoAdvance(game, gate) {
  if (!AUTO_FLOW) {
    clearAutoAdvance();
    return;
  }
  if (!gameRef) return;

  // Pause = freeze autoplay
  if (game?.raidPaused) {
    clearAutoAdvance();
    return;
  }

  const phase = game?.phase || "MOVE";

  // REVEAL/END nooit auto door (REVEAL = einde ronde)
  if (phase === "REVEAL" || phase === "END") {
    clearAutoAdvance();
    return;
  }

  // als nog niet ready: geen timer
  if (!gate?.ready) {
    clearAutoAdvance();
    return;
  }

  // ✅ als er een BREATHER phaseWait staat voor deze fase: plan exact op executeAtMs
  let delayMs = AUTO_ADVANCE_MS; // fallback
  const w = game?.phaseWait;

  if (w && w.kind === "BREATHER" && w.from === phase) {
    const left = Number(w.executeAtMs || 0) - Date.now();
    delayMs = Math.max(0, left) + 30; // +30ms marge tegen “net te vroeg”
  } else {
    // geen wait? dan triggert handleNextPhase zelf het plannen van de wait
    delayMs = 30;
  }

  // unieke key om dubbele timers te voorkomen
  const key = [
    game?.status || "",
    game?.round || 0,
    phase,
    game?.opsConsecutivePasses || 0,
    game?.eventIndex || 0,
    w?.kind || "",
    w?.from || "",
    w?.to || "",
    w?.executeAtMs || 0,
  ].join("|");

  if (autoAdvanceTimer && autoAdvanceKey === key) return;

  clearAutoAdvance();
  autoAdvanceKey = key;

  autoAdvanceTimer = setTimeout(async () => {
    try {
      // recheck actuele game
      const snap = await getDoc(gameRef);
      if (!snap.exists()) return;
      const g = snap.data();

      if (g?.raidPaused) return;

      const phase2 = g?.phase || "MOVE";
      if (phase2 === "REVEAL" || phase2 === "END") return;

      const gate2 = computePhaseGate(g, Array.isArray(latestPlayers) ? latestPlayers : []);
      if (!gate2.ready) return;

      // ✅ dit is de “tweede tik” na de BREATHER
      await handleNextPhase({ silent: true, force: false });
    } catch (err) {
      console.error("Auto-advance fout:", err);
    }
  }, delayMs);
}

// ===============================
// Event poster
// ===============================
function ensureRevealNowButton() {
  if (!eventPosterOverlay) return null;
  const box = eventPosterOverlay.querySelector(".overlay-box");
  if (!box) return null;

  let btn = box.querySelector("#eventRevealNowBtn");
  if (btn) return btn;

  btn = document.createElement("button");
  btn.id = "eventRevealNowBtn";
  btn.className = "btn btn-secondary";
  btn.textContent = "Onthul nu";

  // probeer in overlay-content te plaatsen
  const content = box.querySelector(".overlay-content");
  if (content) {
    content.appendChild(btn);
  } else {
    box.appendChild(btn);
  }

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await revealNowIfPending();
  });

  // click op overlay-box = ook onthullen (maar niet op close button)
  box.addEventListener("click", async (e) => {
    const t = e.target;
    if (t && (t.id === "eventPosterCloseBtn" || t.closest("#eventPosterCloseBtn"))) return;
    // alleen als we in countdown zitten
    const g = latestGame;
    const pr = g?.pendingReveal;
    if (g?.phase === "REVEAL" && pr && pr.eventId === g.currentEventId && pr.revealed !== true) {
      await revealNowIfPending();
    }
  });

  return btn;
}

function stopRevealCountdown() {
  if (revealCountdownTimer) clearInterval(revealCountdownTimer);
  revealCountdownTimer = null;
  revealCountdownEventId = null;
}

// ---- Carousel helpers (Event poster) ----
function clampInt(n, min, max) {
  const v = Number.isFinite(Number(n)) ? Number(n) : min;
  return Math.max(min, Math.min(max, v));
}

function setPosterNavDisabled(btn, disabled) {
  if (!btn) return;
  btn.disabled = !!disabled;
  btn.classList.toggle("is-disabled", !!disabled);
}

function showEventPosterNav(show) {
  const c = document.getElementById("eventPosterCarousel");
  if (c) c.style.display = show ? "" : "none";
  if (eventPosterPrevBtn) eventPosterPrevBtn.style.display = show ? "" : "none";
  if (eventPosterNextBtn) eventPosterNextBtn.style.display = show ? "" : "none";
}

function renderEventPosterByIndex(idx) {
  if (!eventPosterOverlay) return;

  const g = latestGame || {};
  const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
  const revealed = Array.isArray(g.eventRevealed) ? g.eventRevealed : [];

  if (!track.length) return;

  const i = clampInt(idx, 0, track.length - 1);
  eventPosterIndex = i;

  // nav state
  showEventPosterNav(true);
  setPosterNavDisabled(eventPosterPrevBtn, i <= 0);
  setPosterNavDisabled(eventPosterNextBtn, i >= track.length - 1);

  // decision wall weg bij browse
  hideDecisionWall();

  const eventId = track[i];

  // als niet onthuld: toon back + basic info
  const isRevealed =
    !!revealed[i] ||
    (g.phase === "REVEAL" &&
      g.currentEventId === eventId &&
      g.pendingReveal &&
      g.pendingReveal.revealed === true);

  if (!isRevealed) {
    if (eventPosterTitle) eventPosterTitle.textContent = `Verborgen Event (${i + 1}/${track.length})`;
    if (eventPosterText) eventPosterText.textContent = "Nog niet onthuld.";
    if (eventPosterImage) {
      eventPosterImage.src = CARD_BACK_UI;
      eventPosterImage.style.display = "";
    }
  } else {
    const ev = getEventById(eventId);
    if (eventPosterTitle) eventPosterTitle.textContent = ev?.title || "";
    if (eventPosterText) eventPosterText.textContent = ev?.text || "";
    if (eventPosterImage) {
      eventPosterImage.src = ev?.imagePoster || ev?.imageFront || CARD_BACK_UI;
      eventPosterImage.style.display = "";
    }
  }

  // reveal button uit bij browse
  const box = eventPosterOverlay.querySelector(".overlay-box");
  const btn = box ? box.querySelector("#eventRevealNowBtn") : null;
  if (btn) btn.style.display = "none";
}

function stepEventPoster(dir) {
  const g = latestGame || {};
  const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
  if (!track.length) return;

  // tijdens countdown geen browse
  const pr = g.pendingReveal;
  if (g.phase === "REVEAL" && pr && pr.eventId === g.currentEventId && pr.revealed !== true) return;

  const cur = Number.isFinite(Number(eventPosterIndex)) ? Number(eventPosterIndex) : 0;
  const next = clampInt(cur + dir, 0, track.length - 1);
  if (next === cur) return;
  renderEventPosterByIndex(next);
  eventPosterOverlay.classList.remove("hidden");
}

if (eventPosterPrevBtn) {
  eventPosterPrevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stepEventPoster(-1);
  });
}
if (eventPosterNextBtn) {
  eventPosterNextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stepEventPoster(1);
  });
}

// ===============================
// REVEAL: Decision Wall (nieuw)
// ===============================

let lastDecisionWallKey = null;

function ensureDecisionWall() {
  if (!eventPosterOverlay) return null;
  const box = eventPosterOverlay.querySelector(".overlay-box");
  if (!box) return null;

  let wall = box.querySelector("#decisionWall");
  if (wall) return wall;

  wall = document.createElement("div");
  wall.id = "decisionWall";
  wall.className = "decision-wall decision-wall--reveal";

  const content = box.querySelector(".overlay-content");
  if (content) content.appendChild(wall);
  else box.appendChild(wall);

  return wall;
}

function hideDecisionWall() {
  const wall = ensureDecisionWall();
  if (!wall) return;
  wall.style.display = "none";
  wall.innerHTML = "";
  lastDecisionWallKey = null;
}

function normalizeDecision(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (s.startsWith("DECISION_")) return s.slice("DECISION_".length);
  return s;
}

function decisionMeta(decision) {
  const d = (decision || "").toUpperCase();
  if (d === "DASH") return { label: "DASH", cls: "decision-dash" };
  if (d === "BURROW") return { label: "HIDE", cls: "decision-burrow" };
  if (d === "LURK") return { label: "LURK", cls: "decision-lurk" };
  return { label: "HELLO", cls: "decision-unknown" };
}
function renderDecisionWallReveal(game, players) {
  const wall = ensureDecisionWall();
  if (!wall) return;

  const list = Array.isArray(players) ? players : [];
  const active = list.filter(isInYardForEvents);

  const ordered = [...active].sort((a, b) => {
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  const key = ordered.map((p) => `${p.id}:${normalizeDecision(p.decision) || ""}`).join("|");
  if (key === lastDecisionWallKey) return;
  lastDecisionWallKey = key;

  wall.style.display = "";
  wall.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "decision-wall-grid decision-wall-grid--reveal";
  wall.appendChild(grid);

  let baseSizeSet = false;

  ordered.forEach((p, idx) => {
    // ✅ SLOT: reserveert ruimte zodat scale nooit overlap geeft
    const slot = document.createElement("div");
    slot.className = "decision-reveal-slot";

    // Kaart maken (ONGESCALED eerst)
    let card = null;
    try {
      card = renderPlayerSlotCard(p, { size: "medium", footer: "", isLead: false });
    } catch (e) {
      card = null;
    }

    if (!card) {
      card = document.createElement("div");
      card.className = "decision-mini-fallback";
      card.textContent = p.name || "Vos";
    }

    // badge heeft absolute positie → card moet relative zijn
    card.style.position = "relative";

    // eerst in DOM zetten zodat we base size kunnen meten
    slot.appendChild(card);
    grid.appendChild(slot);

    // ✅ 1x base afmeting zetten (alleen als we echte layout-size hebben)
    // offsetWidth/offsetHeight negeren transforms → perfect hiervoor
    if (!baseSizeSet) {
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      if (w > 0 && h > 0) {
        grid.style.setProperty("--base-w", `${w}px`);
        grid.style.setProperty("--base-h", `${h}px`);
        grid.style.setProperty("--scale", "2");
        baseSizeSet = true;
      }
    }

    // NU pas de reveal-scale class toevoegen
    card.classList.add("decision-reveal-card");

    // Decision badge
    const d = normalizeDecision(p.decision);
    const meta = decisionMeta(d);

    const badge = document.createElement("div");
    badge.className = `decision-badge decision-badge--reveal ${meta.cls}`;
    badge.textContent = meta.label;

    card.appendChild(badge);
  });

  // fallback als meten niet lukte (bijv. overlay nog display:none)
  if (!baseSizeSet) {
    grid.style.setProperty("--base-w", "180px");
    grid.style.setProperty("--base-h", "240px");
    grid.style.setProperty("--scale", "2");
  }
}

function renderRevealCountdownUi(pr) {
  if (!eventPosterOverlay || !eventPosterTitle || !eventPosterText) return;

  const now = Date.now();
  const revealAt = Number(pr?.revealAtMs || 0);
  const leftMs = Math.max(0, revealAt - now);
  const leftSec = Math.ceil(leftMs / 1000);

  // Titel + tekst
  eventPosterTitle.textContent = "DECISION WALL";
  eventPosterText.textContent = `Onthulling over ${leftSec} seconden…`;

  // ✅ Poster/kaart weg tijdens countdown
  if (eventPosterImage) {
    eventPosterImage.style.display = "none";
    eventPosterImage.src = ""; // optioneel
  }

  // ✅ grote spelerskaarten met keuze
  renderDecisionWallReveal(latestGame, latestPlayers);

  // “Onthul nu” knop blijft
  const btn = ensureRevealNowButton();
  if (btn) btn.style.display = "";
}

function renderRevealedEventUi(eventId) {
  if (!eventPosterOverlay || !eventId) return;

  // ✅ decision wall weg zodra event echt onthuld is
  hideDecisionWall();

  // ✅ poster terug
  if (eventPosterImage) eventPosterImage.style.display = "";

  const ev = getEventById(eventId);
  if (!ev) return;

  if (eventPosterTitle) eventPosterTitle.textContent = ev.title || "";
  if (eventPosterText) eventPosterText.textContent = ev.text || "";
  if (eventPosterImage) {
    const src = ev.imagePoster || ev.imageFront || CARD_BACK_UI;
    eventPosterImage.src = src;
    eventPosterImage.style.display = "";
  }

  const box = eventPosterOverlay.querySelector(".overlay-box");
  const btn = box ? box.querySelector("#eventRevealNowBtn") : null;
  if (btn) btn.style.display = "none";
}

function openEventPoster(eventId) {
  if (!eventPosterOverlay || !eventId) return;

  const g = latestGame || {};
  const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
  const idx = track.indexOf(eventId);
  eventPosterIndex = idx >= 0 ? idx : 0;

  // suspense-mode: als pendingReveal matcht en nog niet revealed => countdown UI
  const pr = g?.pendingReveal;

  if (g?.phase === "REVEAL" && pr && pr.eventId === eventId && pr.revealed !== true) {
    // tijdens countdown geen carousel
    showEventPosterNav(false);

    renderRevealCountdownUi(pr);

    eventPosterOverlay.classList.remove("hidden");

    // start/refresh countdown timer
    if (revealCountdownEventId !== eventId) {
      stopRevealCountdown();
      revealCountdownEventId = eventId;

      revealCountdownTimer = setInterval(async () => {
        const gg = latestGame;
        const ppr = gg?.pendingReveal;
        if (!gg || gg.phase !== "REVEAL" || !ppr || ppr.eventId !== eventId) {
          stopRevealCountdown();
          return;
        }
        if (ppr.revealed === true) {
          stopRevealCountdown();
          return;
        }
        renderRevealCountdownUi(ppr);

        // auto-onthul als tijd voorbij is (safety)
        const now = Date.now();
        if (Number(ppr.revealAtMs || 0) <= now) {
          await revealNowIfPending();
        }
      }, 250);
    }

    return;
  }

  // normaal: toon event poster (carousel)
  showEventPosterNav(true);
  renderEventPosterByIndex(eventPosterIndex);
  eventPosterOverlay.classList.remove("hidden");
}

function closeEventPoster() {
  if (!eventPosterOverlay) return;
  eventPosterOverlay.classList.add("hidden");
}

if (eventPosterCloseBtn && eventPosterOverlay) {
  eventPosterCloseBtn.addEventListener("click", closeEventPoster);
}
if (eventPosterOverlay) {
  eventPosterOverlay.addEventListener("click", (e) => {
    // behoud: click op backdrop sluit
    if (e.target === eventPosterOverlay) closeEventPoster();
  });
}

// ===============================
// Player poster (click to zoom + carousel)
// ===============================
function closePlayerPoster() {
  if (!playerPosterOverlay) return;
  playerPosterOverlay.classList.add("hidden");
}

if (playerPosterCloseBtn && playerPosterOverlay) {
  playerPosterCloseBtn.addEventListener("click", closePlayerPoster);
}
if (playerPosterOverlay) {
  playerPosterOverlay.addEventListener("click", (e) => {
    if (e.target === playerPosterOverlay) closePlayerPoster();
  });
}

function renderPlayerPosterByIndex(idx) {
  if (!playerPosterOverlay || !playerPosterMount) return;

  const order =
    Array.isArray(playerPosterOrder) && playerPosterOrder.length
      ? playerPosterOrder
      : Array.isArray(latestPlayers)
        ? latestPlayers.map((p) => p.id)
        : [];

  if (!order.length) return;

  const i = clampInt(idx, 0, order.length - 1);
  playerPosterIndex = i;

  const pid = order[i];
  const p = Array.isArray(latestPlayers) ? latestPlayers.find((x) => x?.id === pid) : null;

  if (playerPosterTitle) playerPosterTitle.textContent = p?.name || "Player";

  playerPosterMount.innerHTML = "";

  if (p) {
    const isLead = currentLeadFoxId && p.id === currentLeadFoxId;
    const card = renderPlayerSlotCard(p, { size: "large", footer: "", isLead });
    if (card) playerPosterMount.appendChild(card);
  }

  setPosterNavDisabled(playerPosterPrevBtn, i <= 0);
  setPosterNavDisabled(playerPosterNextBtn, i >= order.length - 1);

  playerPosterOverlay.classList.remove("hidden");
}

function stepPlayerPoster(dir) {
  const order =
    Array.isArray(playerPosterOrder) && playerPosterOrder.length
      ? playerPosterOrder
      : Array.isArray(latestPlayers)
        ? latestPlayers.map((p) => p.id)
        : [];

  if (!order.length) return;

  const cur = Number.isFinite(Number(playerPosterIndex)) ? Number(playerPosterIndex) : 0;
  const next = clampInt(cur + dir, 0, order.length - 1);
  if (next === cur) return;

  renderPlayerPosterByIndex(next);
}

function openPlayerPoster(playerId) {
  const order =
    Array.isArray(playerPosterOrder) && playerPosterOrder.length
      ? playerPosterOrder
      : Array.isArray(latestPlayers)
        ? latestPlayers.map((p) => p.id)
        : [];

  if (!order.length) return;

  const idx = order.indexOf(playerId);
  renderPlayerPosterByIndex(idx >= 0 ? idx : 0);
}

if (playerPosterPrevBtn) {
  playerPosterPrevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPlayerPoster(-1);
  });
}
if (playerPosterNextBtn) {
  playerPosterNextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPlayerPoster(1);
  });
}


// NEW: Finalize pending reveal safely (transaction) + resolve after reveal
async function finalizePendingRevealIfDue(force = false) {
  if (!gameRef) return { didReveal: false };
  const now = Date.now();

  try {
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) return { didReveal: false };

      const g = snap.data();
      if (g.phase !== "REVEAL" || !g.currentEventId) return { didReveal: false };

      const pr = g.pendingReveal;
      if (!pr || pr.eventId !== g.currentEventId) return { didReveal: false };
      if (pr.revealed === true) return { didReveal: false };

      const revealAt = Number(pr.revealAtMs || 0);
      if (!force && revealAt > now) return { didReveal: false };

      const track = g.eventTrack || [];
      const revealed = Array.isArray(g.eventRevealed)
        ? [...g.eventRevealed]
        : track.map(() => false);

      const pos = Number.isFinite(pr.pos) ? pr.pos : null;
      if (pos != null && pos >= 0 && pos < revealed.length) revealed[pos] = true;

      tx.update(gameRef, {
        eventRevealed: revealed,
        pendingReveal: { ...pr, revealed: true, revealedAtMs: now },
      });

      return { didReveal: true, eventId: pr.eventId };
    });

    if (result?.didReveal) {
      // ✅ pas NA echte onthulling: resolve
      try {
        await resolveAfterReveal(gameId);
      } catch (err) {
        console.error("resolveAfterReveal fout:", err);
      }
    }

    return result || { didReveal: false };
  } catch (err) {
    console.error("finalizePendingRevealIfDue fout:", err);
    return { didReveal: false };
  }
}

async function revealNowIfPending() {
  return finalizePendingRevealIfDue(true);
}

// ===============================
// QR join
// ===============================
function getJoinUrl(game) {
  if (!game || !game.code) return null;
  const url = new URL("index.html", window.location.href);
  url.searchParams.set("code", game.code);
  return url.toString();
}

function renderJoinQr(game) {
  if (!qrJoinContainer || !qrJoinLabel) return;
  if (typeof QRCode === "undefined") return;
  if (!game || !game.code) return;

  const joinUrl = getJoinUrl(game);
  if (!joinUrl) return;

  qrJoinLabel.textContent = `Scan om te joinen: ${game.code}`;
  qrJoinContainer.innerHTML = "";

  if (!qrInstance) {
    qrInstance = new QRCode(qrJoinContainer, {
      text: joinUrl,
      width: 256,
      height: 256,
    });
  } else {
    qrInstance.clear();
    qrInstance.makeCode(joinUrl);
  }
}

function openQrOverlay() {
  if (!qrJoinOverlay) return;
  qrJoinOverlay.classList.add("is-open");
}
function closeQrOverlay() {
  if (!qrJoinOverlay) return;
  qrJoinOverlay.classList.remove("is-open");
}

if (qrJoinToggleBtn && qrJoinOverlay) qrJoinToggleBtn.addEventListener("click", openQrOverlay);
if (qrJoinCloseBtn && qrJoinOverlay) qrJoinCloseBtn.addEventListener("click", closeQrOverlay);

// ===============================
// Score overlay show/hide
// ===============================
function openScoreOverlay() {
  if (!scoreOverlay) return;
  if (latestGame) renderFinalScoreboard(latestGame);
  scoreOverlay.classList.remove("hidden");
}
function closeScoreOverlay() {
  if (!scoreOverlay) return;
  scoreOverlay.classList.add("hidden");
}
if (showScoreboardBtn && scoreOverlay) showScoreboardBtn.addEventListener("click", openScoreOverlay);
if (scoreOverlayCloseBtn && scoreOverlay) scoreOverlayCloseBtn.addEventListener("click", closeScoreOverlay);

// ===============================
// Deck builders
// ===============================

// Event track: 12 kaarten
// - pos0 = SHEEPDOG_PATROL (veilig start)
// - 1x DOG_CHARGE in eerste helft
// - 1x (SECOND_CHARGE of PAINT_BOMB_NEST) in tweede helft
// - 1x (MAGPIE_SNITCH of SILENT_ALARM) in de pool
function buildEventTrack() {
  const SAFE_FIRST_EVENT = "SHEEPDOG_PATROL";

  const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ✅ Variants (later makkelijk uitbreiden)
  const leadPenalty = pickOne(["MAGPIE_SNITCH", "SILENT_ALARM"]);
  const secondHalfBig = pickOne(["SECOND_CHARGE", "PAINT_BOMB_NEST"]);

  // Pool moet exact 9 kaarten zijn (want 12 totaal, 3 vaste slots)
  // NB: GATE_TOLL is eruit gehaald om ruimte te maken voor leadPenalty.
  const others = [
    "DEN_RED",
    "DEN_BLUE",
    "DEN_GREEN",
    "DEN_YELLOW",
    "HIDDEN_NEST",
    leadPenalty,
    "ROOSTER_CROW",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
  ];

  const pool = shuffleArray(others);

  const track = new Array(12).fill(null);
  track[0] = SAFE_FIRST_EVENT;

  const firstHalfSlots = [1, 2, 3, 4, 5];
  const secondHalfSlots = [6, 7, 8, 9, 10, 11];

  const dogIndex = firstHalfSlots[Math.floor(Math.random() * firstHalfSlots.length)];
  const secondIndex = secondHalfSlots[Math.floor(Math.random() * secondHalfSlots.length)];

  track[dogIndex] = "DOG_CHARGE";
  track[secondIndex] = secondHalfBig;

  let pIdx = 0;
  for (let i = 0; i < track.length; i++) {
    if (track[i] !== null) continue;
    track[i] = pool[pIdx++];
  }
  return track;
}

// Action deck (zonder countermove)
function buildActionDeck() {
  const defs = [
    { name: "Molting Mask", count: 4 },
    { name: "Scent Check", count: 3 },
    { name: "Follow the Tail", count: 3 },
    { name: "Scatter!", count: 3 },
    { name: "Den Signal", count: 3 },
    { name: "Alpha Call", count: 3 },
    { name: "No-Go Zone", count: 2 },
    { name: "Hold Still", count: 2 },
    { name: "Kick Up Dust", count: 3 },
    { name: "Pack Tinker", count: 3 },
    { name: "Mask Swap", count: 2 },
    { name: "Nose for Trouble", count: 3 },
    { name: "Burrow Beacon", count: 2 },
  ];
  const deck = [];
  defs.forEach((def) => {
    for (let i = 0; i < def.count; i++) deck.push({ name: def.name });
  });
  return shuffleArray(deck);
}

function buildLootDeck() {
  const deck = [];
  for (let i = 0; i < 20; i++) deck.push({ t: "Egg", v: 1 });
  for (let i = 0; i < 10; i++) deck.push({ t: "Hen", v: 2 });
  for (let i = 0; i < 6; i++) deck.push({ t: "Prize Hen", v: 3 });
  return shuffleArray(deck);
}

// ===============================
// Rendering – Event Track & Status Cards
// ===============================
function renderEventTrack(game) {
  if (!eventTrackDiv) return;

  const track = game.eventTrack || [];
  const revealed = game.eventRevealed || [];
  const currentId = game.currentEventId || null;
  const pending = game.pendingReveal || null;

  eventTrackDiv.innerHTML = "";

  if (!track.length) {
    const p = document.createElement("p");
    p.textContent = game.raidStarted ? "Geen Event Track gevonden." : "Nog geen raid gestart.";
    p.className = "event-track-status";
    eventTrackDiv.appendChild(p);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "event-track-grid";

  track.forEach((eventId, i) => {
    const ev = getEventById(eventId);
    const isRevealed = !!revealed[i];

    // ✅ suspense: pending slot telt als "current", maar blijft BACK tot revealed=true
    const isPendingHere =
      game.phase === "REVEAL" &&
      pending &&
      pending.eventId === eventId &&
      Number.isFinite(pending.pos) &&
      pending.pos === i &&
      pending.revealed !== true;

    let state = "future";
    if (isRevealed) {
      if (currentId && eventId === currentId) state = "current";
      else state = "past";
    } else if (isPendingHere) {
      state = "current";
    }

    const slot = document.createElement("div");
    slot.classList.add("event-slot", `event-state-${state}`);

    let imgUrl = CARD_BACK_UI;
    if (isRevealed && ev && ev.imageFront) imgUrl = ev.imageFront;
    slot.style.background = `url(${imgUrl}) center / cover no-repeat`;

    const idx = document.createElement("div");
    idx.className = "event-slot-index";
    idx.textContent = i + 1;
    slot.appendChild(idx);

    slot.addEventListener("click", () => {
      if (!isRevealed) return;
      openEventPoster(eventId);
    });

    grid.appendChild(slot);
  });

  eventTrackDiv.appendChild(grid);
}

function renderStatusCards(game) {
  if (phaseCard) {
    const phase = game.phase || "–";
    phaseCard.innerHTML = `
      <div class="card-title">Phase</div>
      <div class="card-value">${phase}</div>
      <div class="card-sub">MOVE / ACTIONS / DECISION / REVEAL / END</div>
    `;
  }

  if (leadFoxCard) {
    const name = currentLeadFoxName || "–";
    leadFoxCard.innerHTML = `
      <div class="card-title">Lead Fox</div>
      <div class="card-value">${name}</div>
      <div class="card-sub">Start speler voor deze ronde</div>
    `;
  }

  if (roosterCard) {
    const roosterSeenRaw = game.roosterSeen || 0;
    const stateIndex = Math.max(0, Math.min(roosterSeenRaw, 3));

    roosterCard.innerHTML = "";
    roosterCard.classList.remove("rooster-state-0", "rooster-state-1", "rooster-state-2", "rooster-state-3");
    roosterCard.classList.add(`rooster-state-${stateIndex}`);
  }

  const flags = game.flagsRound || {};

  if (beaconCard) {
    const on = !!flags.lockEvents;
    beaconCard.innerHTML = "";
    beaconCard.classList.remove("beacon-on", "beacon-off", "card-status-on");
    beaconCard.classList.add(on ? "beacon-on" : "beacon-off");
  }

  if (scatterCard) {
    const on = !!flags.scatter;
    scatterCard.innerHTML = "";
    scatterCard.classList.remove("scatter-on", "scatter-off", "card-status-on");
    scatterCard.classList.add(on ? "scatter-on" : "scatter-off");
  }

  if (sackCard) {
    const sack = Array.isArray(game.sack) ? game.sack : [];
    const count = sack.length;

    sackCard.innerHTML = "";
    sackCard.classList.remove("sack-empty", "sack-half", "sack-full");

    let stateClass = "sack-empty";
    if (count <= 4) stateClass = "sack-empty";
    else if (count <= 8) stateClass = "sack-half";
    else stateClass = "sack-full";

    sackCard.classList.add(stateClass);
  }

  if (lootDeckCard) {
    const lootDeck = Array.isArray(game.lootDeck) ? game.lootDeck : [];
    lootDeckCard.innerHTML = `
      <div class="card-title">Loot Deck</div>
      <div class="card-value">${lootDeck.length}</div>
    `;
  }

  if (actionDeckCard) {
    const actionDeck = Array.isArray(game.actionDeck) ? game.actionDeck : [];
    actionDeckCard.innerHTML = `
      <div class="card-title">Action Deck</div>
      <div class="card-value">${actionDeck.length}</div>
    `;
  }
  if (actionDiscardCard) actionDiscardCard.innerHTML = "";
}

// ====================================
//  Rendering Action Deck Discard Pile
// ====================================

function renderActionDeckAndDiscard(game) {
  // action deck: gewoon de achterkant (of laat zoals jij het al doet)
  if (actionDeckCard) {
    actionDeckCard.style.backgroundImage = `url('${CARD_BACK}')`;
  }

  if (!actionDiscardCard) return;

const discard =
  Array.isArray(game?.actionDiscardPile) ? game.actionDiscardPile :
  Array.isArray(game?.actionDiscard) ? game.actionDiscard :
  [];
  const top = discard.length ? discard[discard.length - 1] : null;

  if (!top) {
    // leeg: placeholder (CSS doet dit ook, maar zo is het expliciet)
    actionDiscardCard.style.backgroundImage =
      "url('./assets/card_discard_pile.png')";
    return;
  }

  // top kan string zijn, of object {name}/{id}
  const key = String(top?.name || top?.id || top || "").trim();
  const def = getActionDefByName(key);

  const img = def?.imageFront || CARD_BACK;
  actionDiscardCard.style.backgroundImage = `url('${img}')`;
}

// ===============================
// Scoreboard + leaderboards
// ===============================
// (ongewijzigd — jouw bestaande code blijft intact)
function calcLeaderboardScore(data) {
  if (!data) return 0;
  const eggs = Number(data.eggs || 0);
  const hens = Number(data.hens || 0);
  const prize = Number(data.prize || 0);
  const bonus = Number(data.bonus || 0);
  const baseFromCounts = eggs + hens * 2 + prize * 3;
  const stored = Number(data.score || 0);
  return Math.max(stored, baseFromCounts + bonus);
}

function appendLeaderboardRow(listEl, rank, data) {
  const eggs = data.eggs || 0;
  const hens = data.hens || 0;
  const prize = data.prize || 0;
  const bonus = data.bonus || 0;
  const score = calcLeaderboardScore(data);
  if (score <= 0) return;

  let dateLabel = "";
  if (data.playedAt && data.playedAt.seconds != null) {
    const d = new Date(data.playedAt.seconds * 1000);
    dateLabel = d.toLocaleDateString();
  }

  const li = document.createElement("li");
  li.className = "leaderboard-item";
  li.innerHTML = `
    <div class="leaderboard-item-main">
      <span>${rank}. ${data.name || "Fox"}</span>
      <span class="leaderboard-item-loot">E:${eggs} H:${hens} P:${prize} +${bonus}</span>
    </div>
    <div class="leaderboard-item-meta">
      <div>${score} pts</div>
      <div class="leaderboard-item-date">${dateLabel}</div>
    </div>
  `;
  listEl.appendChild(li);
}

async function fillLeaderboardAllTime(listEl) {
  const leaderboardCol = collection(db, "leaderboard");
  const qAll = query(leaderboardCol, orderBy("score", "desc"), limit(100));
  const snap = await getDocs(qAll);

  if (snap.empty) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Nog geen scores.";
    listEl.appendChild(li);
    return;
  }

  let docsArr = [];
  snap.forEach((docSnap) => docsArr.push(docSnap.data()));

  docsArr = docsArr.filter((d) => calcLeaderboardScore(d) > 0);
  docsArr.sort((a, b) => calcLeaderboardScore(b) - calcLeaderboardScore(a));

  let rank = 1;
  docsArr.forEach((data) => appendLeaderboardRow(listEl, rank++, data));
}

async function fillLeaderboardToday(listEl) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const leaderboardCol = collection(db, "leaderboard");
  const qToday = query(
    leaderboardCol,
    where("playedAt", ">=", todayStart),
    orderBy("playedAt", "desc"),
    limit(200)
  );

  const snap = await getDocs(qToday);

  if (snap.empty) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Nog geen scores voor vandaag.";
    listEl.appendChild(li);
    return;
  }

  let docsArr = [];
  snap.forEach((docSnap) => docsArr.push(docSnap.data()));

  docsArr = docsArr.filter((d) => calcLeaderboardScore(d) > 0);
  docsArr.sort((a, b) => calcLeaderboardScore(b) - calcLeaderboardScore(a));

  const top = docsArr.slice(0, 10);
  top.forEach((data, idx) => appendLeaderboardRow(listEl, idx + 1, data));
}

async function fillLeaderboardMonth(listEl) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const leaderboardCol = collection(db, "leaderboard");
  const qMonth = query(
    leaderboardCol,
    where("playedAt", ">=", monthStart),
    orderBy("playedAt", "desc"),
    limit(500)
  );

  const snap = await getDocs(qMonth);

  if (snap.empty) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Nog geen scores voor deze maand.";
    listEl.appendChild(li);
    return;
  }

  let docsArr = [];
  snap.forEach((docSnap) => docsArr.push(docSnap.data()));

  docsArr = docsArr.filter((d) => calcLeaderboardScore(d) > 0);
  docsArr.sort((a, b) => calcLeaderboardScore(b) - calcLeaderboardScore(a));

  const top = docsArr.slice(0, 25);
  top.forEach((data, idx) => appendLeaderboardRow(listEl, idx + 1, data));
}

async function loadLeaderboardsMulti(rootEl) {
  const listToday = rootEl.querySelector("#leaderboardToday");
  const listMonth = rootEl.querySelector("#leaderboardMonth");
  const listAllTime = rootEl.querySelector("#leaderboardAllTime");
  if (!listToday || !listMonth || !listAllTime) return;

  listToday.innerHTML = "";
  listMonth.innerHTML = "";
  listAllTime.innerHTML = "";

  try {
    await Promise.all([
      fillLeaderboardToday(listToday),
      fillLeaderboardMonth(listMonth),
      fillLeaderboardAllTime(listAllTime),
    ]);
  } catch (err) {
    console.error("Fout bij laden leaderboards:", err);
  }
}

async function renderFinalScoreboard(game) {
  if (!roundInfo) return;

  const players = [...latestPlayers];
  latestPlayersCacheForScoreboard = players;

  if (!players.length) {
    const msg = "Geen spelers gevonden voor het scorebord.";
    roundInfo.textContent = msg;
    if (scoreOverlayContent) scoreOverlayContent.textContent = msg;
    return;
  }

  const enriched = players.map((p) => {
    const eggs = p.eggs || 0;
    const hens = p.hens || 0;
    const prize = p.prize || 0;

    const baseScore = eggs + hens * 2 + prize * 3;
    const storedScore = typeof p.score === "number" ? p.score : baseScore;
    const bonus = Math.max(0, storedScore - baseScore);

    return { ...p, eggs, hens, prize, baseScore, totalScore: storedScore, bonus };
  });

  enriched.sort((a, b) => b.totalScore - a.totalScore);

  const bestScore = enriched.length ? enriched[0].totalScore : 0;
  const winners = enriched.filter((p) => p.totalScore === bestScore);
  const winnerIds = new Set(winners.map((w) => w.id));

  roundInfo.innerHTML = "";

  const section = document.createElement("div");
  section.className = "scoreboard-section";

  const h2 = document.createElement("h2");
  h2.textContent = "Eindscore – Fox Raid";
  section.appendChild(h2);

  const pIntro = document.createElement("p");
  pIntro.textContent = "Het spel is afgelopen. Dit is de eindranglijst (Eieren, Kippen, Prize Kippen en Bonus):";
  pIntro.className = "scoreboard-intro";
  section.appendChild(pIntro);

  if (winners.length && bestScore >= 0) {
    const pWin = document.createElement("p");
    const names = winners.map((w) => w.name || "Vos").join(", ");
    pWin.textContent = `🏆 Winnaar(s): ${names} met ${bestScore} punten.`;
    pWin.className = "scoreboard-winners";
    section.appendChild(pWin);
  }

  const table = document.createElement("table");
  table.className = "scoreboard-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Fox</th>
        <th>E</th>
        <th>H</th>
        <th>P</th>
        <th>Bonus</th>
        <th>Totaal</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");

  enriched.forEach((p, idx) => {
    const tr = document.createElement("tr");
    if (winnerIds.has(p.id)) tr.classList.add("scoreboard-row-winner");

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${p.name || "Vos"}</td>
      <td>${p.eggs}</td>
      <td>${p.hens}</td>
      <td>${p.prize}</td>
      <td>${p.bonus}</td>
      <td>${p.totalScore}</td>
    `;
    tbody.appendChild(tr);
  });

  section.appendChild(table);

  const leaderboardSection = document.createElement("div");
  leaderboardSection.className = "leaderboard-section-multi";
  leaderboardSection.innerHTML = `
    <h3 class="leaderboard-main-title">Leaderboards</h3>
    <div class="leaderboard-grid">
      <div class="leaderboard-block">
        <div class="leaderboard-title">Top 10 – Vandaag</div>
        <ul class="leaderboard-list" id="leaderboardToday"></ul>
      </div>
      <div class="leaderboard-block">
        <div class="leaderboard-title">Top 25 – Deze maand</div>
        <ul class="leaderboard-list" id="leaderboardMonth"></ul>
      </div>
      <div class="leaderboard-block">
        <div class="leaderboard-title">Top 100 – All-time</div>
        <ul class="leaderboard-list" id="leaderboardAllTime"></ul>
      </div>
    </div>
  `;

  section.appendChild(leaderboardSection);
  roundInfo.appendChild(section);

  await loadLeaderboardsMulti(section);

  if (scoreOverlayContent) {
    const clone = section.cloneNode(true);
    scoreOverlayContent.innerHTML = "";
    scoreOverlayContent.appendChild(clone);
    await loadLeaderboardsMulti(scoreOverlayContent);
  }
}

// ===============================
// INIT RAID (eerste keer)
// ===============================
async function initRaidIfNeeded(gameRefParam) {
  const snap = await getDoc(gameRefParam);
  if (!snap.exists()) return null;
  const game = snap.data();
  if (game.raidStarted) return game;

  const playersCol = collection(db, "games", gameId, "players");
  const playersSnap = await getDocs(playersCol);
  const players = [];
  playersSnap.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));

  if (!players.length) {
    alert("Geen spelers gevonden. Laat eerst spelers joinen voordat je de raid start.");
    return game;
  }

  const sorted = [...players].sort((a, b) => {
    const aSec = a.joinedAt && a.joinedAt.seconds ? a.joinedAt.seconds : 0;
    const bSec = b.joinedAt && b.joinedAt.seconds ? b.joinedAt.seconds : 0;
    return aSec - bSec;
  });

  let actionDeck = buildActionDeck();
  const lootDeck = buildLootDeck();
  const eventTrack = buildEventTrack();
  const eventRevealed = eventTrack.map(() => false);

  const flagsRound = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: false,
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
    holdStill: {},
  };

  const colorOffset = Math.floor(Math.random() * DEN_COLORS.length);
  const updates = [];

  sorted.forEach((p, index) => {
    const color = DEN_COLORS[(index + colorOffset) % DEN_COLORS.length];
    const hand = [];
    for (let k = 0; k < 3; k++) if (actionDeck.length) hand.push(actionDeck.pop());

    const pref = doc(db, "games", gameId, "players", p.id);
    updates.push(
      updateDoc(pref, {
        joinOrder: index,
        color,
        den: color,
        inYard: true,
        dashed: false,
        burrowUsed: false,
        decision: null,
        hand,
        loot: [],
        opsActionPlayedRound: null,
      })
    );
  });

  const sack = [];
  if (lootDeck.length) sack.push(lootDeck.pop());

  const leadIndex = Math.floor(Math.random() * sorted.length);
  const botsEnabled = game.botsEnabled === true;

  updates.push(
    updateDoc(gameRefParam, {
      status: "raid",
      phase: "MOVE",
      round: 0,
      currentEventId: null,
      eventTrack,
      eventRevealed,
      eventIndex: 0,
      roosterSeen: 0,
      raidEndedByRooster: false,
      raidStarted: true,
      botsEnabled,
      actionDeck,
      lootDeck,
      sack,
      flagsRound,
      scatterArmed: false,
      opsCount: {},
      leadIndex,
      movedPlayerIds: [],
      opsTurnOrder: [],
      opsTurnIndex: 0,
      opsConsecutivePasses: 0,
      actionDiscard: [],
      actionDiscardPile: [],
      raidPaused: false,    // ✅ nieuw
      pendingReveal: null,  // ✅ nieuw
    })
  );

  await Promise.all(updates);

  await addLog(gameId, {
    round: 0,
    phase: "MOVE",
    kind: "SYSTEM",
    message: "Nieuwe raid gestart. Lead Fox: " + (sorted[leadIndex]?.name || ""),
  });

  const newSnap = await getDoc(gameRefParam);
  return newSnap.exists() ? newSnap.data() : null;
}

// ===============================
// Spelers zones renderen
// ===============================
function renderPlayerZones() {
  if (!yardZone || !caughtZone || !dashZone) return;

  const players = [...latestPlayers];

  const caughtLabel = caughtZone.querySelector(".player-zone-label");
  const dashLabel = dashZone.querySelector(".player-zone-label");

  yardZone.innerHTML = "";
  caughtZone.innerHTML = "";
  dashZone.innerHTML = "";

  if (caughtLabel) caughtZone.appendChild(caughtLabel);
  if (dashLabel) dashZone.appendChild(dashLabel);

  if (!players.length) return;

  const ordered = [...players].sort((a, b) => {
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  // poster carousel order (join order)
  playerPosterOrder = ordered.map((p) => p.id);

  const activeOrdered = ordered.filter(isInYardLocal);
  const baseList = activeOrdered.length ? activeOrdered : [];

  let leadIdx = latestGame && typeof latestGame.leadIndex === "number" ? latestGame.leadIndex : 0;
  if (leadIdx < 0) leadIdx = 0;
  if (baseList.length) leadIdx = leadIdx % baseList.length;

  currentLeadFoxId = null;
  currentLeadFoxName = "";

  if (baseList.length) {
    const lf = baseList[leadIdx];
    if (lf) {
      currentLeadFoxId = lf.id;
      currentLeadFoxName = lf.name || "";
    }
  }

  if (latestGame) renderStatusCards(latestGame);

  ordered.forEach((p) => {
    let zoneType = "yard";

    if (latestGame && latestGame.raidEndedByRooster) {
      zoneType = p.dashed ? "dash" : "caught";
    } else {
      zoneType = p.dashed ? "dash" : p.inYard === false ? "caught" : "yard";
    }

    const isLead = currentLeadFoxId && p.id === currentLeadFoxId;
    const footerBase = zoneType === "yard" ? "IN YARD" : zoneType === "dash" ? "DASHED" : "CAUGHT";

    const card = renderPlayerSlotCard(p, { size: "medium", footer: footerBase, isLead });
    if (!card) return;

    // click => grote player poster
    card.classList.add("player-card-clickable");
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlayerPoster(p.id);
    });

    if (zoneType === "yard") yardZone.appendChild(card);
    else if (zoneType === "dash") dashZone.appendChild(card);
    else caughtZone.appendChild(card);
  });

  if (latestGame && isGameFinished(latestGame)) {
    renderFinalScoreboard(latestGame);
  }
}

// ===============================
// NEW RAID (board)
// ===============================
function generateCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

async function startNewRaidFromBoard() {
  try {
    const code = generateCode();

    const gameRefLocal = await addDoc(collection(db, "games"), {
      code,
      actionDiscard: [],
      actionDiscardPile: [],
      status: "lobby",
      phase: "MOVE",
      round: 0,
      currentEventId: null,
      createdAt: serverTimestamp(),
      hostUid: null,
      raidStarted: false,
      raidEndedByRooster: false,
      roosterSeen: 0,
      botsEnabled: true,
      raidPaused: false,    // ✅ nieuw
      pendingReveal: null,  // ✅ nieuw
    });

    const newGameId = gameRefLocal.id;
    gameId = newGameId;

    const url = new URL(window.location.href);
    url.searchParams.set("game", newGameId);
    url.searchParams.set("mode", "host");
    window.location.href = url.toString();
  } catch (err) {
    console.error("Fout bij Start nieuwe Raid:", err);
    alert("Er ging iets mis bij het starten van een nieuwe Raid.");
  }
}
if (newRaidBtn) newRaidBtn.addEventListener("click", startNewRaidFromBoard);

// ===============================
// MAIN INIT
// ===============================
if (!gameId && gameInfo) {
  gameInfo.textContent = "Geen gameId in de URL";
}
// ==== PHASE SWITCHER (TOP-LEVEL, zodat auto-advance 'm kan zien) ====
const PHASE_BREATHER_MS = 5000;

// ✅ aparte naam (niet botsen met andere phaseWait helpers in je bestand)
async function scheduleBreatherWait({ from, to, ms, message, roundNumber }) {
  const nowMs = Date.now();
  const phaseWait = {
    kind: "BREATHER",
    from,
    to,
    createdAtMs: nowMs,
    executeAtMs: nowMs + ms,
  };

  await updateDoc(gameRef, { phaseWait });

  if (message) {
    await addLog(gameId, {
      round: roundNumber,
      phase: from,
      kind: "SYSTEM",
      message,
    });
  }
}

function getBreatherWaitState(game, from, to) {
  const w = game.phaseWait;
  if (!w) return { waiting: false, leftMs: 0 };
  if (w.kind !== "BREATHER") return { waiting: false, leftMs: 0 };
  if (w.from !== from) return { waiting: false, leftMs: 0 };
  if (to && w.to !== to) return { waiting: false, leftMs: 0 };

  const leftMs = Number(w.executeAtMs || 0) - Date.now();
  return { waiting: leftMs > 0, leftMs: Math.max(0, leftMs) };
}

async function handleNextPhase({ silent = false, force = false } = {}) {
  const snap = await getDoc(gameRef);
  if (!snap.exists()) return;
  const game = snap.data();

  const current = game.phase || "MOVE";
  const roundNumber = game.round || 0;

  if (game.status === "finished" || current === "END") {
    if (!silent) alert("Het spel is al afgelopen; er is geen volgende fase meer.");
    return;
  }
  if (!isActiveRaidStatus(game.status)) {
    if (!silent) alert("Er is geen actieve ronde in de raid.");
    return;
  }

  // MOVE -> ACTIONS
  if (current === "MOVE") {
    const active = latestPlayers.filter(isInYardForEvents);
    const mustMoveCount = active.length;
    const moved = game.movedPlayerIds || [];

    if (mustMoveCount > 0 && moved.length < mustMoveCount) {
      if (!silent) alert(`Niet alle vossen hebben hun MOVE gedaan (${moved.length}/${mustMoveCount}).`);
      return;
    }

    if (!active.length) {
      await updateDoc(gameRef, { phase: "DECISION", phaseWait: null });
      await addLog(gameId, {
        round: roundNumber,
        phase: "DECISION",
        kind: "SYSTEM",
        message: "Geen actieve vossen in de Yard na MOVE – OPS wordt overgeslagen. Door naar DECISION.",
      });
      return;
    }

    // ✅ 5s adempauze (tenzij force)
    if (!force) {
      const w = getBreatherWaitState(game, "MOVE", "ACTIONS");
      if (w.waiting) {
        if (!silent) alert(`OPS start over ${Math.ceil(w.leftMs / 1000)}s… (klik nogmaals om direct door te gaan)`);
        return;
      }
      if (!game.phaseWait || game.phaseWait.kind !== "BREATHER") {
        await scheduleBreatherWait({
          from: "MOVE",
          to: "ACTIONS",
          ms: PHASE_BREATHER_MS,
          message: "MOVE afgerond. OPS start over 5 seconden…",
          roundNumber,
        });
        return;
      }
    }

    const ordered = [...active].sort((a, b) => {
      const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

    const baseOrder = ordered.map((p) => p.id);

    let leadIndex = typeof game.leadIndex === "number" ? game.leadIndex : 0;
    if (leadIndex < 0 || leadIndex >= baseOrder.length) leadIndex = 0;

    const opsTurnOrder = [];
    for (let i = 0; i < baseOrder.length; i++) {
      opsTurnOrder.push(baseOrder[(leadIndex + i) % baseOrder.length]);
    }

   await updateDoc(gameRef, {
  phase: "ACTIONS",
  opsTurnOrder,
  opsTurnIndex: 0,
  opsConsecutivePasses: 0,
  opsActiveCount: opsTurnOrder.length,     // ✅ nieuw: hard target
  opsEndedAtMs: null,                      // ✅ optioneel
  flagsRound: { ...(game.flagsRound || {}), opsLocked: false }, // ✅ reset
  phaseWait: null,
});

    await addLog(gameId, {
      round: roundNumber,
      phase: "ACTIONS",
      kind: "SYSTEM",
      message: "OPS-fase gestart. Lead Fox begint met het spelen van Action Cards of PASS.",
    });
    return;
  }

  // ACTIONS -> DECISION
  if (current === "ACTIONS") {
    const active = latestPlayers.filter(isInYardForEvents);
    const activeCount = active.length;
    const passes = game.opsConsecutivePasses || 0;
    const opsLocked = !!game.flagsRound?.opsLocked;

    if (!opsLocked && activeCount > 0 && passes < activeCount) {
      if (!silent) alert(`OPS-fase is nog bezig: opeenvolgende PASSes: ${passes}/${activeCount}.`);
      return;
    }

    // ✅ 5s adempauze (tenzij force)
    if (!force) {
      const w = getBreatherWaitState(game, "ACTIONS", "DECISION");
      if (w.waiting) {
        if (!silent) alert(`DECISION start over ${Math.ceil(w.leftMs / 1000)}s… (klik nogmaals om direct door te gaan)`);
        return;
      }
      if (!game.phaseWait || game.phaseWait.kind !== "BREATHER") {
        await scheduleBreatherWait({
          from: "ACTIONS",
          to: "DECISION",
          ms: PHASE_BREATHER_MS,
          message: "OPS afgerond. DECISION start over 5 seconden…",
          roundNumber,
        });
        return;
      }
    }

    await updateDoc(gameRef, { phase: "DECISION", phaseWait: null });
    await addLog(gameId, {
      round: roundNumber,
      phase: "DECISION",
      kind: "SYSTEM",
      message: "Iedereen heeft na elkaar gepast in OPS – door naar DECISION-fase.",
    });
    return;
  }

  // DECISION -> REVEAL
  if (current === "DECISION") {
    const active = latestPlayers.filter(isInYardForEvents);
    const decided = active.filter((p) => !!p.decision).length;

    if (active.length > 0 && decided < active.length) {
      if (!silent) alert(`Niet alle vossen hebben een DECISION gekozen (${decided}/${active.length}).`);
      return;
    }

    const track = game.eventTrack || [];
    let eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;

    if (!track.length || eventIndex >= track.length) {
      if (!silent) alert("Er zijn geen events meer op de Track om te onthullen.");
      return;
    }

    const eventId = track[eventIndex];
    const ev = getEventById(eventId);

    const nowMs = Date.now();
    const pendingReveal = {
      eventId,
      pos: eventIndex,
      announcedAtMs: nowMs,
      revealAtMs: nowMs + REVEAL_COUNTDOWN_MS,
      revealed: false,
    };

    let newRoosterSeen = game.roosterSeen || 0;
    let raidEndedByRooster = game.raidEndedByRooster || false;

    const updatePayload = {
      phase: "REVEAL",
      currentEventId: eventId,
      eventIndex: eventIndex + 1,
      pendingReveal,
      phaseWait: null,
    };

    if (eventId === "ROOSTER_CROW") {
      newRoosterSeen += 1;
      updatePayload.roosterSeen = newRoosterSeen;
      if (newRoosterSeen >= 3) {
        raidEndedByRooster = true;
        updatePayload.raidEndedByRooster = true;
      }
    }

    await updateDoc(gameRef, updatePayload);

    await addLog(gameId, {
      round: roundNumber,
      phase: "REVEAL",
      kind: "EVENT",
      cardId: eventId,
      message: ev ? ev.title : eventId,
    });

    return;
  }

  // REVEAL = einde ronde
  if (current === "REVEAL") {
    if (!silent) alert("REVEAL is het einde van de ronde. Klik ‘Nieuwe ronde’ om verder te gaan.");
    return;
  }
}

initAuth(async (authUser) => {
  hostUid = authUser?.uid || null;

  if (!gameId || !gameRef || !playersColRef) return;

  // ✅ start bots (botRunner doet zelf: boardOnly guard + locks)
  if (typeof stopBots === "function") {
    stopBots();
    stopBots = null;
  }
  stopBots = startBotRunner({ db, gameId, addLog, isBoardOnly, hostUid });

  // ✅ BOT toevoegen knop blijft in host.js (alleen create bot-player)
  if (addBotBtn) {
    addBotBtn.addEventListener("click", async () => {
      try {
        await addBotToCurrentGame({ db, gameId, denColors: DEN_COLORS });
      } catch (err) {
        console.error("BOT toevoegen mislukt:", err);
        alert("BOT toevoegen mislukt.");
      }
    });
  }

  // ✅ Raid pauzeren / hervatten
  if (pauseRaidBtn) {
    pauseRaidBtn.addEventListener("click", async () => {
      try {
        const snap = await getDoc(gameRef);
        if (!snap.exists()) return;
        const g = snap.data();
        const next = !g.raidPaused;

        await updateDoc(gameRef, { raidPaused: next });

        await addLog(gameId, {
          round: g.round || 0,
          phase: g.phase || "MOVE",
          kind: "SYSTEM",
          message: next ? "Raid pauze-modus AAN (auto-next na 5s wanneer fase klaar is)." : "Raid pauze-modus UIT.",
        });
      } catch (err) {
        console.error("Raid pauze toggle fout:", err);
      }
    });
  }

  // ==== START ROUND ====
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      const game = await initRaidIfNeeded(gameRef);
      if (!game) return;

      if (game.status === "finished") {
        alert("Dit spel is al afgelopen. Start een nieuwe game als je opnieuw wilt spelen.");
        return;
      }
      if (game.raidEndedByRooster) {
        alert("De raid is geëindigd door de Rooster-limiet. Er kunnen geen nieuwe rondes meer gestart worden.");
        return;
      }

      const previousRound = game.round || 0;
      const newRound = previousRound + 1;

      const ordered = [...latestPlayers].sort((a, b) => {
        const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
        const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
        return ao - bo;
      });

      const activeOrdered = ordered.filter(isInYardLocal);
      const baseList = activeOrdered.length ? activeOrdered : [];

      let leadIndex = typeof game.leadIndex === "number" ? game.leadIndex : 0;

      if (baseList.length) {
        leadIndex = ((leadIndex % baseList.length) + baseList.length) % baseList.length;
        if (previousRound >= 1) leadIndex = (leadIndex + 1) % baseList.length;
      } else {
        leadIndex = 0;
      }

      let leadName = "";
      if (baseList.length) {
        const lf = baseList[leadIndex];
        if (lf) leadName = lf.name || "";
      }

      await updateDoc(gameRef, {
        status: "round",
        round: newRound,
        phase: "MOVE",
        currentEventId: null,
        movedPlayerIds: [],
        opsTurnOrder: [],
        opsTurnIndex: 0,
        opsConsecutivePasses: 0,
        flagsRound: {
          lockEvents: false,
          scatter: false,
          denImmune: {},
          noPeek: [],
          predictions: [],
          opsLocked: false,
          followTail: {},
          scentChecks: [],
          holdStill: {},
        },
        leadIndex,
        pendingReveal: null, // ✅ nieuw: reset
      });

      await addLog(gameId, {
        round: newRound,
        phase: "MOVE",
        kind: "SYSTEM",
        message: leadName ? `Ronde ${newRound} gestart. Lead Fox: ${leadName}.` : `Ronde ${newRound} gestart.`,
      });
    });
  }

  // ===============================
  // GAME SNAPSHOT
  // ===============================
  let finalizeRevealInFlight = false;

onSnapshot(gameRef, async (snap) => {
  if (!snap.exists()) {
    if (gameInfo) gameInfo.textContent = "Spel niet gevonden";
    return;
  }

  const game = snap.data();
  latestGame = { id: snap.id, ...game };

  currentRoundNumber = game.round || 0;
  currentPhase = game.phase || "MOVE";

  // stop bots zodra game klaar is
  if (isGameFinished(game) && typeof stopBots === "function") {
    stopBots();
    stopBots = null;
  }

  // ✅ suspense reveal auto-finalize als tijd voorbij is (voorkomt “stuck reveal”)
  if (
    game.phase === "REVEAL" &&
    game.pendingReveal &&
    game.pendingReveal.eventId === game.currentEventId &&
    game.pendingReveal.revealed !== true
  ) {
    const revealAt = Number(game.pendingReveal.revealAtMs || 0);
    if (revealAt > 0 && Date.now() >= revealAt && !finalizeRevealInFlight) {
      finalizeRevealInFlight = true;
      try {
        await finalizePendingRevealIfDue(false);
      } finally {
        finalizeRevealInFlight = false;
      }
    }
  }

  // Event poster flow (UI-key incl. revealed flag)
  if (game.phase === "REVEAL" && game.currentEventId) {
    const pr = game.pendingReveal;
    const revealedFlag =
      pr && pr.eventId === game.currentEventId ? (pr.revealed === true ? 1 : 0) : 1;
    const uiKey = `${game.currentEventId}|${revealedFlag}|${pr?.revealAtMs || 0}`;

    if (uiKey !== lastPosterUiKey) {
      lastPosterUiKey = uiKey;
      openEventPoster(game.currentEventId);
    }
  } else {
    lastPosterUiKey = null;
    stopRevealCountdown();
  }

  renderPlayerZones();

  if (startBtn) startBtn.disabled = game.status === "finished" || game.raidEndedByRooster === true;

  renderEventTrack(game);
  renderStatusCards(game);
  renderActionDeckAndDiscard(game);

  if (game.code) renderJoinQr(game);

  let extraStatus = "";
  if (game.raidEndedByRooster) extraStatus = " – Raid geëindigd door Rooster Crow (limiet bereikt)";
  if (game.status === "finished") extraStatus = extraStatus ? extraStatus + " – spel afgelopen." : " – spel afgelopen.";

  if (gameInfo) {
    gameInfo.textContent =
      `Code: ${game.code} – Status: ${game.status} – Ronde: ${currentRoundNumber} – Fase: ${currentPhase}${extraStatus}`;
  }

  // ✅ PhaseGate UI update + auto-advance
  const playersSafe = Array.isArray(latestPlayers) ? latestPlayers : [];
  const gate = computePhaseGate(game, playersSafe);
  applyNextPhaseUi(gate, game);
  maybeScheduleAutoAdvance(game, gate); // ⬅️ GEEN await

  if (isGameFinished(game)) {
    if (unsubActions) {
      unsubActions();
      unsubActions = null;
    }
    renderFinalScoreboard(game);
    return;
  }

  if (!isActiveRaidStatus(game.status)) {
    if (roundInfo) roundInfo.textContent = "Nog geen actieve ronde.";
    if (unsubActions) {
      unsubActions();
      unsubActions = null;
    }
    return;
  }

  // Per ronde acties tonen
  if (currentRoundForActions === currentRoundNumber && unsubActions) return;
  currentRoundForActions = currentRoundNumber;

  const event =
    game.currentEventId && game.phase === "REVEAL" ? getEventById(game.currentEventId) : null;

  const actionsCol = collection(db, "games", gameId, "actions");
  const actionsQuery = query(actionsCol, where("round", "==", currentRoundForActions));

  if (unsubActions) unsubActions();
  unsubActions = onSnapshot(actionsQuery, (snapActions) => {
    if (!roundInfo) return;
    roundInfo.innerHTML = "";

    const phaseLabel = currentPhase;

    if (event) {
      const h2 = document.createElement("h2");
      h2.textContent = `Ronde ${currentRoundForActions} – fase: ${phaseLabel}: ${event.title}`;
      const pText = document.createElement("p");
      pText.textContent = event.text;
      roundInfo.appendChild(h2);
      roundInfo.appendChild(pText);
    } else {
      const h2 = document.createElement("h2");
      h2.textContent = `Ronde ${currentRoundForActions} – fase: ${phaseLabel}`;
      roundInfo.appendChild(h2);
    }

    const count = snapActions.size;
    const p = document.createElement("p");
    p.textContent = `Registraties (moves/actions/decisions): ${count}`;
    roundInfo.appendChild(p);

    const list = document.createElement("div");
    list.className = "round-actions-list";
    snapActions.forEach((aDoc) => {
      const a = aDoc.data();
      const line = document.createElement("div");
      line.className = "round-action-line";
      line.textContent = `${a.playerName || a.playerId}: ${a.phase} – ${a.choice}`;
      list.appendChild(line);
    });
    roundInfo.appendChild(list);
  });
});
    
// ===============================
// PLAYERS SNAPSHOT
// ===============================
onSnapshot(playersColRef, (snapshot) => {
  const players = [];
  snapshot.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));
  latestPlayers = players;
  renderPlayerZones();

  // ✅ PhaseGate UI kan wijzigen als players update binnen dezelfde fase
  if (latestGame) {
    const gate = computePhaseGate(latestGame, latestPlayers);
    applyNextPhaseUi(gate, latestGame);
    // auto-advance check opnieuw (non-blocking)
    maybeScheduleAutoAdvance(latestGame, gate);
  }
});

  // ===============================
  // LOG PANEL (host-only)
  // ===============================
  if (!isBoardOnly) {
    const logCol = collection(db, "games", gameId, "log");
    const logQuery = query(logCol, orderBy("createdAt", "desc"), limit(10));

    function formatChoiceForDisplay(phase, rawChoice, payload) {
      const choice = String(rawChoice || "");
      const p = payload || {};

      if (phase === "DECISION" && choice.startsWith("DECISION_")) {
        const k = choice.slice("DECISION_".length);
        if (k === "LURK") return "DECISION: LURK";
        if (k === "BURROW") return "DECISION: BURROW";
        if (k === "DASH") return "DECISION: DASH";
        return `DECISION: ${k}`;
      }

      if (phase === "MOVE" && choice.startsWith("MOVE_")) {
        if (choice.includes("SNATCH")) return "MOVE: SNATCH";
        if (choice.includes("FORAGE")) return "MOVE: FORAGE";
        if (choice.includes("SCOUT_")) return `MOVE: SCOUT (pos ${choice.split("_").pop()})`;
        if (choice.includes("SHIFT_")) return `MOVE: SHIFT (${choice.split("SHIFT_")[1]})`;
        return `MOVE: ${choice.slice("MOVE_".length)}`;
      }

      if (phase === "ACTIONS" && choice.startsWith("ACTION_")) {
        const name = choice.slice("ACTION_".length);
        if (name === "PASS") return "ACTIONS: PASS";
        let extra = "";
        if (p.color) extra = ` (Den ${p.color})`;
        if (Number.isFinite(p.pos)) extra = ` (pos ${p.pos})`;
        if (Number.isFinite(p.pos1) && Number.isFinite(p.pos2)) extra = ` (${p.pos1}↔${p.pos2})`;
        return `ACTIONS: ${name}${extra}`;
      }

      return choice || "—";
    }

    function formatLogLine(e) {
      const round = e.round ?? "?";
      const phase = e.phase ?? "?";
      const who = e.playerName || e.actorName || "SYSTEEM";

      if (e.choice) {
        const nice = formatChoiceForDisplay(phase, e.choice, e.payload);
        return `[R${round} – ${phase}] ${who} • ${nice}`;
      }
      return `[R${round} – ${phase} – ${e.kind ?? "?"}] ${e.message ?? ""}`;
    }

    onSnapshot(logQuery, (snap) => {
      const entries = [];
      snap.forEach((docSnap) => entries.push(docSnap.data()));
      entries.reverse();

      if (!logPanel) return;
      logPanel.innerHTML = "";

      const inner = document.createElement("div");
      inner.className = "log-lines";

      entries.forEach((e) => {
        const div = document.createElement("div");
        div.className = "log-line";
        div.textContent = formatLogLine(e);
        inner.appendChild(div);
      });

      logPanel.appendChild(inner);
    });
  }
});

