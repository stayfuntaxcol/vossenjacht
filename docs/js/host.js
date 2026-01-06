// host.js — VOSSENJACHT (FULL FEATURE PARITY + AUTONOMOUS BOTS incl. Action Cards)

import { initAuth } from "./firebase.js";
import { getEventById, CARD_BACK } from "./cards.js";
import { addLog } from "./log.js";
import { resolveAfterReveal } from "./engine.js";
import { renderPlayerSlotCard } from "./cardRenderer.js";

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
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
let gameId = params.get("game"); // let (wordt opnieuw gezet bij new raid)
const mode = params.get("mode") || "host"; // "host" of "board"
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
if (isBoardOnly && logPanel) {
  logPanel.style.display = "none";
}

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
const sackCard = document.getElementById("sackCard");
const lootDeckCard = document.getElementById("lootDeckCard");
const actionDeckCard = document.getElementById("actionDeckCard");

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

// Laatste event dat we fullscreen hebben getoond
let lastRevealedEventId = null;

// Verberg oude test-knop (endBtn)
if (endBtn) {
  endBtn.style.display = "none";
}

// ===============================
// State
// ===============================
let currentRoundNumber = 0;
let currentRoundForActions = 0;
let currentPhase = "MOVE";
let unsubActions = null;

let latestPlayers = [];
let latestGame = null;

// Voor Lead Fox highlight & kaart
let currentLeadFoxId = null;
let currentLeadFoxName = "";

// Scoreboard cache
let latestPlayersCacheForScoreboard = [];

// Kleur-cycling voor Dens
const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];

// ===============================
// Helpers (status/yard)
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

// ===============================
// Event poster
// ===============================
function openEventPoster(eventId) {
  if (!eventPosterOverlay || !eventId) return;
  const ev = getEventById(eventId);
  if (!ev) return;

  if (eventPosterTitle) eventPosterTitle.textContent = ev.title || "";
  if (eventPosterText) eventPosterText.textContent = ev.text || "";
  if (eventPosterImage) {
    const src = ev.imagePoster || ev.imageFront || CARD_BACK;
    eventPosterImage.src = src;
  }

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
    if (e.target === eventPosterOverlay) closeEventPoster();
  });
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
// Deck helpers
// ===============================
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Event track: 12 kaarten, met DOG_CHARGE eerste helft en SECOND_CHARGE tweede helft
function buildEventTrack() {
  const SAFE_FIRST_EVENT = "SHEEPDOG_PATROL";
  const others = [
    "DEN_RED",
    "DEN_BLUE",
    "DEN_GREEN",
    "DEN_YELLOW",
    "HIDDEN_NEST",
    "GATE_TOLL",
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
  track[secondIndex] = "SECOND_CHARGE";

  let pIdx = 0;
  for (let i = 0; i < track.length; i++) {
    if (track[i] !== null) continue;
    track[i] = pool[pIdx++];
  }
  return track;
}

// Action deck ZONDER Countermove
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

    let state = "future";
    if (isRevealed) {
      if (currentId && eventId === currentId) state = "current";
      else state = "past";
    }

    const slot = document.createElement("div");
    slot.classList.add("event-slot", `event-state-${state}`);

    let imgUrl = CARD_BACK;
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
}

