// player.js – Vossenjacht Player App met tabs + pop-ups

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  collection,
  onSnapshot,
  addDoc,
  setDoc,
  serverTimestamp,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ============================
   FIREBASE CONFIG – ingevuld
   ============================ */

const firebaseConfig = {
  apiKey: "AIzaSyB_u6nKuM0JUv6lLksiAmExiEB3_wrCthA",
  authDomain: "vossenjacht-7b5b8.firebaseapp.com",
  projectId: "vossenjacht-7b5b8",
  storageBucket: "vossenjacht-7b5b8.firebasestorage.app",
  messagingSenderId: "562443901152",
  appId: "1:562443901152:web:b951cc10fb540bbae05885",
  measurementId: "G-Y2SWPY1QZE",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ============================
   DOM HELPERS
   ============================ */

const $ = (sel) => document.querySelector(sel);

const dom = {
  headerSubtitle: $("#headerSubtitle"),
  pillCode: $("#pillCode"),
  pillRound: $("#pillRound"),
  pillPhase: $("#pillPhase"),
  pillTurn: $("#pillTurn"),

  // tabs
  tabPanels: {
    rules: $("#tab-rules"),
    profile: $("#tab-profile"),
    play: $("#tab-play"),
    log: $("#tab-log"),
  },

  // tab buttons
  tabButtons: document.querySelectorAll(".tab-button"),

  // rules tab
  rulesFilter: $("#rulesFilter"),
  rulesCardsGrid: $("#rulesCardsGrid"),

  // profile tab
  myPlayerCardVisual: $("#myPlayerCardVisual"),
  myPlayerName: $("#myPlayerName"),
  myPlayerDen: $("#myPlayerDen"),
  myPlayerStatusBadge: $("#myPlayerStatusBadge"),
  myEggs: $("#myEggs"),
  myHens: $("#myHens"),
  myPrize: $("#myPrize"),
  myPoints: $("#myPoints"),
  myBurrow: $("#myBurrow"),
  myPlayerLabel: $("#myPlayerLabel"),
  myFlavourText: $("#myFlavourText"),
  scoreSummary: $("#scoreSummary"),
  otherPlayersList: $("#otherPlayersList"),
  otherPlayerDetail: $("#otherPlayerDetail"),
  noOtherPlayersMsg: $("#noOtherPlayersMsg"),

  // play tab
  turnIndicator: $("#turnIndicator"),
  turnHint: $("#turnHint"),
  myCardsList: $("#myCardsList"),
  selectedCardLabel: $("#selectedCardLabel"),
  btnPlayNext: $("#btnPlayNext"),
  botAdvice: $("#botAdvice"),

  // log tab
  logList: $("#logList"),

  // popup
  popupOverlay: $("#popupOverlay"),
  popupTitle: $("#popupTitle"),
  popupBody: $("#popupBody"),
  popupCloseBtn: $("#popupCloseBtn"),

  // feedback toast
  feedbackToast: $("#feedbackToast"),
  feedbackText: $("#feedbackText"),
};

/* ============================
   CARD DEFINITIES (encyclopedie)
   ============================ */

const LOOT_CARDS = [
  {
    id: "loot_egg",
    type: "loot",
    name: "Egg",
    short: "1 buitpunt.",
    detail: "Basisloot. Veilig, maar weinig punten.",
  },
  {
    id: "loot_hen",
    type: "loot",
    name: "Hen",
    short: "2 buitpunten.",
    detail: "Meer waard dan een Egg, maar ook aantrekkelijk voor snatch-events.",
  },
  {
    id: "loot_prize",
    type: "loot",
    name: "Prize Hen",
    short: "3 buitpunten.",
    detail: "Zeldzaam en waardevol. Jaag hierop als je durft.",
  },
];

const EVENT_CARDS = [
  {
    id: "event_den_red",
    type: "event",
    name: "Den – Red",
    short: "Vangt alle Red Den vossen in de Yard.",
    detail: "Behalve als ze BURROW of DASH kozen, of beschermd zijn door Den Signal.",
  },
  {
    id: "event_den_blue",
    type: "event",
    name: "Den – Blue",
    short: "Vangt alle Blue Den vossen in de Yard.",
    detail:
      "Let op: BURROW beschermt meestal, tenzij het event dit negeert.",
  },
  {
    id: "event_den_green",
    type: "event",
    name: "Den – Green",
    short: "Vangt alle Green Den vossen in de Yard.",
    detail: "Den Signal kan deze kleur beschermen in deze ronde.",
  },
  {
    id: "event_den_yellow",
    type: "event",
    name: "Den – Yellow",
    short: "Vangt alle Yellow Den vossen in de Yard.",
    detail: "DASHers zijn onderweg en worden niet gepakt.",
  },
  {
    id: "event_sheepdog_charge",
    type: "event",
    name: "Sheepdog Charge",
    short: "Schapendog stormt de Yard in.",
    detail: "Vangt meestal alle vossen in de Yard tenzij je goed beschermd bent.",
  },
  {
    id: "event_sheepdog_patrol",
    type: "event",
    name: "Sheepdog Patrol",
    short: "Patrouille door de Yard.",
    detail: "In sommige varianten pakt hij vooral Dashers of kwetsbare vossen.",
  },
  {
    id: "event_rooster_crow",
    type: "event",
    name: "Rooster Crow",
    short: "De haan kraait.",
    detail: "Bij de 3e kraai eindigt de raid.",
  },
  {
    id: "event_magpie_snitch",
    type: "event",
    name: "Magpie Snitch",
    short: "De ekster verraadt je.",
    detail:
      "Richt zich vaak op de Lead Fox, tenzij die slim geburrowed heeft.",
  },
  {
    id: "event_paint_bomb",
    type: "event",
    name: "Paint-Bomb Nest",
    short: "Nest ontploft met verf.",
    detail: "Alle buit uit de Sack gaat terug naar de Loot Deck en wordt geschud.",
  },
  {
    id: "event_hidden_nest",
    type: "event",
    name: "Hidden Nest",
    short: "Geheim nest met extra buit.",
    detail:
      "Als precies 1 vos DASH kiest, krijgt die 4 extra loot; bij 2+ Dashers niemand.",
  },
  {
    id: "event_gate_toll",
    type: "event",
    name: "Gate Toll",
    short: "Tol bij de poort.",
    detail: "Vossen in de Yard moeten loot betalen of worden gepakt.",
  },
];

const ACTION_CARDS = [
  {
    id: "act_scatter",
    type: "action",
    name: "Scatter!",
    short: "Niemand mag SCOUT gebruiken deze ronde.",
    detail: "Goed om informatie te blokkeren.",
  },
  {
    id: "act_den_signal",
    type: "action",
    name: "Den Signal",
    short: "Beschermt één Den-kleur tegen vang-events.",
    detail: "Red een kleur naar keuze in deze ronde.",
  },
  {
    id: "act_nogo",
    type: "action",
    name: "No-Go Zone",
    short: "Eén Event-positie kan niet gescout worden.",
    detail: "Zet een gebied op slot voor SCOUT.",
  },
  {
    id: "act_kick_up_dust",
    type: "action",
    name: "Kick Up Dust",
    short: "Wissel willekeurige Events.",
    detail:
      "Verstoort het Event spoor, tenzij een Burrow Beacon alles vastzet.",
  },
  {
    id: "act_burrow_beacon",
    type: "action",
    name: "Burrow Beacon",
    short: "Lockt de Event Track.",
    detail: "SHIFT en Pack Tinker werken deze ronde niet.",
  },
  {
    id: "act_molting_mask",
    type: "action",
    name: "Molting Mask",
    short: "Verander jouw Den-kleur willekeurig.",
    detail: "Handig als jouw Den binnenkort gevaar loopt.",
  },
  {
    id: "act_hold_still",
    type: "action",
    name: "Hold Still",
    short: "Sluit de ACTIONS-fase voor nieuwe kaarten.",
    detail:
      "Er mogen alleen nog Countermoves gespeeld worden, plus PASS.",
  },
  {
    id: "act_nose_trouble",
    type: "action",
    name: "Nose for Trouble",
    short: "Voorspel het volgende Event.",
    detail: "Bij een goede voorspelling kun je later beloning krijgen.",
  },
  {
    id: "act_scent_check",
    type: "action",
    name: "Scent Check",
    short: "Kijk naar de DECISION van één vos.",
    detail:
      "Je ziet (voor bevestiging) waar iemand voor kiest in de DECISION-fase.",
  },
  {
    id: "act_follow_tail",
    type: "action",
    name: "Follow the Tail",
    short: "Koppel jouw beslissing aan een andere vos.",
    detail: "Je DECISION volgt hun keuze. Sterk voor bondjes.",
  },
  {
    id: "act_alpha_call",
    type: "action",
    name: "Alpha Call",
    short: "Wijzig de Lead Fox.",
    detail: "Host-achtige actie: zet iemand anders in de spotlight.",
  },
  {
    id: "act_pack_tinker",
    type: "action",
    name: "Pack Tinker",
    short: "Wissel twee Events naar keuze.",
    detail: "Doelbewuste manipulatie van de Event Track.",
  },
  {
    id: "act_mask_swap",
    type: "action",
    name: "Mask Swap",
    short: "Shuffle alle Den-kleuren in de Yard.",
    detail: "Zorgt voor chaos in wie wanneer gepakt wordt.",
  },
  {
    id: "act_countermove",
    type: "action",
    name: "Countermove",
    short: "Reactieve kaart (placeholder).",
    detail:
      "Wordt later gebruikt voor coöperatieve tegenacties.",
  },
];

const ALL_CARDS = [...LOOT_CARDS, ...EVENT_CARDS, ...ACTION_CARDS];

/* ============================
   STATE
   ============================ */

const urlParams = new URLSearchParams(window.location.search);
const roomCode = (urlParams.get("code") || "DEMO").toUpperCase();

let roomRef = null;
let playerRef = null;
let playersCol = null;
let logsCol = null;

let currentRoom = null;
let currentPlayer = null;
let players = []; // alle spelers (incl. ikzelf)
let logs = [];

let playerId = null;
let activeTab = "rules"; // 'rules' | 'profile' | 'play' | 'log'
let cardsFilter = "all";

let selectedActionCardIndex = null;
let popupType = null; // 'MOVE' | 'DECISION' | 'PLAY_CARD'
let pendingDecisionChoice = null;
let lastMyTurn = false;
let isSending = false;

let unsubRoom = null;
let unsubPlayers = null;
let unsubPlayer = null;
let unsubLogs = null;

let feedbackTimeout = null;

/* ============================
   INIT
   ============================ */

document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
  dom.pillCode.textContent = `Code: ${roomCode}`;
  dom.headerSubtitle.textContent =
    "Voer je naam in om mee te spelen in deze raid.";

  // Player ID + naam
  const saved = loadLocalPlayer(roomCode);
  let name = saved?.name || null;
  let id = saved?.id || null;

  if (!name) {
    name = prompt("Je naam / fox alias:", "") || "Fox";
  }
  if (!id) {
    id = `p_${Math.random().toString(36).slice(2, 8)}`;
  }
  playerId = id;

  dom.headerSubtitle.textContent = `Je speelt als: ${name}`;

  // Room + player refs
  roomRef = doc(db, "vj_rooms", roomCode);
  playersCol = collection(roomRef, "players");
  logsCol = collection(roomRef, "logs");
  playerRef = doc(playersCol, playerId);

  // Room doc aanmaken/mergen
  await setDoc(
    roomRef,
    {
      code: roomCode,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  // Player doc aanmaken/mergen
  await setDoc(
    playerRef,
    {
      name,
      joinedAt: serverTimestamp(),
      status: "yard", // 'yard' | 'dashed' | 'caught'
    },
    { merge: true }
  );

  saveLocalPlayer(roomCode, { id, name });

  // Realtime listeners
  unsubRoom = onSnapshot(roomRef, (snap) => {
    currentRoom = snap.data() || null;
    renderRoom();
    checkTurnChange();
  });

  unsubPlayer = onSnapshot(playerRef, (snap) => {
    currentPlayer = snap.data() || null;
    renderPlayer();
    renderProfileTab();
    renderPlayTab();
    checkTurnChange();
  });

  unsubPlayers = onSnapshot(playersCol, (snap) => {
    players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderProfileTab();
  });

  try {
    const q = query(logsCol, orderBy("createdAt", "asc"));
    unsubLogs = onSnapshot(q, (snap) => {
      logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderLogTab();
    });
  } catch (e) {
    console.warn("Log query niet beschikbaar", e);
  }

  // UI binds
  bindTabs();
  bindRulesFilter();
  bindPlayControls();
  bindPopupControls();

  // init encyclopedie
  renderRulesCards();

  setFeedback("Verbonden. Wacht op start van het spel.");
}

/* ============================
   LOCAL STORAGE
   ============================ */

function loadLocalPlayer(code) {
  try {
    const raw = localStorage.getItem(`vj_player_${code}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLocalPlayer(code, obj) {
  try {
    localStorage.setItem(`vj_player_${code}`, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

/* ============================
   RENDER ROOM + TURN INFO
   ============================ */

function renderRoom() {
  const r = currentRoom;
  if (!r) {
    dom.pillRound.textContent = "Ronde: —";
    dom.pillPhase.textContent = "Fase: —";
    return;
  }

  const round = r.roundNumber ?? r.round ?? "—";
  const phaseKey = r.phase || "lobby";
  const phaseLabel = phaseKeyToLabel(phaseKey);

  dom.pillRound.textContent = `Ronde: ${round}`;
  dom.pillPhase.textContent = `Fase: ${phaseLabel}`;

  const leadName = r.leadName || r.leadDisplay || r.leadPlayerName || "—";
  // we zetten leadName in profile-tab, niet in header
}

function phaseKeyToLabel(phase) {
  switch (phase) {
    case "move_all":
      return "MOVE";
    case "ops":
      return "ACTIONS";
    case "decide":
      return "DECISION";
    case "reveal":
      return "REVEAL";
    case "end":
      return "EIND";
    default:
      return "Lobby";
  }
}

/* ============================
   RENDER PLAYER + PROFILE TAB
   ============================ */

function renderPlayer() {
  const p = currentPlayer;
  if (!p) return;

  dom.myPlayerName.textContent = p.name || "—";
  dom.myPlayerLabel.textContent = p.name || "—";

  const den = p.denColor || p.den || "None";
  dom.myPlayerDen.textContent = `Den: ${den}`;
  updateDenDot(dom.myPlayerCardVisual, den);

  // status badge
  const status = p.status || "yard";
  dom.myPlayerStatusBadge.textContent = `Status: ${status}`;
  dom.myPlayerStatusBadge.classList.remove(
    "badge-status-yard",
    "badge-status-dashed",
    "badge-status-caught"
  );
  if (status === "yard") dom.myPlayerStatusBadge.classList.add("badge-status-yard");
  else if (status === "dashed")
    dom.myPlayerStatusBadge.classList.add("badge-status-dashed");
  else if (status === "caught")
    dom.myPlayerStatusBadge.classList.add("badge-status-caught");

  // loot
  let eggs = p.lootEggs ?? p.eggs ?? 0;
  let hens = p.lootHens ?? p.hens ?? 0;
  let prize = p.lootPrize ?? p.prize ?? 0;
  let points = p.lootPoints ?? p.points ?? null;

  if (!points && Array.isArray(p.loot)) {
    eggs = p.loot.filter((l) => l.t === "Egg").length;
    hens = p.loot.filter((l) => l.t === "Hen").length;
    prize = p.loot.filter(
      (l) => l.t === "Prize Hen" || l.t === "Prize"
    ).length;
    points = p.loot.reduce((sum, l) => sum + (l.v || 0), 0);
  }

  dom.myEggs.textContent = eggs ?? 0;
  dom.myHens.textContent = hens ?? 0;
  dom.myPrize.textContent = prize ?? 0;
  dom.myPoints.textContent = points ?? 0;

  const burrowUsed = !!p.burrowUsed;
  dom.myBurrow.textContent = burrowUsed ? "gebruikt" : "ready";

  dom.myFlavourText.textContent = makeFlavourText(den, status);

  // score summary
  dom.scoreSummary.innerHTML = `
    <span>🥚 ${eggs || 0} Eggs</span>
    <span>· 🐔 ${hens || 0} Hens</span>
    <span>· 👑 ${prize || 0} Prize</span>
    <span>· Totaal: ${points || 0} punten</span>
  `;
}

function updateDenDot(cardEl, denName) {
  if (!cardEl) return;
  // maak of vind een dot
  let dot = cardEl.querySelector(".den-dot");
  if (!dot) {
    dot = document.createElement("div");
    dot.className = "den-dot den-none";
    cardEl.insertBefore(dot, cardEl.firstChild);
  }
  dot.className = "den-dot den-none";
  if (denName === "Red") dot.classList.add("den-red");
  else if (denName === "Blue") dot.classList.add("den-blue");
  else if (denName === "Green") dot.classList.add("den-green");
  else if (denName === "Yellow") dot.classList.add("den-yellow");
}

function makeFlavourText(den, status) {
  let base =
    "Je bent een vos in de Yard, op jacht naar eieren en kippen. Kies je momenten goed.";
  if (den === "Red") {
    base =
      "Je bent een Red Den vos: fel, impulsief en niet bang voor risico. Perfect voor brutale SNATCHES.";
  } else if (den === "Blue") {
    base =
      "Je bent een Blue Den vos: rustig, observerend en strategisch. SCOUT en SHIFT passen goed bij je.";
  } else if (den === "Green") {
    base =
      "Je bent een Green Den vos: flexibel en opportunistisch. Je voelt goed aan wanneer je moet DASHen.";
  } else if (den === "Yellow") {
    base =
      "Je bent een Yellow Den vos: speels en onvoorspelbaar. Je leeft op chaos en gekke combo’s.";
  }
  if (status === "dashed") {
    base += " Je bent al uit de Yard gerend – nu hopen dat je buit genoeg is.";
  } else if (status === "caught") {
    base += " Je bent gepakt in deze raid. De volgende raid is jouw comeback.";
  }
  return base;
}

function renderProfileTab() {
  if (!playersCol) return;

  const me = currentPlayer;
  const others = players.filter((p) => p.id !== playerId);

  dom.otherPlayersList.innerHTML = "";
  if (!others.length) {
    dom.noOtherPlayersMsg.style.display = "block";
  } else {
    dom.noOtherPlayersMsg.style.display = "none";
  }

  others.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "player-mini-card";
    btn.dataset.playerId = p.id;

    const den = p.denColor || p.den || "None";
    const status = p.status || "yard";
    const denClass =
      den === "Red"
        ? "den-red"
        : den === "Blue"
        ? "den-blue"
        : den === "Green"
        ? "den-green"
        : den === "Yellow"
        ? "den-yellow"
        : "den-none";

    btn.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.4rem;">
        <span>${p.name || "Onbekend"}</span>
        <span class="den-dot ${denClass}"></span>
      </div>
      <div style="font-size:0.72rem;color:${status === "caught"
        ? "#fca5a5"
        : "#9ca3af"
      };">Status: ${status}</div>
    `;

    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".player-mini-card")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      renderOtherPlayerDetail(p);
    });

    dom.otherPlayersList.appendChild(btn);
  });

  if (!dom.otherPlayerDetail.innerHTML.trim()) {
    dom.otherPlayerDetail.textContent =
      "Klik op een andere speler om zijn/haar profiel te bekijken.";
  }
}

