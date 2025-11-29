import { initAuth } from "./firebase.js";
import { getEventById } from "./cards.js";
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
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");

// Basis host UI
const gameInfo      = document.getElementById("gameInfo");
const roundInfo     = document.getElementById("roundInfo");
const logPanel      = document.getElementById("logPanel");
const startBtn      = document.getElementById("startRoundBtn");
const endBtn        = document.getElementById("endRoundBtn"); // oude testknop
const nextPhaseBtn  = document.getElementById("nextPhaseBtn");
const playAsHostBtn = document.getElementById("playAsHostBtn");

// Board / zones
const eventTrackDiv = document.getElementById("eventTrack");
const yardZone      = document.getElementById("yardZone");
const caughtZone    = document.getElementById("caughtZone");
const dashZone      = document.getElementById("dashZone");

// Status cards
const phaseCard      = document.getElementById("phaseCard");
const leadFoxCard    = document.getElementById("leadFoxCard");
const roosterCard    = document.getElementById("roosterCard");
const beaconCard     = document.getElementById("beaconCard");
const scatterCard    = document.getElementById("scatterCard");
const sackCard       = document.getElementById("sackCard");
const lootDeckCard   = document.getElementById("lootDeckCard");
const actionDeckCard = document.getElementById("actionDeckCard");

// Fullscreen toggle
const fullscreenBtn = document.getElementById("fullscreenBtn");
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    document.body.classList.toggle("fullscreen-board");
  });
}

// QR Join overlay / controls
const qrJoinOverlay   = document.getElementById("qrJoinOverlay");
const qrJoinLabel     = document.getElementById("qrJoinLabel");
const qrJoinContainer = document.getElementById("qrJoin");
const qrJoinToggleBtn = document.getElementById("qrJoinToggleBtn");
const qrJoinCloseBtn  = document.getElementById("qrJoinCloseBtn");

let qrInstance = null;

// Verberg oude test-knop (endBtn)
if (endBtn) {
  endBtn.style.display = "none";
}

let currentRoundNumber     = 0;
let currentRoundForActions = 0;
let currentPhase           = "MOVE";
let unsubActions           = null;

let latestPlayers          = [];
let latestGame             = null;

// Voor Lead Fox highlight & kaart
let currentLeadFoxId       = null;
let currentLeadFoxName     = "";

// Kleur-cycling voor Dens
const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];

let latestPlayersCacheForScoreboard = [];

// ==== QR: URL maken richting lobby (index.html) ====

