// host.js — VOSSENJACHT (FULL FEATURE PARITY + AUTONOMOUS BOTS incl. Action Cards)

import { initAuth } from "./firebase.js";
import { getEventById, CARD_BACK } from "./cards.js";
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

function startBotsForGame(id) {
  if (!id) return;

  // stop vorige listeners (als je gameId wisselt bij new raid)
  if (typeof stopBots === "function") {
    stopBots();
    stopBots = null;
  }

  // start nieuwe runner (botRunner regelt zelf isBoardOnly)
  stopBots = startBotRunner({ db, gameId: id, addLog, isBoardOnly, hostUid });
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
// BOTS (moved out of host.js)
// ===============================

// 1x aanroepen zodra db + gameId bekend zijn
function initBotsOnHost() {
  if (!gameId || !db) return;

  // Start autonome bots (botRunner regelt snapshots/locks zelf)
  startBotRunner({ db, gameId, addLog, isBoardOnly });

  // Button: BOT toevoegen (maakt bot-speler aan in Firestore)
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
}

// ===============================
// MAIN INIT (clean — bots moved to botRunner.js)
// ===============================
if (!gameId && gameInfo) {
  gameInfo.textContent = "Geen gameId in de URL";
}

let hostUid = null;
let stopBots = null;

initAuth(async (authUser) => {
  hostUid = authUser?.uid || null;

  if (!gameId || !gameRef || !playersColRef) return;

  // ✅ Start autonome bots (en onthoud stop-functie)
  stopBots = startBotRunner({ db, gameId, addLog, isBoardOnly, hostUid });

  // ===============================
  // GAME SNAPSHOT
  // ===============================
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      if (gameInfo) gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    latestGame = { id: snap.id, ...game };

    currentRoundNumber = game.round || 0;
    currentPhase = game.phase || "MOVE";

    // ✅ stop bot listeners zodra game klaar is
    if (isGameFinished(game) && typeof stopBots === "function") {
      stopBots();
      stopBots = null;
    }

    // Event poster flow
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

    // Status line
    let extraStatus = "";
    if (game.raidEndedByRooster) extraStatus = " – Raid geëindigd door Rooster Crow (limiet bereikt)";
    if (game.status === "finished") extraStatus = extraStatus ? extraStatus + " – spel afgelopen." : " – spel afgelopen.";

    if (gameInfo) {
      gameInfo.textContent =
        `Code: ${game.code} – Status: ${game.status} – Ronde: ${currentRoundNumber} – Fase: ${currentPhase}${extraStatus}`;
    }

    // Finished
    if (isGameFinished(game)) {
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      renderFinalScoreboard(game);
      return;
    }

    // Not active round
    if (!isActiveRaidStatus(game.status)) {
      if (roundInfo) roundInfo.textContent = "Nog geen actieve ronde.";
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    // Round actions monitor (per round)
    if (currentRoundForActions === currentRoundNumber && unsubActions) return;
    currentRoundForActions = currentRoundNumber;

    const event =
      game.currentEventId && game.phase === "REVEAL" ? getEventById(game.currentEventId) : null;

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
  });

  // ===============================
  // LOG PANEL (host-only UI)
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
        const opsLocked = !!game.flagsRound?.opsLocked;

        if (!opsLocked && activeCount > 0 && passes < activeCount) {
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