function renderOtherPlayerDetail(p) {
  const den = p.denColor || p.den || "None";
  const status = p.status || "yard";

  let eggs = p.lootEggs ?? p.eggs ?? 0;
  let hens = p.lootHens ?? p.hens ?? 0;
  let prize = p.lootPrize ?? p.prize ?? 0;
  let points = p.lootPoints ?? p.points ?? null;

  if (!points && Array.isArray(p.loot)) {
    eggs = p.loot.filter((l) => l.t === "Egg").length;
    hens = p.loot.filter((l) => l.t === "Hen").length;
    prize = p.loot.filter(
      (l) => l.t === "Prize Hen" || l.t === "Prize"
    ).length;
    points = p.loot.reduce((sum, l) => sum + (l.v || 0), 0);
  }

  const statusClass =
    status === "yard"
      ? "badge-status-yard"
      : status === "dashed"
      ? "badge-status-dashed"
      : "badge-status-caught";

  dom.otherPlayerDetail.innerHTML = `
    <div style="display:grid;grid-template-columns:140px minmax(0,1fr);gap:0.75rem;align-items:start;">
      <div class="card-23">
        <div class="card-23-header">
          <div class="card-23-title">${p.name || "—"}</div>
          <div class="card-23-type">Den: ${den}</div>
        </div>
        <div class="card-23-body">
          <span class="badge ${statusClass}">Status: ${status}</span>
          <div style="margin-top:0.3rem;font-size:0.72rem;">
            <div>🥚 Eggs: ${eggs || 0}</div>
            <div>🐔 Hens: ${hens || 0}</div>
            <div>👑 Prize: ${prize || 0}</div>
          </div>
        </div>
        <div class="card-23-footer">
          Totaal: ${points || 0} punten
        </div>
      </div>
      <div style="font-size:0.8rem;">
        <div><strong>Rol in deze raid</strong></div>
        <div class="muted" style="margin-top:0.25rem;">
          Deze vos speelt mee als ${den}-kleur vos met status <strong>${status}</strong>.
          Bekijk in de Community Log welke acties deze speler heeft gedaan.
        </div>
      </div>
    </div>
  `;
}