function getJoinUrl(game) {
  if (!game || !game.code) return null;

  // Zorgt voor: https://.../vossenjacht/index.html?code=ABCD
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

// QR overlay show/hide – extra robuust (ook inline style)
if (qrJoinToggleBtn && qrJoinOverlay) {
  qrJoinToggleBtn.addEventListener("click", () => {
    qrJoinOverlay.style.display = "flex";
    qrJoinOverlay.classList.remove("hidden");
  });
}
if (qrJoinCloseBtn && qrJoinOverlay) {
  qrJoinCloseBtn.addEventListener("click", () => {
    qrJoinOverlay.style.display = "none";
    qrJoinOverlay.classList.add("hidden");
  });
}

// ==== Helpers: decks, event track ====

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Event track: precies 12 kaarten, met DOG_CHARGE altijd in de eerste helft
// en SECOND_CHARGE altijd in de tweede helft.
function buildEventTrack() {
  const others = [
    "DEN_RED",
    "DEN_BLUE",
    "DEN_GREEN",
    "DEN_YELLOW",
    "SHEEPDOG_PATROL",
    "HIDDEN_NEST",
    "GATE_TOLL",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
  ];
  const pool = shuffleArray(others);

  const track = new Array(12).fill(null);

  const firstHalfSlots  = [0, 1, 2, 3, 4, 5];
  const secondHalfSlots = [6, 7, 8, 9, 10, 11];

  const dogIndex =
    firstHalfSlots[Math.floor(Math.random() * firstHalfSlots.length)];
  const secondIndex =
    secondHalfSlots[Math.floor(Math.random() * secondHalfSlots.length)];

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
    for (let i = 0; i < def.count; i++) {
      deck.push({ name: def.name });
    }
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

// ==== Rendering – Event Track & Status Cards ====

function renderEventTrack(game) {
  if (!eventTrackDiv) return;

  const track     = game.eventTrack || [];
  const revealed  = game.eventRevealed || [];
  const currentId = game.currentEventId || null;

  eventTrackDiv.innerHTML = "";

  if (!track.length) {
    const p = document.createElement("p");
    p.textContent = game.raidStarted
      ? "Geen Event Track gevonden."
      : "Nog geen raid gestart.";
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

    // Oud: ev.type, nieuw: ev.category
    if (ev && ev.type) {
      slot.classList.add("event-type-" + ev.type.toLowerCase());
    }
    if (ev && ev.category) {
      slot.classList.add("event-cat-" + ev.category.toLowerCase());
    }

    const idx = document.createElement("div");
    idx.className = "event-slot-index";
    idx.textContent = i + 1;
    slot.appendChild(idx);

    const title = document.createElement("div");
    title.className = "event-slot-title";

    if (!isRevealed) {
      title.textContent = "EVENT";
    } else if (ev) {
      title.textContent = ev.title;
    } else {
      title.textContent = eventId;
    }

    slot.appendChild(title);
    grid.appendChild(slot);
  });

  eventTrackDiv.appendChild(grid);
}

function renderStatusCards(game) {
  // Phase
  if (phaseCard) {
    const phase = game.phase || "–";
    phaseCard.innerHTML = `
      <div class="card-title">Phase</div>
      <div class="card-value">${phase}</div>
      <div class="card-sub">MOVE / ACTIONS / DECISION / REVEAL / END</div>
    `;
  }

  // Lead Fox
  if (leadFoxCard) {
    const name = currentLeadFoxName || "–";
    leadFoxCard.innerHTML = `
      <div class="card-title">Lead Fox</div>
      <div class="card-value">${name}</div>
      <div class="card-sub">Start speler voor deze ronde</div>
    `;
  }

  // Rooster
  if (roosterCard) {
    const track         = game.eventTrack || [];
    const roosterSeen   = game.roosterSeen || 0;
    const totalRoosters =
      track.filter((id) => id === "ROOSTER_CROW").length || 3;

    const dots = [];
    for (let i = 0; i < totalRoosters; i++) {
      const filled = i < roosterSeen;
      dots.push(
        `<span class="rooster-dot ${filled ? "rooster-dot-on" : ""}"></span>`
      );
    }

    roosterCard.innerHTML = `
      <div class="card-title">Rooster</div>
      <div class="card-value">${roosterSeen} / ${totalRoosters}</div>
      <div class="card-sub">Rooster Crow events gezien</div>
      <div class="rooster-track">${dots.join("")}</div>
    `;
  }

  const flags = game.flagsRound || {};

  // Beacon
  if (beaconCard) {
    const on = !!flags.lockEvents;
    beaconCard.innerHTML = `
      <div class="card-title">Beacon</div>
      <div class="card-value">${on ? "ON" : "OFF"}</div>
      <div class="card-sub">${
        on ? "Event Track gelocked" : "Event Track vrij"
      }</div>
    `;
    beaconCard.classList.toggle("card-status-on", on);
  }

  // Scatter!
  if (scatterCard) {
    const on = !!flags.scatter;
    scatterCard.innerHTML = `
      <div class="card-title">Scatter!</div>
      <div class="card-value">${on ? "ON" : "OFF"}</div>
      <div class="card-sub">${
        on ? "Niemand mag Scouten" : "Scout toegestaan"
      }</div>
    `;
    scatterCard.classList.toggle("card-status-on", on);
  }

  // Sack
  if (sackCard) {
    const sack = Array.isArray(game.sack) ? game.sack : [];
    sackCard.innerHTML = `
      <div class="card-title">Farm Sack</div>
      <div class="card-value">${sack.length}</div>
      <div class="card-sub">Loot in de zak</div>
    `;
  }

  // Loot Deck
  if (lootDeckCard) {
    const lootDeck = Array.isArray(game.lootDeck) ? game.lootDeck : [];
    lootDeckCard.innerHTML = `
      <div class="card-title">Loot Deck</div>
      <div class="card-value">${lootDeck.length}</div>
      <div class="card-sub">Face-down buitkaarten</div>
    `;
  }

  // Action Deck
  if (actionDeckCard) {
    const actionDeck = Array.isArray(game.actionDeck)
      ? game.actionDeck
      : [];
    actionDeckCard.innerHTML = `
      <div class="card-title">Action Deck</div>
      <div class="card-value">${actionDeck.length}</div>
      <div class="card-sub">Actiekaarten stapel</div>
    `;
  }
}

// ==== EINDSCORE / SCOREBOARD ====

function renderFinalScoreboard(game) {
  if (!roundInfo) return;

  const players = [...latestPlayers];
  latestPlayersCacheForScoreboard = players;

  if (!players.length) {
    roundInfo.textContent = "Geen spelers gevonden voor het scorebord.";
    return;
  }

  const enriched = players.map((p) => {
    const eggs = p.eggs || 0;
    const hens = p.hens || 0;
    const prize = p.prize || 0;

    const baseScore = eggs + hens * 2 + prize * 3;
    const storedScore = typeof p.score === "number" ? p.score : baseScore;
    const bonus = Math.max(0, storedScore - baseScore);

    return {
      ...p,
      eggs,
      hens,
      prize,
      baseScore,
      totalScore: storedScore,
      bonus,
    };
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
  pIntro.textContent =
    "Het spel is afgelopen. Dit is de eindranglijst (Eieren, Kippen, Prize Kippen en Bonus):";
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

  let sumEggs = 0;
  let sumHens = 0;
  let sumPrize = 0;
  let sumBonus = 0;
  let sumTotal = 0;

  enriched.forEach((p, idx) => {
    const tr = document.createElement("tr");
    if (winnerIds.has(p.id)) {
      tr.classList.add("scoreboard-row-winner");
    }

    sumEggs += p.eggs;
    sumHens += p.hens;
    sumPrize += p.prize;
    sumBonus += p.bonus;
    sumTotal += p.totalScore;

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

  const tfoot = document.createElement("tfoot");
  const trTotal = document.createElement("tr");
  trTotal.innerHTML = `
    <td colspan="2">Totaal</td>
    <td>${sumEggs}</td>
    <td>${sumHens}</td>
    <td>${sumPrize}</td>
    <td>${sumBonus}</td>
    <td>${sumTotal}</td>
  `;
  tfoot.appendChild(trTotal);
  table.appendChild(tfoot);

  section.appendChild(table);

  const leaderboardSection = document.createElement("div");
  leaderboardSection.innerHTML = `
    <div class="leaderboard-title">Top 10 – hoogste scores ooit</div>
    <ul class="leaderboard-list" id="leaderboardList"></ul>
  `;
  section.appendChild(leaderboardSection);

  roundInfo.appendChild(section);

  loadLeaderboardTop10();
}

async function loadLeaderboardTop10() {
  if (!roundInfo) return;

  const listEl = roundInfo.querySelector("#leaderboardList");
  if (!listEl) return;

  listEl.innerHTML = "";

  try {
    const leaderboardCol = collection(db, "leaderboard");
    const q = query(leaderboardCol, orderBy("score", "desc"), limit(10));
    const snap = await getDocs(q);

    if (snap.empty) {
      const empty = document.createElement("li");
      empty.className = "leaderboard-empty";
      empty.textContent = "Nog geen data in het leaderboard.";
      listEl.appendChild(empty);
      return;
    }

    let rank = 1;
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const eggs = data.eggs || 0;
      const hens = data.hens || 0;
      const prize = data.prize || 0;
      const bonus = data.bonus || 0;
      const score = data.score || 0;

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
      rank += 1;
    });
  } catch (err) {
    console.error("Fout bij laden leaderboard:", err);
    const li = document.createElement("li");
    li.className = "leaderboard-empty";
    li.textContent = "Leaderboard kon niet geladen worden.";
    listEl.appendChild(li);
  }
}

// ==== INIT RAID (eerste keer) ====

function isInYardForEvents(p) {
  return p.inYard !== false && !p.dashed;
}
function isInYardLocal(p) {
  return p.inYard !== false && !p.dashed;
}

async function initRaidIfNeeded(gameRef) {
  const snap = await getDoc(gameRef);
  if (!snap.exists()) return null;
  const game = snap.data();

  if (game.raidStarted) {
    return game;
  }

  const playersCol = collection(db, "games", gameId, "players");
  const playersSnap = await getDocs(playersCol);
  const players = [];
  playersSnap.forEach((pDoc) => {
    players.push({ id: pDoc.id, ...pDoc.data() });
  });

  if (!players.length) {
    alert(
      "Geen spelers gevonden. Laat eerst spelers joinen voordat je de raid start."
    );
    return game;
  }

  const sorted = [...players].sort((a, b) => {
    const aSec = a.joinedAt && a.joinedAt.seconds ? a.joinedAt.seconds : 0;
    const bSec = b.joinedAt && b.joinedAt.seconds ? b.joinedAt.seconds : 0;
    return aSec - bSec;
  });

  let actionDeck      = buildActionDeck();
  const lootDeck      = buildLootDeck();
  const eventTrack    = buildEventTrack();
  const eventRevealed = eventTrack.map(() => false);
  const flagsRound    = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
    opsLocked: false,
    followTail: {},
    scentChecks: [],
  };

  const updates = [];

  sorted.forEach((p, index) => {
    const color = DEN_COLORS[index % DEN_COLORS.length];
    const hand = [];
    for (let k = 0; k < 3; k++) {
      if (actionDeck.length) hand.push(actionDeck.pop());
    }
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
      })
    );
  });

  const sack = [];
  if (lootDeck.length) {
    sack.push(lootDeck.pop());
  }

  const leadIndex = Math.floor(Math.random() * sorted.length);

  updates.push(
    updateDoc(gameRef, {
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
    })
  );

  await Promise.all(updates);

  await addLog(gameId, {
    round: 0,
    phase: "MOVE",
    kind: "SYSTEM",
    message:
      "Nieuwe raid gestart. Lead Fox: " + (sorted[leadIndex]?.name || ""),
  });

  const newSnap = await getDoc(gameRef);
  return newSnap.exists() ? newSnap.data() : null;
}

