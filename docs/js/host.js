import { initAuth } from "./firebase.js";
import { getEventById } from "./cards.js";
import { addLog } from "./log.js";
import { resolveAfterReveal } from "./engine.js";
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
const endBtn        = document.getElementById("endRoundBtn");
const nextPhaseBtn  = document.getElementById("nextPhaseBtn");
const playAsHostBtn = document.getElementById("playAsHostBtn");

// Board / zones
const eventTrackDiv   = document.getElementById("eventTrack");
const yardZone        = document.getElementById("yardZone");
const caughtZone      = document.getElementById("caughtZone");
const dashZone        = document.getElementById("dashZone");

// Status cards
const phaseCard       = document.getElementById("phaseCard");
const leadFoxCard     = document.getElementById("leadFoxCard");
const roosterCard     = document.getElementById("roosterCard");
const beaconCard      = document.getElementById("beaconCard");
const scatterCard     = document.getElementById("scatterCard");
const sackCard        = document.getElementById("sackCard");
const lootDeckCard    = document.getElementById("lootDeckCard");
const actionDeckCard  = document.getElementById("actionDeckCard");

// Fullscreen toggle
const fullscreenBtn   = document.getElementById("fullscreenBtn");
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    document.body.classList.toggle("fullscreen-board");
  });
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

// ==== Helpers: decks, event track ====

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildEventTrack() {
  // Basis-set event cards, inclusief Sheepdog Patrol en Second Charge
  const baseTrack = [
    "DEN_RED",
    "DEN_BLUE",
    "DEN_GREEN",
    "DEN_YELLOW",
    "DOG_CHARGE",
    "SHEEPDOG_PATROL",
    "SECOND_CHARGE",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
    "ROOSTER_CROW",
    "HIDDEN_NEST",
    "GATE_TOLL",
    "MAGPIE_SNITCH",
    "PAINT_BOMB_NEST",
  ];
  return shuffleArray(baseTrack);
}