/* ============================
   PLAY TAB + TURN INFO
   ============================ */

function renderPlayTab() {
  const r = currentRoom || {};
  const p = currentPlayer || {};
  const phaseKey = r.phase || "lobby";
  const phaseLabel = phaseKeyToLabel(phaseKey);

  const { myTurn, turnLabel, hint } = computeTurnInfo();
  dom.turnIndicator.textContent = `Fase: ${phaseLabel} · ${turnLabel}`;
  dom.turnHint.textContent = hint;

  // hand
  const hand = p.handNames || p.hand || [];
  dom.myCardsList.innerHTML = "";

  if (!hand.length) {
    dom.myCardsList.innerHTML =
      '<div class="muted">Je hebt momenteel geen Action Cards in je hand.</div>';
  } else {
    hand.forEach((c, idx) => {
      const name = typeof c === "string" ? c : c.name || "?";
      const el = document.createElement("div");
      el.className = "card-23";
      if (idx === selectedActionCardIndex) {
        el.classList.add("selected");
      }
      el.dataset.index = String(idx);
      el.innerHTML = `
        <div class="card-23-header">
          <div class="card-23-title">${name}</div>
          <div class="card-23-type">Action</div>
        </div>
        <div class="card-23-body">
          <div style="font-size:0.72rem;">
            ${shortDescriptionForAction(name)}
          </div>
        </div>
        <div class="card-23-footer">
          <button class="btn btn-sm btn-secondary btn-full play-select-btn" data-index="${idx}">
            Selecteer als Play Next
          </button>
        </div>
      `;
      dom.myCardsList.appendChild(el);
    });
  }

  if (selectedActionCardIndex == null || !hand[selectedActionCardIndex]) {
    dom.selectedCardLabel.textContent = "Geselecteerde kaart: geen.";
  } else {
    const c = hand[selectedActionCardIndex];
    const name = typeof c === "string" ? c : c.name || "?";
    dom.selectedCardLabel.textContent = `Geselecteerde kaart: ${name}.`;
  }
}