// Geen gameId → melding
if (!gameId && gameInfo) {
  gameInfo.textContent = "Geen gameId in de URL";
}

// ==== MAIN INIT ====

initAuth(async (authUser) => {
  if (!gameId) return;

  const gameRef       = doc(db, "games", gameId);
  const playersColRef = collection(db, "games", gameId, "players");

  // ==== GAME SNAPSHOT ====
  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      if (gameInfo) gameInfo.textContent = "Spel niet gevonden";
      return;
    }

    const game = snap.data();
    latestGame = { id: snap.id, ...game };

    currentRoundNumber = game.round || 0;
    currentPhase       = game.phase || "MOVE";

    const event =
      game.currentEventId && game.phase === "REVEAL"
        ? getEventById(game.currentEventId)
        : null;

    // Start-knop blokkeren als spel al klaar is
    if (startBtn) {
      startBtn.disabled =
        game.status === "finished" || game.raidEndedByRooster === true;
    }

    renderEventTrack(game);
    renderStatusCards(game);

    // QR-code updaten als er een game-code is
    if (game.code) {
      renderJoinQr(game);
    }

    let extraStatus = "";
    if (game.raidEndedByRooster) {
      extraStatus = " – Raid geëindigd door Rooster Crow (limiet bereikt)";
    }
    if (game.status === "finished") {
      extraStatus = extraStatus
        ? extraStatus + " – spel afgelopen."
        : " – spel afgelopen.";
    }

    if (gameInfo) {
      gameInfo.textContent =
        `Code: ${game.code} – Status: ${game.status} – ` +
        `Ronde: ${currentRoundNumber} – Fase: ${currentPhase}${extraStatus}`;
    }

    // Spel afgelopen → eindscore tonen & actions-stoppen
    if (game.status === "finished" || game.phase === "END") {
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      renderFinalScoreboard(game);
      return;
    }

    if (game.status !== "round" && game.status !== "raid") {
      if (roundInfo) {
        roundInfo.textContent = "Nog geen actieve ronde.";
      }
      if (unsubActions) {
        unsubActions();
        unsubActions = null;
      }
      return;
    }

    if (currentRoundForActions === currentRoundNumber && unsubActions) {
      return;
    }

    currentRoundForActions = currentRoundNumber;

    const actionsCol = collection(db, "games", gameId, "actions");
    const actionsQuery = query(
      actionsCol,
      where("round", "==", currentRoundForActions)
    );

    if (unsubActions) unsubActions();
    unsubActions = onSnapshot(actionsQuery, (snapActions) => {
      if (!roundInfo) return;
      roundInfo.innerHTML = "";

      const phaseLabel = currentPhase;

      if (event) {
        const h2 = document.createElement("h2");
        h2.textContent =
          `Ronde ${currentRoundForActions} – fase: ${phaseLabel}: ${event.title}`;
        const pText = document.createElement("p");
        pText.textContent = event.text;
        roundInfo.appendChild(h2);
        roundInfo.appendChild(pText);
      } else {
        const h2 = document.createElement("h2");
        h2.textContent =
          `Ronde ${currentRoundForActions} – fase: ${phaseLabel}`;
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
        line.textContent = `${a.playerName || a.playerId}: ${a.phase} – ${
          a.choice
        }`;
        list.appendChild(line);
      });
      roundInfo.appendChild(list);
    });
  });

  // ==== PLAYERS SNAPSHOT → YARD / CAUGHT / DASH ZONES ====
  onSnapshot(playersColRef, (snapshot) => {
    const players = [];
    snapshot.forEach((pDoc) => {
      players.push({ id: pDoc.id, ...pDoc.data() });
    });
    latestPlayers = players;

    if (!yardZone || !caughtZone || !dashZone) return;

    // Labels in CAUGHT en DASH bewaren
    const caughtLabel = caughtZone.querySelector(".player-zone-label");
    const dashLabel   = dashZone.querySelector(".player-zone-label");

    yardZone.innerHTML   = "";
    caughtZone.innerHTML = "";
    dashZone.innerHTML   = "";

    if (caughtLabel) caughtZone.appendChild(caughtLabel);
    if (dashLabel)   dashZone.appendChild(dashLabel);

    if (!players.length) {
      return;
    }

    const ordered = [...players].sort((a, b) => {
      const ao =
        typeof a.joinOrder === "number"
          ? a.joinOrder
          : Number.MAX_SAFE_INTEGER;
      const bo =
        typeof b.joinOrder === "number"
          ? b.joinOrder
          : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

    const activeOrdered = ordered.filter(isInYardLocal);
    const baseList = activeOrdered.length ? activeOrdered : [];

    let leadIdx =
      latestGame && typeof latestGame.leadIndex === "number"
        ? latestGame.leadIndex
        : 0;

    if (leadIdx < 0) leadIdx = 0;
    if (baseList.length) {
      leadIdx = leadIdx % baseList.length;
    }

    currentLeadFoxId = null;
    currentLeadFoxName = "";

    if (baseList.length) {
      const lf = baseList[leadIdx];
      if (lf) {
        currentLeadFoxId = lf.id;
        currentLeadFoxName = lf.name || "";
      }
    }

    if (latestGame) {
      renderStatusCards(latestGame);
    }

    ordered.forEach((p) => {
      let zoneType = "yard";

      if (latestGame && latestGame.raidEndedByRooster) {
        if (p.dashed) zoneType = "dash";
        else zoneType = "caught";
      } else {
        if (p.dashed) zoneType = "dash";
        else if (p.inYard === false) zoneType = "caught";
        else zoneType = "yard";
      }

      const isLead = currentLeadFoxId && p.id === currentLeadFoxId;

      const footerBase =
        zoneType === "yard"
          ? "IN YARD"
          : zoneType === "dash"
          ? "DASHED"
          : "CAUGHT";

      const card = renderPlayerSlotCard(p, {
        size: "medium",
        footer: footerBase,
        isLead,
      });

      if (!card) return;

      if (zoneType === "yard") {
        yardZone.appendChild(card);
      } else if (zoneType === "dash") {
        dashZone.appendChild(card);
      } else {
        caughtZone.appendChild(card);
      }
    });

    if (
      latestGame &&
      (latestGame.status === "finished" || latestGame.phase === "END")
    ) {
      renderFinalScoreboard(latestGame);
    }
  });

  // ==== LOGPANEL ====
  const logCol   = collection(db, "games", gameId, "log");
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
      div.textContent =
        `[R${e.round ?? "?"} – ${e.phase ?? "?"} – ${e.kind ?? "?"}] ${
          e.message ?? ""
        }`;
      inner.appendChild(div);
    });
    logPanel.appendChild(inner);
  });

  // ==== START ROUND (met Lead Fox rotatie) ====
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      const game = await initRaidIfNeeded(gameRef);
      if (!game) return;

      if (game.status === "finished") {
        alert(
          "Dit spel is al afgelopen. Start een nieuwe game als je opnieuw wilt spelen."
        );
        return;
      }

      if (game.raidEndedByRooster) {
        alert(
          "De raid is geëindigd door de Rooster-limiet. Er kunnen geen nieuwe rondes meer gestart worden."
        );
        return;
      }

      const previousRound = game.round || 0;
      const newRound = previousRound + 1;

      const ordered = [...latestPlayers].sort((a, b) => {
        const ao =
          typeof a.joinOrder === "number"
            ? a.joinOrder
            : Number.MAX_SAFE_INTEGER;
        const bo =
          typeof b.joinOrder === "number"
            ? b.joinOrder
            : Number.MAX_SAFE_INTEGER;
        return ao - bo;
      });

      const activeOrdered = ordered.filter(isInYardLocal);
      const baseList = activeOrdered.length ? activeOrdered : [];

      let leadIndex =
        typeof game.leadIndex === "number" ? game.leadIndex : 0;

      if (baseList.length) {
        leadIndex =
          ((leadIndex % baseList.length) + baseList.length) % baseList.length;

        if (previousRound >= 1) {
          leadIndex = (leadIndex + 1) % baseList.length;
        }
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
        message: leadName
          ? `Ronde ${newRound} gestart. Lead Fox: ${leadName}.`
          : `Ronde ${newRound} gestart.`,
      });
    });
  }

  // ==== PHASE SWITCHER ====
  if (nextPhaseBtn) {
    nextPhaseBtn.addEventListener("click", async () => {
      const snap = await getDoc(gameRef);
      if (!snap.exists()) return;
      const game = snap.data();

      const current     = game.phase || "MOVE";
      const roundNumber = game.round || 0;

      if (game.status === "finished" || current === "END") {
        alert("Het spel is al afgelopen; er is geen volgende fase meer.");
        return;
      }

      if (game.status !== "round" && game.status !== "raid") {
        alert("Er is geen actieve ronde in de raid.");
        return;
      }

      // MOVE -> ACTIONS
      if (current === "MOVE") {
        const active = latestPlayers.filter(isInYardForEvents);
        const mustMoveCount = active.length;
        const moved = game.movedPlayerIds || [];

        if (mustMoveCount > 0 && moved.length < mustMoveCount) {
          alert(
            `Niet alle vossen hebben hun MOVE gedaan (${moved.length}/${mustMoveCount}).`
          );
          return;
        }

        if (!active.length) {
          await updateDoc(gameRef, { phase: "DECISION" });
          await addLog(gameId, {
            round: roundNumber,
            phase: "DECISION",
            kind: "SYSTEM",
            message:
              "Geen actieve vossen in de Yard na MOVE – OPS wordt overgeslagen. Door naar DECISION.",
          });
          return;
        }

        const ordered = [...active].sort((a, b) => {
          const ao =
            typeof a.joinOrder === "number"
              ? a.joinOrder
              : Number.MAX_SAFE_INTEGER;
          const bo =
            typeof b.joinOrder === "number"
              ? b.joinOrder
              : Number.MAX_SAFE_INTEGER;
          return ao - bo;
        });

        const baseOrder = ordered.map((p) => p.id);

        let leadIndex =
          typeof game.leadIndex === "number" ? game.leadIndex : 0;
        if (leadIndex < 0 || leadIndex >= baseOrder.length) {
          leadIndex = 0;
        }

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
          message:
            "OPS-fase gestart. Lead Fox begint met het spelen van Action Cards of PASS.",
        });

        return;
      }

      // ACTIONS -> DECISION
      if (current === "ACTIONS") {
        const active = latestPlayers.filter(isInYardForEvents);
        const activeCount = active.length;
        const passes = game.opsConsecutivePasses || 0;

        if (activeCount > 0 && passes < activeCount) {
          alert(
            `OPS-fase is nog bezig: opeenvolgende PASSes: ${passes}/${activeCount}.`
          );
          return;
        }

        await updateDoc(gameRef, { phase: "DECISION" });

        await addLog(gameId, {
          round: roundNumber,
          phase: "DECISION",
          kind: "SYSTEM",
          message:
            "Iedereen heeft na elkaar gepast in OPS – door naar DECISION-fase.",
        });

        return;
      }

      // DECISION -> REVEAL
      if (current === "DECISION") {
        const active = latestPlayers.filter(isInYardForEvents);
        const decided = active.filter((p) => !!p.decision).length;

        if (active.length > 0 && decided < active.length) {
          alert(
            `Niet alle vossen hebben een DECISION gekozen (${decided}/${active.length}).`
          );
          return;
        }

        const track = game.eventTrack || [];
        let eventIndex =
          typeof game.eventIndex === "number" ? game.eventIndex : 0;

        if (!track.length || eventIndex >= track.length) {
          alert("Er zijn geen events meer op de Track om te onthullen.");
          return;
        }

        const eventId = track[eventIndex];
        const ev = getEventById(eventId);
        const revealed = game.eventRevealed
          ? [...game.eventRevealed]
          : track.map(() => false);
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
              message:
                "Derde Rooster Crow: dashers verdelen de Sack en daarna eindigt de raid.",
            });
          }
        }

        await resolveAfterReveal(gameId);
        return;
      }

      // REVEAL -> MOVE (volgende ronde)
      if (current === "REVEAL") {
        const latest = (await getDoc(gameRef)).data();
        if (latest && (latest.status === "finished" || latest.phase === "END")) {
          return;
        }

        await updateDoc(gameRef, { phase: "MOVE" });

        await addLog(gameId, {
          round: roundNumber,
          phase: "MOVE",
          kind: "SYSTEM",
          message:
            "REVEAL afgerond. Terug naar MOVE-fase voor de volgende ronde (of einde raid als er geen actieve vossen meer zijn).",
        });

        return;
      }
    });
  }

  // ==== Host eigen player view openen ====
  if (playAsHostBtn) {
    playAsHostBtn.addEventListener("click", async () => {
      const q = query(
        playersColRef,
        where("uid", "==", authUser.uid),
        where("isHost", "==", true)
      );

      const snap = await getDocs(q);
      if (snap.empty) {
        alert(
          "Geen host-speler gevonden. Start het spel opnieuw of join met de code."
        );
        return;
      }

      const playerDoc = snap.docs[0];
      const hostPlayerId = playerDoc.id;

      window.open(
        `player.html?game=${gameId}&player=${hostPlayerId}`,
        "_blank"
      );
    });
  }
});