function buildActionDeck() {
  const defs = [
    { name: "Molting Mask", count: 4 },
    { name: "Scent Check", count: 3 },
    { name: "Follow the Tail", count: 3 },
    { name: "Scatter!", count: 3 },
    { name: "Den Signal", count: 3 },
    { name: "Alpha Call", count: 3 },
    { name: "No-Go Zone", count: 2 },
    // Countermove wordt in deze versie niet gebruikt
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

    if (ev && ev.type) {
      slot.classList.add("event-type-" + ev.type.toLowerCase());
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
      <div class="card-sub">MOVE / ACTIONS / DECISION / REVEAL</div>
    `;
  }

  // Lead Fox – gebruik huidige global naam
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
        `<span class="rooster-dot ${
          filled ? "rooster-dot-on" : ""
        }"></span>`
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

// ==== PLAYER CARDS / ZONES ====

function createPlayerCard(p, zoneType) {
  const card = document.createElement("div");
  card.className = "card-player";

  if (currentLeadFoxId && p.id === currentLeadFoxId) {
    card.classList.add("card-player-lead");
  }

  const denColor = (p.color || "none").toLowerCase();

  const statusLabel =
    zoneType === "yard"
      ? "IN YARD"
      : zoneType === "dash"
      ? "DASHED"
      : "CAUGHT";

  const statusClass =
    zoneType === "yard"
      ? "chip-status-yard"
      : zoneType === "dash"
      ? "chip-status-dashed"
      : "chip-status-caught";

  card.innerHTML = `
    <div class="card-header">
      <span class="card-name">${p.name || "(naam onbekend)"}</span>
      <span class="card-den den-${denColor}"></span>
    </div>
    <div class="card-body">
      <div class="card-score">${p.score || 0} pts</div>
      <div class="card-tags">
        ${p.isHost ? '<span class="chip chip-host">HOST</span>' : ""}
      </div>
    </div>
    <div class="card-footer">
      <span class="chip ${statusClass}">${statusLabel}</span>
    </div>
  `;

  return card;
}

// ==== INIT RAID (eerste keer) ====

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

  let actionDeck    = buildActionDeck();
  const lootDeck    = buildLootDeck();
  const eventTrack  = buildEventTrack();
  const eventRevealed = eventTrack.map(() => false);
  const flagsRound  = {
    lockEvents: false,
    scatter: false,
    denImmune: {},
    noPeek: [],
    predictions: [],
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
      gameInfo.textContent = "Spel niet gevonden";
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

    renderEventTrack(game);
    renderStatusCards(game);

    let extraStatus = "";
    if (game.raidEndedByRooster) {
      extraStatus = " – Raid geëindigd door Rooster Crow (limiet bereikt)";
    }

    gameInfo.textContent =
      `Code: ${game.code} – Status: ${game.status} – ` +
      `Ronde: ${currentRoundNumber} – Fase: ${currentPhase}${extraStatus}`;

    if (game.status !== "round" && game.status !== "raid") {
      roundInfo.textContent = "Nog geen actieve ronde.";
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

    yardZone.innerHTML   = "";
    caughtZone.innerHTML = "";
    dashZone.innerHTML   = "";

    const labelCaught = document.createElement("div");
    labelCaught.className = "player-zone-label";
    labelCaught.textContent = "CAUGHT";
    caughtZone.appendChild(labelCaught);

    const labelDash = document.createElement("div");
    labelDash.className = "player-zone-label";
    labelDash.textContent = "DASH";
    dashZone.appendChild(labelDash);

    if (!players.length) {
      return;
    }

    // Volgorde op basis van joinOrder
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

    const activeOrdered = ordered.filter(
      (p) => p.inYard !== false && !p.dashed
    );
    const baseList = activeOrdered.length ? activeOrdered : ordered;

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

    // Update Lead Fox kaart ook meteen
    if (latestGame) {
      renderStatusCards(latestGame);
    }

    // Zet spelers in zones (met rooster-einde logica)
    ordered.forEach((p) => {
      let zoneType = "yard";

      if (latestGame && latestGame.raidEndedByRooster) {
        // Raid is geëindigd door Rooster Crow:
        // alle niet-dashers worden als CAUGHT getoond.
        if (p.dashed) zoneType = "dash";
        else zoneType = "caught";
      } else {
        if (p.dashed) zoneType = "dash";
        else if (p.inYard === false) zoneType = "caught";
        else zoneType = "yard";
      }

      const card = createPlayerCard(p, zoneType);

      if (zoneType === "yard") {
        yardZone.appendChild(card);
      } else if (zoneType === "dash") {
        dashZone.appendChild(card);
      } else {
        caughtZone.appendChild(card);
      }
    });
  });

  // ==== LOGPANEL ====
  const logCol   = collection(db, "games", gameId, "log");
  const logQuery = query(logCol, orderBy("createdAt", "desc"), limit(10));

  onSnapshot(logQuery, (snap) => {
    const entries = [];
    snap.forEach((docSnap) => entries.push(docSnap.data()));
    entries.reverse();

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
  startBtn.addEventListener("click", async () => {
    const game = await initRaidIfNeeded(gameRef);
    if (!game) return;

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

    const activeOrdered = ordered.filter(
      (p) => p.inYard !== false && !p.dashed
    );
    const baseList = activeOrdered.length ? activeOrdered : ordered;

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

  // ==== PHASE SWITCHER ====
  nextPhaseBtn.addEventListener("click", async () => {
    const snap = await getDoc(gameRef);
    if (!snap.exists()) return;
    const game = snap.data();

    const current     = game.phase || "MOVE";
    const roundNumber = game.round || 0;

    if (game.status !== "round" && game.status !== "raid") {
      alert("Er is geen actieve ronde in de raid.");
      return;
    }

    // MOVE -> ACTIONS
    if (current === "MOVE") {
      const active = latestPlayers.filter(
        (p) => p.inYard !== false && !p.dashed
      );
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
      const active = latestPlayers.filter(
        (p) => p.inYard !== false && !p.dashed
      );
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
      const active = latestPlayers.filter(
        (p) => p.inYard !== false && !p.dashed
      );
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

  // ==== OUD TEST-KNOPJE END ROUND ====
  endBtn.addEventListener("click", async () => {
    const gameSnap = await getDoc(gameRef);
    if (!gameSnap.exists()) return;
    const game = gameSnap.data();
    const roundNumber = game.round || 0;

    if (game.status !== "round" || roundNumber === 0) {
      alert("Er is geen actieve ronde om af te sluiten.");
      return;
    }

    const actionsCol = collection(db, "games", gameId, "actions");
    const actionsQuery = query(actionsCol, where("round", "==", roundNumber));
    const actionsSnap = await getDocs(actionsQuery);

    const scoreChanges = {};

    actionsSnap.forEach((aDoc) => {
      const a = aDoc.data();
      if (!a.playerId) return;
      if (a.choice === "GRAB_LOOT") {
        scoreChanges[a.playerId] = (scoreChanges[a.playerId] || 0) + 1;
      }
    });

    const playersSnap = await getDocs(playersColRef);
    const updates = [];
    playersSnap.forEach((pDoc) => {
      const p = pDoc.data();
      const delta = scoreChanges[pDoc.id] || 0;
      const newScore = (p.score || 0) + delta;
      updates.push(updateDoc(pDoc.ref, { score: newScore }));
    });

    await Promise.all(updates);

    const updatedPlayersSnap = await getDocs(playersColRef);
    const standings = [];
    updatedPlayersSnap.forEach((pDoc) => {
      const p = pDoc.data();
      standings.push(`${p.name}: ${p.score || 0}`);
    });

    await addLog(gameId, {
      round: roundNumber,
      phase: "REVEAL",
      kind: "SCORE",
      message: `Tussenstand na ronde ${roundNumber}: ${standings.join(", ")}`,
    });

    await updateDoc(gameRef, {
      status: "lobby",
    });

    alert("Ronde afgesloten en scores bijgewerkt (oude test-teller).");
  });

  // ==== Host eigen player view openen ====
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
});