function shortDescriptionForAction(name) {
  const card = ACTION_CARDS.find((a) => a.name === name);
  if (card) return card.short;
  return "Action Card – zie Speluitleg tab voor details.";
}

function computeTurnInfo() {
  const r = currentRoom || {};
  const p = currentPlayer || {};
  const phaseKey = r.phase || "lobby";
  const status = p.status || "yard";
  const inYard = status === "yard";

  let myTurn = false;
  let turnLabel = "Beurt: —";
  let hint = "Wacht op de host om de raid te starten.";

  if (!r.phase) {
    return { myTurn, turnLabel, hint };
  }

  if (phaseKey === "move_all") {
    const moveDone = !!p.moveDone;
    myTurn = inYard && !moveDone;
    if (myTurn) {
      turnLabel = "Jij bent aan de beurt (MOVE)";
      hint = "Kies nu één MOVE: SNATCH / FORAGE / SCOUT / SHIFT.";
    } else {
      turnLabel = "Beurt: andere vossen (MOVE)";
      hint = "Je hebt je MOVE al gedaan of bent niet meer in de Yard.";
    }
  } else if (phaseKey === "ops") {
    const opsTurnId = r.opsTurnPlayerId || r.opsPlayerId;
    myTurn = inYard && opsTurnId === playerId;
    if (myTurn) {
      turnLabel = "Jij bent aan de beurt (ACTIONS)";
      hint =
        "Speel één Action Card of kies PASS. Je pop-up toont je geselecteerde kaart.";
    } else {
      turnLabel = "Beurt: andere vos (ACTIONS)";
      hint =
        "Wacht tot je aan de beurt bent. Je kunt alvast een kaart kiezen als Play Next.";
    }
  } else if (phaseKey === "decide") {
    const decisionLocked = !!p.decisionLocked;
    myTurn = inYard && !decisionLocked;
    if (myTurn) {
      turnLabel = "Jij bent aan de beurt (DECISION)";
      hint = "Kies LURK / BURROW / DASH. Je keuze telt bij de REVEAL.";
    } else {
      turnLabel = "Beurt: andere vossen (DECISION)";
      hint = "Je DECISION staat al vast of je bent niet meer in de Yard.";
    }
  } else if (phaseKey === "reveal") {
    myTurn = false;
    turnLabel = "REVEAL – alleen kijken";
    hint = "Host onthult het Event en past de effecten toe.";
  } else if (phaseKey === "end") {
    myTurn = false;
    turnLabel = "EIND – score";
    hint = "Raid is voorbij. Bekijk je buit en de eindscore.";
  }

  updateTurnPill(myTurn, turnLabel);
  return { myTurn, turnLabel, hint };
}