// ===============================
// EINDSCORE / SCOREBOARD + LEADERBOARDS
// ===============================
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

  await loadLeaderboardsMulti();

  if (scoreOverlayContent) {
    const scoreboardClone = section.cloneNode(true);
    scoreOverlayContent.innerHTML = "";
    scoreOverlayContent.appendChild(scoreboardClone);
  }
}

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
      <span class="leaderboard-item-loot">
        E:${eggs} H:${hens} P:${prize} +${bonus}
      </span>
    </div>
    <div class="leaderboard-item-meta">
      <div>${score} pts</div>
      <div class="leaderboard-item-date">${dateLabel}</div>
    </div>
  `;
  listEl.appendChild(li);
}

async function loadLeaderboardsMulti() {
  if (!roundInfo) return;

  const listToday = roundInfo.querySelector("#leaderboardToday");
  const listMonth = roundInfo.querySelector("#leaderboardMonth");
  const listAllTime = roundInfo.querySelector("#leaderboardAllTime");
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
  if (!docsArr.length) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Nog geen scores.";
    listEl.appendChild(li);
    return;
  }

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
  if (!docsArr.length) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Nog geen scores voor vandaag.";
    listEl.appendChild(li);
    return;
  }

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
  if (!docsArr.length) {
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Nog geen scores voor deze maand.";
    listEl.appendChild(li);
    return;
  }

  docsArr.sort((a, b) => calcLeaderboardScore(b) - calcLeaderboardScore(a));
  const top = docsArr.slice(0, 25);
  top.forEach((data, idx) => appendLeaderboardRow(listEl, idx + 1, data));
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
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
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
// HELPER: SPELERS ZONES RENDEREN
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

    if (zoneType === "yard") yardZone.appendChild(card);
    else if (zoneType === "dash") dashZone.appendChild(card);
    else caughtZone.appendChild(card);
  });

  if (latestGame && isGameFinished(latestGame)) {
    renderFinalScoreboard(latestGame);
  }
}

// ===============================
// GAME CODE generator + NEW RAID FROM BOARD
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
    });

    const newGameId = gameRefLocal.id;
    gameId = newGameId;

    const url = new URL(window.location.href);
    url.searchParams.set("game", newGameId);
    url.searchParams.set("mode", "board");
    window.location.href = url.toString();
  } catch (err) {
    console.error("Fout bij Start nieuwe Raid:", err);
    alert("Er ging iets mis bij het starten van een nieuwe Raid.");
  }
}
if (newRaidBtn) newRaidBtn.addEventListener("click", startNewRaidFromBoard);

// ===============================
// BOT SYSTEM (autonomous)
// ===============================
let hostUid = null;
let botTickScheduled = false;

// Base bot action chance (hand bonus wordt binnen botDoOpsTurn opgeteld)
const BOT_ACTION_PROB = 0.65;

let botRunnerId = null;
try {
  botRunnerId = localStorage.getItem("botRunnerId");
} catch (e) {
  botRunnerId = null;
}
if (!botRunnerId) {
  const rnd =
    globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + "-" + Date.now();
  botRunnerId = rnd;
  try {
    localStorage.setItem("botRunnerId", botRunnerId);
  } catch (e) {}
}

let botInterval = null;
let botBusy = false;

function startBotLoop() {
  if (botInterval) return;
  botInterval = setInterval(runBotsOnce, 900);
}
function stopBotLoop() {
  if (!botInterval) return;
  clearInterval(botInterval);
  botInterval = null;
  botBusy = false;
}
function scheduleBotTick() {
  if (botTickScheduled) return;
  botTickScheduled = true;

  setTimeout(async () => {
    botTickScheduled = false;
    try {
      await runBotsOnce();
    } catch (e) {
      console.warn("[BOTS] runBotsOnce error", e);
    }
  }, 250);
}

function isBotPlayer(p) {
  return !!p?.isBot;
}

function canBotMove(game, p) {
  if (!game || !p) return false;
  if (!isActiveRaidStatus(game.status)) return false;
  if (game.phase !== "MOVE") return false;
  if (game.raidEndedByRooster) return false;
  if (!isInYardLocal(p)) return false;

  const moved = Array.isArray(game.movedPlayerIds) ? game.movedPlayerIds : [];
  return !moved.includes(p.id);
}

function canBotDecide(game, p) {
  if (!game || !p) return false;
  if (!isActiveRaidStatus(game.status)) return false;
  if (game.phase !== "DECISION") return false;
  if (game.raidEndedByRooster) return false;
  if (!isInYardLocal(p)) return false;
  if (p.decision) return false;
  return true;
}

function isOpsTurn(game) {
  if (!game) return null;
  if (!isActiveRaidStatus(game.status)) return null;
  if (game.phase !== "ACTIONS") return null;

  const order = game.opsTurnOrder || [];
  if (!order.length) return null;

  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  if (idx < 0 || idx >= order.length) return null;

  return order[idx];
}

async function logBot(gameIdParam, payload) {
  await addDoc(collection(db, "games", gameIdParam, "actions"), {
    ...payload,
    createdAt: serverTimestamp(),
  });

  await addLog(gameIdParam, {
    round: payload.round ?? 0,
    phase: payload.phase ?? "",
    kind: "BOT",
    playerId: payload.playerId,
    message: payload.message || `${payload.playerName || "BOT"}: ${payload.choice}`,
  });
}

async function acquireBotLock() {
  if (!gameId) return false;

  const ref = doc(db, "games", gameId);
  const now = Date.now();
  const me = hostUid || botRunnerId;

  try {
    const ok = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;

      const g = snap.data();
      if (g?.botsEnabled !== true) return false;
      if (isGameFinished(g)) return false;

      const lockUntil = Number(g.botsLockUntil || 0);
      const lockBy = String(g.botsLockBy || "");

      if (lockUntil > now && lockBy && lockBy !== me) return false;

      tx.update(ref, {
        botsLockUntil: now + 1600,
        botsLockBy: me,
      });
      return true;
    });

    return ok === true;
  } catch (e) {
    console.warn("[BOTS] lock tx failed", e);
    return false;
  }
}

// ===============================
// BOT MOVE
// ===============================
async function botDoMove(botId) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!canBotMove(g, p)) return;

    const moved = Array.isArray(g.movedPlayerIds) ? [...g.movedPlayerIds] : [];
    const hand = Array.isArray(p.hand) ? [...p.hand] : [];
    const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const lootDeck = Array.isArray(g.lootDeck) ? [...g.lootDeck] : [];
    const loot = Array.isArray(p.loot) ? [...p.loot] : [];

    if (hand.length < 2 && actionDeck.length) {
      let drawn = 0;
      for (let i = 0; i < 2; i++) {
        if (!actionDeck.length) break;
        hand.push(actionDeck.pop());
        drawn++;
      }

      tx.update(pRef, { hand });
      tx.update(gRef, {
        actionDeck,
        movedPlayerIds: [...new Set([...moved, botId])],
      });

      logPayload = {
        round: g.round || 0,
        phase: "MOVE",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: `MOVE_FORAGE_${drawn}cards`,
        message: `BOT deed FORAGE (${drawn} kaart(en))`,
      };
    } else {
      if (!lootDeck.length) return;
      const card = lootDeck.pop();
      loot.push(card);

      tx.update(pRef, { loot });
      tx.update(gRef, {
        lootDeck,
        movedPlayerIds: [...new Set([...moved, botId])],
      });

      logPayload = {
        round: g.round || 0,
        phase: "MOVE",
        playerId: botId,
        playerName: p.name || "BOT",
        choice: "MOVE_SNATCH_FROM_DECK",
        message: `BOT deed SNATCH (${card.t || "Loot"} ${card.v ?? ""})`,
      };
    }
  });

  if (logPayload) await logBot(gameId, logPayload);
}

// ===============================
// BOT ACTIONS (OPS): helpers + play action OR PASS
// ===============================
const BOT_SIMPLE_EFFECTS = new Set([
  "Burrow Beacon",
  "Scatter!",
  "Scent Check",
  "Follow the Tail",
  "Den Signal",
  "Pack Tinker",
]);

function pickBotActionName(hand) {
  const names = (hand || []).map((c) => c?.name).filter(Boolean);
  if (!names.length) return null;

  const preferred = names.filter((n) => BOT_SIMPLE_EFFECTS.has(n));
  if (preferred.length) return preferred[Math.floor(Math.random() * preferred.length)];
  return names[Math.floor(Math.random() * names.length)];
}

function lootPoints(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);
}

function pickBestTargetPlayerId(botId) {
  const candidates = (latestPlayers || []).filter((x) => x?.id && x.id !== botId && isInYardLocal(x));
  if (!candidates.length) return null;
  candidates.sort((a, b) => lootPoints(b) - lootPoints(a));
  return candidates[0].id;
}

function pickPackTinkerIndices(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const revealed = Array.isArray(game?.eventRevealed) ? game.eventRevealed : track.map(() => false);

  const hidden = [];
  for (let i = 0; i < track.length; i++) {
    if (!revealed[i]) hidden.push(i);
  }
  if (hidden.length < 2) return null;

  const nextIdx = typeof game.eventIndex === "number" ? game.eventIndex : hidden[0];
  const a = hidden.includes(nextIdx) ? nextIdx : hidden[0];
  let b = hidden[hidden.length - 1];
  if (b === a) b = hidden[0];

  return [a, b];
}

async function botDoOpsTurn(botId) {
  const gRef = doc(db, "games", gameId);
  const pRef = doc(db, "games", gameId, "players", botId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!isActiveRaidStatus(g.status) || g.phase !== "ACTIONS") return;

    const order = g.opsTurnOrder || [];
    const idx = typeof g.opsTurnIndex === "number" ? g.opsTurnIndex : 0;
    if (!order.length || order[idx] !== botId) return;

    const roundNum = Number(g.round || 0);
    const nextIndex = (idx + 1) % order.length;

    const alreadyPlayed = Number(p.opsActionPlayedRound || 0) === roundNum;

    const hand = Array.isArray(p.hand) ? [...p.hand] : [];
    const actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const discard = Array.isArray(g.actionDiscard) ? [...g.actionDiscard] : [];
    const flagsRound = g.flagsRound ? { ...g.flagsRound } : {};

    // ✅ kansberekening hoort HIER (hand/alreadyPlayed bestaan hier pas)
    const base = typeof g.botActionProb === "number" ? g.botActionProb : BOT_ACTION_PROB;
    const handBonus = Math.min(0.25, Math.max(0, (hand.length - 1) * 0.08)); // +8% per extra kaart
    const prob = Math.min(0.95, base + handBonus);
    let willPlay = !alreadyPlayed && hand.length > 0 && Math.random() < prob;

    if (willPlay) {
      const cardName = pickBotActionName(hand);
      if (!cardName) {
        willPlay = false;
      } else {
        const removeIdx = hand.findIndex((c) => c?.name === cardName);
        if (removeIdx >= 0) hand.splice(removeIdx, 1);

        discard.push({ name: cardName, by: botId, round: roundNum, at: Date.now() });
        if (actionDeck.length) hand.push(actionDeck.pop());

        const extraGameUpdates = {};

        if (cardName === "Burrow Beacon") {
          flagsRound.lockEvents = true;
        }

        if (cardName === "Scatter!") {
          flagsRound.scatter = true;
          extraGameUpdates.scatterArmed = true;
        }

        if (cardName === "Scent Check") {
          const arr = Array.isArray(flagsRound.scentChecks) ? [...flagsRound.scentChecks] : [];
          if (!arr.includes(botId)) arr.push(botId);
          flagsRound.scentChecks = arr;
        }

        if (cardName === "Follow the Tail") {
          const targetId = pickBestTargetPlayerId(botId);
          if (targetId) {
            const ft = flagsRound.followTail ? { ...flagsRound.followTail } : {};
            ft[botId] = targetId; // ✅ followerId -> targetId (engine verwacht dit)
            flagsRound.followTail = ft;
          }
        }

        if (cardName === "Den Signal") {
          const denImmune = flagsRound.denImmune ? { ...flagsRound.denImmune } : {};
          const myColor = p.color;
          if (myColor) denImmune[myColor] = true;
          flagsRound.denImmune = denImmune;
        }

        if (cardName === "Pack Tinker") {
          if (!flagsRound.lockEvents) {
            const pair = pickPackTinkerIndices(g);
            if (pair) {
              const [i1, i2] = pair;
              const trackNow = Array.isArray(g.eventTrack) ? [...g.eventTrack] : [];
              if (trackNow[i1] && trackNow[i2]) {
                [trackNow[i1], trackNow[i2]] = [trackNow[i2], trackNow[i1]];
                extraGameUpdates.eventTrack = trackNow;
                extraGameUpdates.lastPackTinker = { by: botId, i1, i2, round: roundNum, at: Date.now() };
              }
            }
          }
        }

        tx.update(pRef, { hand, opsActionPlayedRound: roundNum });
        tx.update(gRef, {
          actionDeck,
          actionDiscard: discard,
          flagsRound,
          opsTurnIndex: nextIndex,
          opsConsecutivePasses: 0,
          ...extraGameUpdates,
        });

        logPayload = {
          round: roundNum,
          phase: "ACTIONS",
          playerId: botId,
          playerName: p.name || "BOT",
          choice: `ACTION_PLAY_${cardName}`,
          message:
            cardName === "Pack Tinker" && extraGameUpdates.lastPackTinker
              ? `BOT speelt Pack Tinker (swap ${extraGameUpdates.lastPackTinker.i1 + 1} ↔ ${extraGameUpdates.lastPackTinker.i2 + 1})`
              : cardName === "Den Signal"
              ? `BOT speelt Den Signal (DEN ${p.color || "?"} immune)`
              : cardName === "Follow the Tail"
              ? `BOT speelt Follow the Tail`
              : `BOT speelt Action Card: ${cardName}`,
        };
        return;
      }
    }

    // PASS
    const passes = Number(g.opsConsecutivePasses || 0) + 1;
    tx.update(gRef, {
      opsTurnIndex: nextIndex,
      opsConsecutivePasses: passes,
    });

    logPayload = {
      round: roundNum,
      phase: "ACTIONS",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: "ACTION_PASS",
      message: "BOT kiest PASS",
    };
  });

  if (logPayload) await logBot(gameId, logPayload);
}

// ===============================
// BOT DECISION
// ===============================
async function botDoDecision(botId) {
  const pRef = doc(db, "games", gameId, "players", botId);
  const gRef = doc(db, "games", gameId);

  let logPayload = null;

  await runTransaction(db, async (tx) => {
    const gSnap = await tx.get(gRef);
    const pSnap = await tx.get(pRef);
    if (!gSnap.exists() || !pSnap.exists()) return;

    const g = gSnap.data();
    const p = { id: pSnap.id, ...pSnap.data() };

    if (!canBotDecide(g, p)) return;

    const loot = Array.isArray(p.loot) ? p.loot : [];
    const lootPts = loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);

    const roundNum = Number(g.round || 1);
    const roosterSeen = Number(g.roosterSeen || 0);

    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

    let dashProb = 0.05 + roundNum * 0.05 + lootPts * 0.05 + roosterSeen * 0.10;
    dashProb = clamp(dashProb, 0, 0.75);

    let kind = "LURK";

    if (lootPts > 0 && Math.random() < dashProb) {
      kind = "DASH";
    } else if (!p.burrowUsed && Math.random() < 0.15) {
      kind = "BURROW";
    }

    const update = { decision: kind };
    if (kind === "BURROW" && !p.burrowUsed) update.burrowUsed = true;

    tx.update(pRef, update);

    logPayload = {
      round: g.round || 0,
      phase: "DECISION",
      playerId: botId,
      playerName: p.name || "BOT",
      choice: `DECISION_${kind}`,
      message: `BOT kiest ${kind} (dashProb=${dashProb.toFixed(2)} loot=${lootPts} rooster=${roosterSeen})`,
    };
  });

  if (logPayload) await logBot(gameId, logPayload);
}

// ===============================
// BOT TICK
// ===============================
async function runBotsOnce() {
  if (botBusy) return;

  const game = latestGame;
  if (!gameId || !game) return;
  if (game.botsEnabled !== true) return;
  if (isGameFinished(game)) return;
  if (!isActiveRaidStatus(game.status)) return;

  const bots = (latestPlayers || []).filter((p) => isBotPlayer(p));
  if (!bots.length) return;

  let workNeeded = false;

  if (game.phase === "MOVE") {
    workNeeded = bots.some((b) => canBotMove(game, b));
  } else if (game.phase === "ACTIONS") {
    const turnId = isOpsTurn(game);
    workNeeded = !!turnId && bots.some((b) => b.id === turnId);
  } else if (game.phase === "DECISION") {
    workNeeded = bots.some((b) => canBotDecide(game, b));
  } else {
    return;
  }

  if (!workNeeded) return;

  botBusy = true;
  try {
    const gotLock = await acquireBotLock();
    if (!gotLock) return;

    if (game.phase === "MOVE") {
      for (const bot of bots) {
        if (!canBotMove(game, bot)) continue;
        await botDoMove(bot.id);
      }
      return;
    }

    if (game.phase === "ACTIONS") {
      const turnId = isOpsTurn(game);
      if (!turnId) return;
      const bot = bots.find((b) => b.id === turnId);
      if (!bot) return;
      await botDoOpsTurn(bot.id);
      return;
    }

    if (game.phase === "DECISION") {
      for (const bot of bots) {
        if (!canBotDecide(game, bot)) continue;
        await botDoDecision(bot.id);
      }
    }
  } catch (err) {
    console.error("BOT error in runBotsOnce:", err);
  } finally {
    botBusy = false;
  }
}

// ===============================
// BOT-speler toevoegen aan huidige game
// ===============================
async function addBotToCurrentGame() {
  try {
    if (!gameId) {
      alert("Geen actief spel gevonden (gameId ontbreekt).");
      return;
    }

    const gSnap = await getDoc(doc(db, "games", gameId));
    if (!gSnap.exists()) return;
    const g = gSnap.data();

    const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
    const players = [];
    playersSnap.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));

    const maxJoin = players.reduce((m, p) => (typeof p.joinOrder === "number" ? Math.max(m, p.joinOrder) : m), -1);
    const joinOrder = maxJoin + 1;
    const color = DEN_COLORS[joinOrder % DEN_COLORS.length];

    let actionDeck = Array.isArray(g.actionDeck) ? [...g.actionDeck] : [];
    const hand = [];
    for (let i = 0; i < 3; i++) if (actionDeck.length) hand.push(actionDeck.pop());

    await addDoc(collection(db, "games", gameId, "players"), {
      name: `BOT Fox ${joinOrder + 1}`,
      isBot: true,
      isHost: false,
      uid: null,
      score: 0,
      joinedAt: serverTimestamp(),
      joinOrder,
      color,
      inYard: true,
      dashed: false,
      burrowUsed: false,
      decision: null,
      hand,
      loot: [],
      opsActionPlayedRound: null,
    });

    await updateDoc(doc(db, "games", gameId), { botsEnabled: true, actionDeck });

    console.log("BOT toegevoegd aan game:", gameId);
  } catch (err) {
    console.error("Fout bij BOT toevoegen:", err);
    alert("Er ging iets mis bij het toevoegen van een BOT.");
  }
}
if (addBotBtn) addBotBtn.addEventListener("click", addBotToCurrentGame);

// ===============================
// MAIN INIT
// ===============================
if (!gameId && gameInfo) {
  gameInfo.textContent = "Geen gameId in de URL";
}

initAuth(async (authUser) => {
  hostUid = authUser?.uid || null;

  if (!gameId || !gameRef || !playersColRef) return;

  startBotLoop();

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      if (gameInfo) gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    latestGame = { id: snap.id, ...game };

    currentRoundNumber = game.round || 0;
    currentPhase = game.phase || "MOVE";

    if (isGameFinished(game)) stopBotLoop();

    if (game.phase === "REVEAL" && game.currentEventId) {
      if (game.currentEventId !== lastRevealedEventId) {
        lastRevealedEventId = game.currentEventId;
        openEventPoster(game.currentEventId);
      }
    } else {
      lastRevealedEventId = null;
    }

    renderPlayerZones();

    if (startBtn) {
      startBtn.disabled = game.status === "finished" || game.raidEndedByRooster === true;
    }

    renderEventTrack(game);
    renderStatusCards(game);

    if (game.code) renderJoinQr(game);

    let extraStatus = "";
    if (game.raidEndedByRooster) extraStatus = " – Raid geëindigd door Rooster Crow (limiet bereikt)";
    if (game.status === "finished") extraStatus = extraStatus ? extraStatus + " – spel afgelopen." : " – spel afgelopen.";

    if (gameInfo) {
      gameInfo.textContent = `Code: ${game.code} – Status: ${game.status} – Ronde: ${currentRoundNumber} – Fase: ${currentPhase}${extraStatus}`;
    }

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

  onSnapshot(playersColRef, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => players.push({ id: pDoc.id, ...pDoc.data() }));
    latestPlayers = players;

    renderPlayerZones();
    scheduleBotTick();
  });

  if (!isBoardOnly) {
    const logCol = collection(db, "games", gameId, "log");
    const logQuery = query(logCol, orderBy("createdAt", "desc"), limit(10));

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
        div.textContent = `[R${e.round ?? "?"} – ${e.phase ?? "?"} – ${e.kind ?? "?"}] ${e.message ?? ""}`;
        inner.appendChild(div);
      });
      logPanel.appendChild(inner);
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
        },
        leadIndex,
      });

      await addLog(gameId, {
        round: newRound,
        phase: "MOVE",
        kind: "SYSTEM",
        message: leadName ? `Ronde ${newRound} gestart. Lead Fox: ${leadName}.` : `Ronde ${newRound} gestart.`,
      });
    });
  }

  // ==== PHASE SWITCHER ====
  if (nextPhaseBtn) {
    nextPhaseBtn.addEventListener("click", async () => {
      const snap = await getDoc(gameRef);
      if (!snap.exists()) return;
      const game = snap.data();

      const current = game.phase || "MOVE";
      const roundNumber = game.round || 0;

      if (game.status === "finished" || current === "END") {
        alert("Het spel is al afgelopen; er is geen volgende fase meer.");
        return;
      }

      if (!isActiveRaidStatus(game.status)) {
        alert("Er is geen actieve ronde in de raid.");
        return;
      }

      // MOVE -> ACTIONS
      if (current === "MOVE") {
        const active = latestPlayers.filter(isInYardForEvents);
        const mustMoveCount = active.length;
        const moved = game.movedPlayerIds || [];

        if (mustMoveCount > 0 && moved.length < mustMoveCount) {
          alert(`Niet alle vossen hebben hun MOVE gedaan (${moved.length}/${mustMoveCount}).`);
          return;
        }

        if (!active.length) {
          await updateDoc(gameRef, { phase: "DECISION" });
          await addLog(gameId, {
            round: roundNumber,
            phase: "DECISION",
            kind: "SYSTEM",
            message: "Geen actieve vossen in de Yard na MOVE – OPS wordt overgeslagen. Door naar DECISION.",
          });
          return;
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

        if (activeCount > 0 && passes < activeCount) {
          alert(`OPS-fase is nog bezig: opeenvolgende PASSes: ${passes}/${activeCount}.`);
          return;
        }

        await updateDoc(gameRef, { phase: "DECISION" });

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
          alert(`Niet alle vossen hebben een DECISION gekozen (${decided}/${active.length}).`);
          return;
        }

        const track = game.eventTrack || [];
        let eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;

        if (!track.length || eventIndex >= track.length) {
          alert("Er zijn geen events meer op de Track om te onthullen.");
          return;
        }

        const eventId = track[eventIndex];
        const ev = getEventById(eventId);

        const revealed = game.eventRevealed ? [...game.eventRevealed] : track.map(() => false);
        revealed[eventIndex] = true;

        let newRoosterSeen = game.roosterSeen || 0;
        let raidEndedByRooster = game.raidEndedByRooster || false;

        const updatePayload = {
          phase: "REVEAL",
          currentEventId: eventId,
          eventRevealed: revealed,
          eventIndex: eventIndex + 1,
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

        if (eventId === "ROOSTER_CROW") {
          await addLog(gameId, {
            round: roundNumber,
            phase: "REVEAL",
            kind: "EVENT",
            cardId: eventId,
            message: `Rooster Crow (${newRoosterSeen}/3).`,
          });
          if (raidEndedByRooster) {
            await addLog(gameId, {
              round: roundNumber,
              phase: "REVEAL",
              kind: "SYSTEM",
              message: "Derde Rooster Crow: dashers verdelen de Sack en daarna eindigt de raid.",
            });
          }
        }

        await resolveAfterReveal(gameId);
        return;
      }

      // REVEAL -> MOVE of EINDE
      if (current === "REVEAL") {
        const latestSnap = await getDoc(gameRef);
        if (!latestSnap.exists()) return;
        const latest = latestSnap.data();

        if (latest && isGameFinished(latest)) return;

        const activeAfterReveal = latestPlayers.filter(isInYardLocal);

        if (activeAfterReveal.length === 0) {
          await updateDoc(gameRef, { status: "finished", phase: "END" });

          await addLog(gameId, {
            round: roundNumber,
            phase: "END",
            kind: "SYSTEM",
            message: "Geen vossen meer in de Yard na REVEAL – de raid is afgelopen.",
          });

          return;
        }

        await updateDoc(gameRef, { phase: "MOVE" });

        await addLog(gameId, {
          round: roundNumber,
          phase: "MOVE",
          kind: "SYSTEM",
          message: "REVEAL afgerond. Terug naar MOVE-fase voor de volgende ronde.",
        });

        return;
      }
    });
  }
});