function updateTurnPill(myTurn, label) {
  dom.pillTurn.textContent = label;
  dom.pillTurn.classList.remove("pill-turn-active", "pill-turn-wait");
  dom.pillTurn.classList.add(myTurn ? "pill-turn-active" : "pill-turn-wait");
}

function checkTurnChange() {
  const { myTurn } = computeTurnInfo();
  if (myTurn && !lastMyTurn) {
    onMyTurnStart();
  }
  lastMyTurn = myTurn;
}

function onMyTurnStart() {
  const r = currentRoom || {};
  const phaseKey = r.phase || "lobby";

  if (phaseKey === "move_all") {
    openMovePopup();
  } else if (phaseKey === "decide") {
    openDecisionPopup();
  } else if (phaseKey === "ops") {
    if (selectedActionCardIndex != null) {
      openPlayCardPopup();
    } else {
      setFeedback("Jij bent aan de beurt (ACTIONS). Kies een kaart of PASS.");
    }
  }
}

/* ============================
   TABS + FILTERS
   ============================ */

function bindTabs() {
  const buttons = document.querySelectorAll(".tab-button");
  if (buttons.length === 0) {
    // eerste keer: maak ze dynamisch gebaseerd op volgorde
    const bar = document.querySelector(".tabbar-inner");
    if (bar && !bar.children.length) {
      bar.innerHTML = `
        <button class="tab-button active" data-tab="rules">
          <div class="tab-button-icon">📘</div>
          <span>Speluitleg</span>
        </button>
        <button class="tab-button" data-tab="profile">
          <div class="tab-button-icon">🦊</div>
          <span>Profiel</span>
        </button>
        <button class="tab-button" data-tab="play">
          <div class="tab-button-icon">🎮</div>
          <span>Spelverloop</span>
        </button>
        <button class="tab-button" data-tab="log">
          <div class="tab-button-icon">📜</div>
          <span>Log</span>
        </button>
      `;
    }
  }

  const btns = document.querySelectorAll(".tab-button");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      setActiveTab(tab);
    });
  });
}

function setActiveTab(tab) {
  activeTab = tab;

  Object.entries(dom.tabPanels).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle("active", key === tab);
  });

  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
}

function bindRulesFilter() {
  if (!dom.rulesFilter) return;
  dom.rulesFilter.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    cardsFilter = btn.dataset.filter;
    dom.rulesFilter
      .querySelectorAll("button")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderRulesCards();
  });
}

/* ============================
   RULES TAB – CARD GRID
   ============================ */

function renderRulesCards() {
  if (!dom.rulesCardsGrid) return;
  dom.rulesCardsGrid.innerHTML = "";

  const cards =
    cardsFilter === "loot"
      ? LOOT_CARDS
      : cardsFilter === "event"
      ? EVENT_CARDS
      : cardsFilter === "action"
      ? ACTION_CARDS
      : ALL_CARDS;

  cards.forEach((c) => {
    const el = document.createElement("div");
    el.className = "card-23";
    el.innerHTML = `
      <div class="card-23-header">
        <div class="card-23-title">${c.name}</div>
        <div class="card-23-type">${c.type.toUpperCase()}</div>
      </div>
      <div class="card-23-body">
        ${c.short}
      </div>
      <div class="card-23-footer">
        ${c.detail}
      </div>
    `;
    dom.rulesCardsGrid.appendChild(el);
  });
}

/* ============================
   LOG TAB
   ============================ */

function renderLogTab() {
  if (!dom.logList) return;

  if (!logs.length) {
    dom.logList.innerHTML =
      '<div class="muted">Nog geen gebeurtenissen in deze raid.</div>';
    return;
  }

  dom.logList.innerHTML = "";

  logs.forEach((l) => {
    const icon =
      l.icon ||
      (l.phase === "move_all"
        ? "🚶"
        : l.phase === "ops"
        ? "🎴"
        : l.phase === "decide"
        ? "🤔"
        : l.phase === "reveal"
        ? "🐓"
        : "•");

    const round = l.round ?? l.roundNumber ?? "";
    const phaseLabel = l.phase ? phaseKeyToLabel(l.phase) : "";
    const who = l.playerName || l.player || "";

    const item = document.createElement("div");
    item.className = "log-item";
    item.innerHTML = `
      <div class="log-icon">${icon}</div>
      <div>
        <div class="log-text-main">${l.message || "(geen tekst)"}</div>
        <div class="log-text-meta">
          ${round ? `Ronde ${round} · ` : ""}${phaseLabel}${
      who ? ` · ${who}` : ""
    }
        </div>
      </div>
    `;
    dom.logList.appendChild(item);
  });
}

/* ============================
   POPUPS
   ============================ */

function bindPopupControls() {
  if (dom.popupCloseBtn) {
    dom.popupCloseBtn.addEventListener("click", () => closePopup());
  }
  if (dom.popupOverlay) {
    dom.popupOverlay.addEventListener("click", (e) => {
      if (e.target === dom.popupOverlay) {
        closePopup();
      }
    });
  }
}

function openPopup(type, title, bodyHtml) {
  popupType = type;
  if (!dom.popupOverlay) return;
  dom.popupTitle.textContent = title;
  dom.popupBody.innerHTML = bodyHtml;
  dom.popupOverlay.classList.remove("hidden");
}

function closePopup() {
  popupType = null;
  pendingDecisionChoice = null;
  if (!dom.popupOverlay) return;
  dom.popupOverlay.classList.add("hidden");
}

/* MOVE POPUP */

function openMovePopup() {
  const content = `
    <div>Je mag deze ronde precies één MOVE doen:</div>
    <div class="popup-card-inner">
      <div class="card-23">
        <div class="card-23-header">
          <div class="card-23-title">MOVE</div>
          <div class="card-23-type">Fase</div>
        </div>
        <div class="card-23-body">
          Kies één van de vier opties:<br/><br/>
          • SNATCH – 1 loot van de Deck<br/>
          • FORAGE – 2 Action Cards<br/>
          • SCOUT – kijk vooruit<br/>
          • SHIFT – wissel Events
        </div>
        <div class="card-23-footer">
          Je keuze geldt voor deze ronde.
        </div>
      </div>
    </div>
    <div class="popup-actions">
      <button class="btn btn-secondary" id="moveSnatchBtn">SNATCH</button>
      <button class="btn btn-secondary" id="moveForageBtn">FORAGE</button>
      <button class="btn btn-secondary" id="moveScoutBtn">SCOUT</button>
      <button class="btn btn-secondary" id="moveShiftBtn">SHIFT</button>
    </div>
    <div class="popup-hint">
      Klik op één van de knoppen. Je MOVE wordt als intent naar de host gestuurd.
    </div>
  `;
  openPopup("MOVE", "Kies jouw MOVE", content);

  $("#moveSnatchBtn")?.addEventListener("click", () => {
    sendMove("SNATCH");
    closePopup();
  });
  $("#moveForageBtn")?.addEventListener("click", () => {
    sendMove("FORAGE");
    closePopup();
  });
  $("#moveScoutBtn")?.addEventListener("click", () => {
    sendMove("SCOUT");
    closePopup();
  });
  $("#moveShiftBtn")?.addEventListener("click", () => {
    sendMove("SHIFT");
    closePopup();
  });
}

/* DECISION POPUP */

function openDecisionPopup() {
  pendingDecisionChoice = null;

  const content = `
    <div>Kies hoe je dit Event in gaat:</div>
    <div class="popup-card-inner">
      <div class="card-23">
        <div class="card-23-header">
          <div class="card-23-title">DECISION</div>
          <div class="card-23-type">Fase</div>
        </div>
        <div class="card-23-body">
          • LURK – blijven in de Yard<br/>
          • BURROW – éénmalig schuilen<br/>
          • DASH – weg rennen met je buit
        </div>
        <div class="card-23-footer">
          Je keuze telt bij de REVEAL.
        </div>
      </div>
    </div>
    <div class="popup-actions">
      <button class="btn btn-secondary" id="decideLurkBtn">LURK</button>
      <button class="btn btn-secondary" id="decideBurrowBtn">BURROW</button>
      <button class="btn btn-primary" id="decideDashBtn">DASH</button>
    </div>
    <div class="popup-hint">
      BURROW kun je maar één keer per raid gebruiken.
    </div>
  `;
  openPopup("DECISION", "Kies jouw beslissing", content);

  const burrowUsed = !!currentPlayer?.burrowUsed;
  if (burrowUsed) {
    $("#decideBurrowBtn")?.setAttribute("disabled", "true");
  }

  $("#decideLurkBtn")?.addEventListener("click", () =>
    confirmDecision("LURK")
  );
  $("#decideBurrowBtn")?.addEventListener("click", () =>
    confirmDecision("BURROW")
  );
  $("#decideDashBtn")?.addEventListener("click", () =>
    confirmDecision("DASH")
  );
}

function confirmDecision(choice) {
  pendingDecisionChoice = choice;
  const label =
    choice === "LURK"
      ? "LURK – blijven in de Yard"
      : choice === "BURROW"
      ? "BURROW – éénmalig schuilen"
      : "DASH – ren weg met je buit";

  const content = `
    <div>Je hebt gekozen voor:</div>
    <div class="popup-card-inner">
      <div class="card-23">
        <div class="card-23-header">
          <div class="card-23-title">${choice}</div>
          <div class="card-23-type">Bevestigen</div>
        </div>
        <div class="card-23-body">
          ${label}
        </div>
        <div class="card-23-footer">
          Deze keuze geldt voor dit Event.
        </div>
      </div>
    </div>
    <div class="popup-actions">
      <button class="btn btn-primary" id="confirmDecisionBtn">Spelen</button>
      <button class="btn btn-secondary" id="changeDecisionBtn">Toch wijzigen</button>
    </div>
  `;
  openPopup("DECISION_CONFIRM", "Bevestig je beslissing", content);

  $("#confirmDecisionBtn")?.addEventListener("click", () => {
    if (pendingDecisionChoice) {
      sendDecision(pendingDecisionChoice);
    }
    closePopup();
  });

  $("#changeDecisionBtn")?.addEventListener("click", () => {
    openDecisionPopup();
  });
}

/* PLAY CARD POPUP */

function openPlayCardPopup() {
  const p = currentPlayer || {};
  const hand = p.handNames || p.hand || [];
  if (selectedActionCardIndex == null || !hand[selectedActionCardIndex]) {
    setFeedback("Geen kaart geselecteerd als Play Next.");
    return;
  }

  const card = hand[selectedActionCardIndex];
  const name = typeof card === "string" ? card : card.name || "?";
  const short = shortDescriptionForAction(name);

  const content = `
    <div>Je hebt deze kaart klaargezet als Play Next:</div>
    <div class="popup-card-inner">
      <div class="card-23">
        <div class="card-23-header">
          <div class="card-23-title">${name}</div>
          <div class="card-23-type">Action Card</div>
        </div>
        <div class="card-23-body">
          ${short}
        </div>
        <div class="card-23-footer">
          Je mag in je beurt precies één Action Card spelen.
        </div>
      </div>
    </div>
    <div class="popup-actions">
      <button class="btn btn-primary" id="playCardNowBtn">Spelen</button>
      <button class="btn btn-secondary" id="changeCardBtn">Wijzigen</button>
      <button class="btn btn-ghost" id="skipCardBtn">Overslaan (PASS)</button>
    </div>
  `;
  openPopup("PLAY_CARD", "Action spelen", content);

  $("#playCardNowBtn")?.addEventListener("click", () => {
    sendOps(name);
    closePopup();
  });
  $("#changeCardBtn")?.addEventListener("click", () => {
    closePopup();
  });
  $("#skipCardBtn")?.addEventListener("click", () => {
    sendOps("PASS");
    closePopup();
  });
}

/* ============================
   PLAY TAB – CONTROLS
   ============================ */

function bindPlayControls() {
  if (dom.myCardsList) {
    dom.myCardsList.addEventListener("click", (e) => {
      const btn = e.target.closest(".play-select-btn");
      if (!btn) return;
      const idx = parseInt(btn.dataset.index, 10);
      if (Number.isNaN(idx)) return;
      selectedActionCardIndex = idx;
      renderPlayTab();
    });
  }

  if (dom.btnPlayNext) {
    dom.btnPlayNext.addEventListener("click", () => {
      const p = currentPlayer || {};
      const hand = p.handNames || p.hand || [];
      if (
        selectedActionCardIndex == null ||
        !hand[selectedActionCardIndex]
      ) {
        setFeedback("Selecteer eerst een kaart in je hand.");
        return;
      }

      const { myTurn } = computeTurnInfo();
      if (myTurn && (currentRoom?.phase === "ops")) {
        openPlayCardPopup();
      } else {
        setFeedback(
          "Kaart ingesteld als Play Next. Als je aan de beurt bent, verschijnt de pop-up."
        );
      }
    });
  }
}

/* ============================
   FIRESTORE – INTENTS
   ============================ */

async function sendIntent(kind, payload = {}) {
  if (!roomRef || !playerRef || !currentPlayer) return;
  if (isSending) return;

  try {
    isSending = true;
    const movesCol = collection(roomRef, "moves");
    await addDoc(movesCol, {
      kind, // 'MOVE' | 'OPS' | 'DECISION'
      payload,
      playerId,
      playerName: currentPlayer.name || null,
      phase: currentRoom?.phase || null,
      createdAt: serverTimestamp(),
      resolved: false,
    });
  } catch (e) {
    console.error(e);
    setFeedback("Fout bij verzenden van actie. Probeer opnieuw.");
  } finally {
    isSending = false;
  }
}

async function sendMove(moveType) {
  await sendIntent("MOVE", { moveType });
  setFeedback(`MOVE ${moveType} verstuurd.`);
}

async function sendOps(actionType) {
  await sendIntent("OPS", { actionType });
  setFeedback(`Action ${actionType} verstuurd.`);
}

async function sendDecision(decisionType) {
  await sendIntent("DECISION", { decisionType });
  setFeedback(`Decision ${decisionType} verstuurd.`);
}

/* ============================
   FEEDBACK TOAST
   ============================ */

function setFeedback(msg) {
  if (!dom.feedbackToast || !dom.feedbackText) return;
  dom.feedbackText.textContent = msg;
  dom.feedbackToast.classList.add("visible");
  if (feedbackTimeout) clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => {
    dom.feedbackToast.classList.remove("visible");
  }, 5000);
}
