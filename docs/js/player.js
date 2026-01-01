// VOSSENJACHT player.js – nieuwe UI: fase-panels + loot-meter + Host/Coach

import {
  applyKickUpDust,
  applyPackTinker,
} from "./engine.js";

import { initAuth } from "./firebase.js";
import { renderPlayerSlotCard, renderActionCard } from "./cardRenderer.js";

// pas ./cardRenderer.js aan als jouw bestand anders heet
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
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");
const playerId = params.get("player");

// ===== DOM ELEMENTS – nieuwe player.html =====

// Header / host board
const gameStatusDiv = document.getElementById("gameStatus");
const hostStatusLine = document.getElementById("hostStatusLine");
const hostFeedbackLine = document.getElementById("hostFeedbackLine");

// Lead Fox Command Center
const leadCommandModalOverlay = document.getElementById("leadCommandModalOverlay");
const leadCommandModalClose   = document.getElementById("leadCommandModalClose");
const leadCommandContent      = document.getElementById("leadCommandContent");

// Koppeling van Action Card naam -> asset-bestand in /assets
const ACTION_CARD_IMAGES = {
  "Scatter!": "card_action_scatter.png",
  "Den Signal": "card_action_den_signal.png",
  "No-Go Zone": "card_action_no_go_zone.png",
  "Kick Up Dust": "card_action_kick_up_dust.png",
  "Burrow Beacon": "card_action_burrow_beacon.png",
  "Molting Mask": "card_action_molting_mask.png",
  "Hold Still": "card_action_hold_still.png",
  "Nose for Trouble": "card_action_nose_for_trouble.png",
  "Scent Check": "card_action_scent_check.png",
  "Follow the Tail": "card_action_follow_tail.png",
  "Alpha Call": "card_action_alpha_call.png",
  "Pack Tinker": "card_action_pack_tinker.png",
  "Mask Swap": "card_action_mask_swap.png",
};

// Hero / spelerkaart
const playerAvatarEl = document.getElementById("playerAvatar");
const playerCardArtEl = document.getElementById("playerCardArt");
const playerNameEl = document.getElementById("playerName");
const playerDenColorEl = document.getElementById("playerDenColor");
const playerStatusEl = document.getElementById("playerStatus");
const playerScoreEl = document.getElementById("playerScore");
const lootSummaryEl = document.getElementById("lootSummary");
const lootMeterEl = document.getElementById("lootMeter");
const lootMeterFillEl = lootMeterEl
  ? lootMeterEl.querySelector(".loot-meter-fill")
  : null;

// Event + scout + flags
const eventCurrentDiv = document.getElementById("eventCurrent");
const eventScoutPreviewDiv = document.getElementById("eventScoutPreview");
const specialFlagsDiv = document.getElementById("specialFlags");

// Phase panels
const phaseMovePanel = document.getElementById("phaseMovePanel");
const phaseActionsPanel = document.getElementById("phaseActionsPanel");
const phaseDecisionPanel = document.getElementById("phaseDecisionPanel");

const moveStateText = document.getElementById("moveStateText");
const actionsStateText = document.getElementById("actionsStateText");
const decisionStateText = document.getElementById("decisionStateText");

// Buttons (MOVE / DECISION / ACTIONS)
const btnSnatch = document.getElementById("btnSnatch");
const btnForage = document.getElementById("btnForage");
const btnScout = document.getElementById("btnScout");
const btnShift = document.getElementById("btnShift");

const btnLurk = document.getElementById("btnLurk");
const btnBurrow = document.getElementById("btnBurrow");
const btnDash = document.getElementById("btnDash");

const btnPass = document.getElementById("btnPass");
const btnHand = document.getElementById("btnHand");
const btnLead = document.getElementById("btnLead");
const btnHint = document.getElementById("btnHint");
const btnLoot = document.getElementById("btnLoot");

// Modals (HAND / LOOT)
const handModalOverlay = document.getElementById("handModalOverlay");
const handModalClose = document.getElementById("handModalClose");
const handCardsGrid = document.getElementById("handCardsGrid");

const lootModalOverlay = document.getElementById("lootModalOverlay");
const lootModalClose = document.getElementById("lootModalClose");
const lootCardsGrid = document.getElementById("lootCardsGrid");

/* === Simple Host Icon Mapper (DROP-IN) === */
const HOST_FILES = {
  idle_start: "host_sleeping.png",
  move_cta: "host_holdup.png",
  actions_turn: "host_thumbsup.png",
  actions_wait: "host_nowwhat_stare.png",
  decision_cta: "host_holdup.png",
  reveal: "host_nowwhat_stare.png",
  pass: "host_dontknow.png",
  success: "host_muscle_flex.png",
  scatter: "host_holdup.png",
  beacon: "host_scared_fear.png",
  ops_locked: "host_jerkmove.png",
  loot_big: "host_rich_money.png",
  caught: "host_sad_defeated.png",
  end: "host_sad_defeated.png",
};

const HOST_DEFAULT_FILE = "host_thumbsup.png";

function setHost(kind, text) {
  const statusEl = document.getElementById("hostStatusLine");
  const sticker = document.getElementById("hostSticker");
  const bar = document.getElementById("hostBar");

  if (statusEl) statusEl.textContent = text || "";

  const file = HOST_FILES[kind] || HOST_DEFAULT_FILE;
  if (sticker) {
    const fallback = `./assets/${HOST_DEFAULT_FILE}`;
    sticker.onerror = () => {
      sticker.onerror = null;
      sticker.src = fallback;
    };
    sticker.src = `./assets/${file}`;
    sticker.alt = `Host: ${kind}`;
  }
  if (bar) {
    bar.classList.remove("flash");
    void bar.offsetWidth;
    bar.classList.add("flash");
  }
}

// preload (optioneel, lichtgewicht)
(function preloadHostIcons() {
  Object.values(HOST_FILES).forEach((fn) => {
    const i = new Image();
    i.src = `./assets/${fn}`;
  });
})();

// ===== Host/Coach – onderbalk met stickers =====
const HOST_BASE = "./assets/";
const HOST_DEFAULT = "host_thumbsup.png";

export const HOST_INTENTS = {
  confirm: ["host_thumbsup.png", "host_easypeazy.png"],
  power: ["host_muscle_flex.png", "host_rich_money.png"],
  tip: [
    "host_holdup.png",
    "host_nowwhat_stare.png",
    "host_oops_nowwhat.png",
    "host_drink_coffee.png",
    "host_toldyouso.png",
    "host_difficult_sweat.png",
  ],
  warn: ["host_scared_fear.png", "host_disbelief.png", "host_jerkmove.png"],
  fail: [
    "host_sad_defeated.png",
    "host_reallysad_tears.png",
    "host_crying_tears.png",
    "host_knockedout.png",
    "host_dead.png",
    "host_discusted_flies.png",
  ],
  fun: [
    "host_lol_tears.png",
    "host_dontknow.png",
    "host_oops_saint.png",
    "host_inlove.png",
    "host_loveyou_kiss.png",
  ],
  idle: ["host_sleeping.png"],
};
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
  no_info: "fun",
};
const HOST_PRIOR = { warn: 5, fail: 5, confirm: 4, power: 4, tip: 3, fun: 2, idle: 1 };
let _hostGate = { until: 0, prior: 0 };

function pickHostSticker(intent) {
  const list = HOST_INTENTS[intent] || HOST_INTENTS.tip;
  return list[Math.floor(Math.random() * list.length)] || HOST_DEFAULT;
}

function setHostStatus(text) {
  const el = document.getElementById("hostStatusLine");
  if (el) el.textContent = text || "";
}

function setHostFeedback(text) {
  const el = document.getElementById("hostFeedbackLine");
  if (el) el.textContent = text || "";
}

// Action Cards
function getActionCardImage(card) {
  if (!card || !card.name) return null;
  const key = String(card.name).trim();
  // eventueel later ook card.art ondersteunen:
  if (card.art) return card.art;
  return ACTION_CARD_IMAGES[key] || null;
}

// Legacy shim
window.msg = function (text, kind = "status") {
  if (kind === "feedback") setHostFeedback(text);
  else setHostStatus(text);
};

function presetText(trigger) {
  const T = {
    action_success: "Lekker! Slim gespeeld.",
    action_buff: "Power-up geactiveerd.",
    loot_big: "Zak puilt uit — top!",
    need_choice: "Kies je zet…",
    pre_reveal: "Even stil — reveal komt.",
    timeout: "Koffiepauze?",
    beacon_on: "Alarm aan! Snel en stil.",
    dog_near: "Hond dichtbij — oppassen.",
    bad_map: "Kaart klopt niet…",
    paint_bomb: "Au — zak gereset.",
    caught: "Gepakt! Volgende keer anders.",
    round_lost: "Damn. Nieuwe ronde.",
    funny: "😅",
    no_info: "Geen data; gok slim.",
  };
  return T[trigger] ?? "";
}

export function ensureHostCoachMount() {
  const bar = document.getElementById("hostBar");
  const sticker = document.getElementById("hostSticker");
  const sLine = document.getElementById("hostStatusLine");
  const fLine = document.getElementById("hostFeedbackLine");
  if (!bar || !sticker || !sLine || !fLine) {
    console.warn("Host bar ontbreekt in HTML.");
  }
}

export function preloadHost() {
  const files = new Set(Object.values(HOST_INTENTS).flat());
  files.forEach((fn) => {
    const i = new Image();
    i.src = HOST_BASE + fn;
  });
}

export function hostSay(trigger, text) {
  const bar = document.getElementById("hostBar");
  const sticker = document.getElementById("hostSticker");
  const fLine = document.getElementById("hostFeedbackLine");

  const now = Date.now();
  const intent = HOST_TRIGGERS[trigger] || "tip";
  const prior = HOST_PRIOR[intent] || 1;
  if (now < _hostGate.until && prior < _hostGate.prior) return;

  if (sticker) {
    const file = pickHostSticker(intent);
    sticker.src = HOST_BASE + file;
    sticker.alt = "Host: " + intent;
  }
  if (fLine) {
    fLine.textContent = text || presetText(trigger);
  }
  if (bar) {
    bar.classList.remove("flash");
    void bar.offsetWidth;
    bar.classList.add("flash");
  }
  _hostGate = { until: now + 2000, prior };
}

function splitEventTrackByStatus(game) {
  const track = Array.isArray(game.eventTrack) ? [...game.eventTrack] : [];
  const eventIndex =
    typeof game.eventIndex === "number" ? game.eventIndex : 0;

  return {
    track,
    eventIndex,
    locked: track.slice(0, eventIndex),   // AL onthuld → LOCKED
    future: track.slice(eventIndex),      // nog dicht → FUTURE
  };
}
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Kleine init-helper voor host-balk (voor nu alleen tekst/reset)
function hostInitUI() {
  ensureHostCoachMount();
  preloadHost();

  const s = document.getElementById("hostStatusLine");
  const f = document.getElementById("hostFeedbackLine");
  if (s) s.textContent = "Wachten tot de host de raid start…";
  if (f) f.textContent = "";
}

// ===== FIRESTORE REFS / STATE =====

let gameRef = null;
let playerRef = null;

let currentGame = null;
let currentPlayer = null;

let prevGame = null;
let prevPlayer = null;

// Lead Fox cache
let cachedLeadId = null;
let cachedLeadIndex = null;

function resetLeadCache() {
  cachedLeadId = null;
  cachedLeadIndex = null;
}

async function deriveLeadIdFromIndex(game) {
  const idx = typeof game.leadIndex === "number" ? game.leadIndex : null;
  if (idx === null || idx < 0) return null;

  if (cachedLeadId && cachedLeadIndex === idx) {
    return cachedLeadId;
  }

  try {
    const players = await fetchPlayersForGame();
    const ordered = sortPlayersByJoinOrder(players);
    if (!ordered.length || idx >= ordered.length) return null;

    cachedLeadId = ordered[idx].id;
    cachedLeadIndex = idx;
    return cachedLeadId;
  } catch (err) {
    console.warn("deriveLeadIdFromIndex error", err);
    return null;
  }
}

async function resolveLeadPlayerId(game) {
  if (!game) return null;
  if (game.leadPlayerId) return game.leadPlayerId;
  if (game.leadId) return game.leadId;
  return await deriveLeadIdFromIndex(game);
}

// ===== HELPERS ROUND FLAGS / PLAYERS =====

// Hero-kaart op het spelersscherm (zelfde logica als community board)
function renderHeroAvatarCard(player, game) {
  const avatarEl = document.getElementById("playerAvatar");
  if (!avatarEl || !player) return;

  // container leegmaken
  avatarEl.innerHTML = "";

  // Bepaal of deze speler Lead Fox is (optioneel, alleen als je dat gebruikt)
  let isLead = false;
  if (game && Array.isArray(game.playersOrder)) {
    // Als je ergens een playersOrder of leadPlayerId hebt kun je dit aanpassen
    // Voor nu houden we het simpel: als player.isLead == true
    isLead = !!player.isLead;
  }

  // Gebruik dezelfde renderer als de community board
  const cardEl = renderPlayerSlotCard(
    { ...player, isLead },
    { size: "large" } // grotere kaart in het hero-vak
  );

  if (cardEl) {
    avatarEl.appendChild(cardEl);
  }
}

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
  return { ...base, ...(game?.flagsRound || {}) };
}

function isInYardLocal(p) {
  return p && p.inYard !== false && !p.dashed;
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
  const others = players.filter((p) => p.id !== playerId && isInYardLocal(p));

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

function isMyOpsTurn(game) {
  if (!game) return false;
  if (game.phase !== "ACTIONS") return false;
  const order = game.opsTurnOrder || [];
  if (!order.length) return false;
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  if (idx < 0 || idx >= order.length) return false;
  return order[idx] === playerId;
}

// ===== GAME/PLAYER SAFE HELPERS =====

function getSackTotal(g) {
  const s = g?.sack ?? g?.raid?.sack ?? g?.lootSack ?? g?.sackCards ?? 0;
  if (Array.isArray(s)) return s.length;
  if (typeof s === "number") return s;
  if (s && typeof s.total === "number") return s.total;
  return 0;
}
function getBeaconOn(g) {
  const v = g?.beaconOn ?? g?.beacon?.on ?? g?.status?.beacon ?? false;
  return v === true || v === "on" || v === 1;
}
function getRoosterCount(g) {
  return Number(g?.roosterCount ?? g?.rooster?.count ?? 0);
}
function getCaught(p) {
  return !!(p?.caught ?? p?.status?.caught);
}
function getDogPos(g) {
  return g?.dog?.pos ?? g?.guards?.dog ?? g?.sheepdog?.pos ?? null;
}
function getPlayerPos(p) {
  return p?.pos ?? p?.position ?? null;
}
function getDogDistance(game, player) {
  const d = getDogPos(game),
    p = getPlayerPos(player);
  if (!d || !p || typeof d.x !== "number" || typeof p.x !== "number")
    return null;
  return Math.abs(d.x - p.x) + Math.abs(d.y - p.y);
}

// ===== HOST HOOKS (snapshot-delta) =====

function applyHostHooks(prevGame, game, prevPlayer, player, lastEvent) {
  try {
    if (prevGame && prevGame.phase !== "REVEAL" && game?.phase === "REVEAL") {
      hostSay("pre_reveal");
    }
    if (getSackTotal(prevGame) < 8 && getSackTotal(game) >= 8) {
      hostSay("loot_big");
    }
    if (!getBeaconOn(prevGame) && getBeaconOn(game)) {
      hostSay("beacon_on");
    }
    const d = getDogDistance(game, player);
    if (d !== null && d <= 1) {
      hostSay("dog_near");
    }
    if (lastEvent && lastEvent.id === "PAINT_BOMB_NEST") {
      hostSay("paint_bomb");
    }
    if (!getCaught(prevPlayer) && getCaught(player)) {
      hostSay("caught");
    }
    if (getRoosterCount(prevGame) !== 3 && getRoosterCount(game) === 3) {
      hostSay("round_lost");
    }
  } catch (e) {
    console.warn("applyHostHooks", e);
  }
}

// ===== LOOT / SCORE HELPERS + UI =====

// Berekent altijd een score op basis van de loot in de player-doc.
// Tijdens het spel: score = punten uit loot.
// Aan het einde: als player.score hoger is (incl. sack-bonus), gebruiken we die
// en tonen we het verschil als "Loot Sack" bonus.
function calcLootStats(player) {
  if (!player) {
    return { eggs: 0, hens: 0, prize: 0, lootBonus: 0, score: 0 };
  }

  const loot = Array.isArray(player.loot) ? player.loot : [];

  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let otherPoints = 0;

  loot.forEach((card) => {
    const tRaw = card.t || card.type || "";
    const t = String(tRaw).toUpperCase();
    const v = typeof card.v === "number" ? card.v : 0;

    if (t.includes("PRIZE")) {
      // Prize Hen
      prize += 1;
    } else if (t.includes("HEN")) {
      // gewone Hen
      hens += 1;
    } else if (t.includes("EGG")) {
      eggs += 1;
    } else {
      // evt. speciale loot met eigen v-waarde
      otherPoints += v;
    }
  });

  // basispunten uit de zichtbare loot
  const pointsFromCounts = eggs + hens * 2 + prize * 3 + otherPoints;

  // score uit Firestore (wordt op het einde gezet incl. sack-bonus)
  const recordedScore =
    typeof player.score === "number" ? player.score : 0;

  // Tijdens het spel: recordedScore = 0 → we gebruiken pointsFromCounts
  // Na het spel: recordedScore >= pointsFromCounts → we nemen recordedScore
  const score = recordedScore > 0 ? recordedScore : pointsFromCounts;

  // Loot Sack bonus = alles boven de "normale" loot
  const lootBonus =
    recordedScore > pointsFromCounts
      ? recordedScore - pointsFromCounts
      : 0;

  return { eggs, hens, prize, lootBonus, score };
}

function updateLootUi(player) {
  if (!lootSummaryEl || !lootMeterFillEl) return;

  const { eggs, hens, prize, lootBonus, score } = calcLootStats(player || {});

  if (eggs === 0 && hens === 0 && prize === 0 && score === 0) {
    lootSummaryEl.textContent = "Nog geen buit verzameld.";
  } else {
    let line = `Eggs: ${eggs}  Hens: ${hens}  Prize Hens: ${prize}`;
    if (lootBonus > 0) {
      line += `  | Loot Sack: +${lootBonus}`;
    }
    lootSummaryEl.textContent = line;
  }

  // Oranje meter vult op basis van totale score
  const baseMax  = 12; // kun je later nog tunen
  const rawPct   = baseMax > 0 ? (score / baseMax) * 100 : 0;
  const meterPct = Math.max(5, Math.min(100, Math.round(rawPct)));
  lootMeterFillEl.style.width = `${meterPct}%`;

  // Score altijd tonen (dus ook midden in het spel)
  if (playerScoreEl) {
    let label = `Score: ${score} (E:${eggs} H:${hens} P:${prize}`;
    if (lootBonus > 0) label += ` +${lootBonus}`;
    label += ")";
    playerScoreEl.textContent = label;
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

// ===== PLAYER CARD ART (card_player1–5) =====

const PLAYER_CARD_FILES = [
  "card_player1.png",
  "card_player2.png",
  "card_player3.png",
  "card_player4.png",
  "card_player5.png",
];

function pickPlayerCardFile(player) {
  if (!player) return null;

  // Optioneel: expliciet veld uit Firestore gebruiken als je dat later toevoegt
  if (typeof player.cardArt === "string" && player.cardArt) {
    return player.cardArt;
  }
  if (typeof player.avatarKey === "string" && player.avatarKey) {
    return player.avatarKey;
  }

  // Anders: stabiele keuze op basis van joinOrder
  const join = typeof player.joinOrder === "number" ? player.joinOrder : 0;
  if (!PLAYER_CARD_FILES.length) return null;

  const idx = Math.abs(join) % PLAYER_CARD_FILES.length;
  return PLAYER_CARD_FILES[idx];
}

// ===== HERO CARD VISUAL (NEON + STATUS + LEAD) =====

async function updateHeroCardVisual(game, player) {
  if (!playerAvatarEl) return;

  playerAvatarEl.classList.remove(
    "den-red",
    "den-blue",
    "den-green",
    "den-yellow",
    "status-yard",
    "status-caught",
    "status-dashed",
    "is-lead-fox"
  );

  // Reset kaart-art als er (nog) geen speler is
  if (!player) {
    if (playerCardArtEl) playerCardArtEl.style.backgroundImage = "";
    return;
  }

  // Den-kleur → neon rand
  const color = (player.color || "").toUpperCase();
  if (color === "RED") playerAvatarEl.classList.add("den-red");
  else if (color === "BLUE") playerAvatarEl.classList.add("den-blue");
  else if (color === "GREEN") playerAvatarEl.classList.add("den-green");
  else if (color === "YELLOW") playerAvatarEl.classList.add("den-yellow");

  // Status → overlay op de kaart
  let statusClass = "status-yard";
  if (player.dashed) {
    statusClass = "status-dashed";
  } else if (player.inYard === false) {
    statusClass = "status-caught";
  }
  playerAvatarEl.classList.add(statusClass);

  // Lead Fox → dubbele neon
  const leadId = await resolveLeadPlayerId(game);
  if (leadId && player.id && leadId === player.id) {
    playerAvatarEl.classList.add("is-lead-fox");
  }

  // Spelerskaart-art (2:3 kaart in de avatar)
  if (playerCardArtEl) {
    const file = pickPlayerCardFile(player);
    playerCardArtEl.style.backgroundImage = file
      ? `url('./assets/${file}')`
      : "";
  }
}

// ===== UI: PHASE PANELS + GAME / EVENT RENDERING =====

function updatePhasePanels(game, player) {
  if (!phaseMovePanel || !phaseActionsPanel || !phaseDecisionPanel) return;

  phaseMovePanel.classList.remove("active");
  phaseActionsPanel.classList.remove("active");
  phaseDecisionPanel.classList.remove("active");

  if (!game) {
    setHost("idle_start", "Wachten op game-data…");
    return;
  }

  const phase = game.phase || "";
  const status = game.status || "";

  if (status === "finished" || phase === "END") {
    setHost(
      "end",
      "Raid is afgelopen – er worden geen keuzes meer gevraagd."
    );
    updateMoveButtonsState();
    updateDecisionButtonsState();
    renderHand();
    return;
  }

  if (phase === "MOVE") {
    phaseMovePanel.classList.add("active");
    if (player && canMoveNow(game, player)) {
      setHost(
        "move_cta",
        "MOVE – kies: SNATCH / FORAGE / SCOUT / SHIFT."
      );
    } else {
      setHost("actions_wait", "MOVE – je kunt nu geen MOVE doen.");
    }
  } else if (phase === "ACTIONS") {
    phaseActionsPanel.classList.add("active");
    if (player && canPlayActionNow(game, player)) {
      if (isMyOpsTurn(game)) {
        setHost(
          "actions_turn",
          "ACTIONS – jij bent aan de beurt. Speel een kaart of PASS."
        );
      } else {
        setHost("actions_wait", "ACTIONS – wacht tot je aan de beurt bent.");
      }
    } else {
      setHost("actions_wait", "ACTIONS – je doet niet (meer) mee in deze ronde.");
    }
  } else if (phase === "DECISION") {
    phaseDecisionPanel.classList.add("active");
    if (player && canDecideNow(game, player)) {
      setHost(
        "decision_cta",
        "DECISION – kies LURK / HIDE (Burrow) / DASH."
      );
    } else if (player && player.decision) {
      setHost(
        "actions_wait",
        `DECISION – jouw keuze staat al vast: ${player.decision}.`
      );
    } else {
      setHost("actions_wait", "DECISION – je doet niet mee.");
    }
  } else if (phase === "REVEAL") {
    setHost(
      "reveal",
      "REVEAL – Event wordt toegepast. Kijk mee op het grote scherm."
    );
  } else {
    setHost("idle_start", "Wacht tot de host de raid start…");
  }

  updateMoveButtonsState();
  updateDecisionButtonsState();
  renderHand();
}

function renderGame() {
  if (!currentGame || !gameStatusDiv) return;

  const g = currentGame;

  gameStatusDiv.textContent = `Code: ${g.code} – Ronde: ${
    g.round || 0
  } – Fase: ${g.phase || "?"}`;

  if (g.status === "lobby" || g.status === "new" || g.phase === "SETUP") {
    setHostStatus("Wachten tot de host de raid start…");
  } else if (g.phase === "MOVE") {
    setHostStatus("MOVE-fase – kies SNATCH / FORAGE / SCOUT / SHIFT.");
  } else if (g.phase === "ACTIONS") {
    setHostStatus(
      isMyOpsTurn(g)
        ? "ACTIONS-fase – jij bent aan de beurt. Speel een kaart of kies PASS."
        : "ACTIONS-fase – wacht tot jij aan de beurt bent."
    );
  } else if (g.phase === "DECISION") {
    setHostStatus("DECISION-fase – kies LURK / BURROW / DASH.");
  } else if (g.phase === "REVEAL") {
    setHostStatus("REVEAL – Event wordt toegepast.");
  } else if (g.status === "finished" || g.phase === "END") {
    setHostStatus(
      "Raid afgelopen – bekijk het scorebord op het Community Board."
    );
  } else {
    setHostStatus("Even geduld…");
  }

  if (g.status === "finished" || g.phase === "END") {
    setActionFeedback(
      "Het spel is afgelopen – het scorebord staat op het Community Board."
    );
    if (eventCurrentDiv)
      eventCurrentDiv.textContent =
        "Spel afgelopen. Bekijk het scorebord op het grote scherm.";
    if (eventScoutPreviewDiv) eventScoutPreviewDiv.textContent = "";
    if (specialFlagsDiv) specialFlagsDiv.innerHTML = "";

    updatePhasePanels(g, currentPlayer);
    updateHeroCardVisual(currentGame, currentPlayer);
    return;
  }

  if (g.phase !== "ACTIONS") setActionFeedback("");

  if (eventCurrentDiv) eventCurrentDiv.innerHTML = "";
  if (eventScoutPreviewDiv) eventScoutPreviewDiv.textContent = "";
  if (specialFlagsDiv) specialFlagsDiv.innerHTML = "";

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

  if (eventScoutPreviewDiv && currentPlayer && currentPlayer.scoutPeek) {
    const peek = currentPlayer.scoutPeek;
    if (peek.round === (g.round || 0)) {
      const evPeek = getEventById(peek.eventId);
      if (evPeek) {
        eventScoutPreviewDiv.textContent = `SCOUT preview (alleen voor jou): positie ${
          peek.index + 1
        } – ${evPeek.title}`;
      }
    }
  }

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
  updateHeroCardVisual(currentGame, currentPlayer);
}

function renderPlayer() {
  if (!currentPlayer) return;

  const p = currentPlayer;
  const g = currentGame || null;

  // Naam
  if (playerNameEl) {
    playerNameEl.textContent = p.name || "Onbekende vos";
  }

  // Den-kleur
  if (playerDenColorEl) {
    const color = p.color || p.denColor || p.den || "?";
    playerDenColorEl.textContent = color
      ? `Den-kleur: ${String(color).toUpperCase()}`
      : "Den-kleur onbekend";
  }

  // Status
  if (playerStatusEl) {
    const status =
      p.inYard === false
        ? "Gevangen / uit de raid"
        : p.dashed
        ? "Met buit gevlucht (DASH)"
        : "In de Yard";
    playerStatusEl.textContent = `Status: ${status}`;
  }

  // Score
  if (playerScoreEl) {
    const eggs  = p.eggs  || 0;
    const hens  = p.hens  || 0;
    const prize = p.prize || 0;
    const score = p.score || 0;
    playerScoreEl.textContent = `Score: ${score} (P:${prize} H:${hens} E:${eggs})`;
  }

  // Hero-kaart in de avatar (vaste spelerskaart per naam)
  renderHeroAvatarCard(p, g);

  // Loot-meter + samenvatting (nieuwe helper)
  if (typeof updateLootMeterAndSummary === "function") {
    updateLootMeterAndSummary(p);
  }

  // Oude helpers – alleen aanroepen als ze nog bestaan
  if (typeof updateLootUi === "function") {
    updateLootUi(p);
  }
  if (typeof updatePhasePanels === "function") {
    updatePhasePanels(currentGame, p);
  }
  if (typeof updateHeroCardVisual === "function") {
    updateHeroCardVisual(currentGame, p);
  }
}

// ===== MOVE / DECISION BUTTON STATE =====

function updateMoveButtonsState() {
  if (!btnSnatch || !btnForage || !btnScout || !btnShift || !moveStateText)
    return;

  if (!currentGame || !currentPlayer) {
    btnSnatch.disabled = true;
    btnForage.disabled = true;
    btnScout.disabled = true;
    btnShift.disabled = true;
    moveStateText.textContent = "Geen game of speler geladen.";
    return;
  }

  const g = currentGame;
  const p = currentPlayer;

  if (g.status === "finished" || g.phase === "END") {
    btnSnatch.disabled = true;
    btnForage.disabled = true;
    btnScout.disabled = true;
    btnShift.disabled = true;
    moveStateText.textContent =
      "Het spel is afgelopen – je kunt geen MOVE meer doen.";
    return;
  }

  const canMove = canMoveNow(g, p);
  const moved = g.movedPlayerIds || [];

  btnSnatch.disabled = !canMove;
  btnForage.disabled = !canMove;
  btnScout.disabled = !canMove;
  btnShift.disabled = !canMove;

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
    decisionStateText.textContent = "Je kunt nu geen DECISION kiezen.";
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
  const myTurnOverall = isMyOpsTurn(g);

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

  if (btnHand) btnHand.disabled = !canPlayOverall;

  if (g.phase !== "ACTIONS") {
    actionsStateText.textContent = `ACTIONS-fase is nu niet actief. Je hebt ${hand.length} kaart(en) klaarstaan.`;
  } else if (!canPlayOverall) {
    actionsStateText.textContent =
      "Je kunt nu geen Action Cards spelen (niet in de Yard of al DASHED).";
  } else if (!myTurnOverall) {
    actionsStateText.textContent = `Je hebt ${hand.length} kaart(en), maar het is nu niet jouw beurt.`;
  } else {
    actionsStateText.textContent = `Jij bent aan de beurt – kies een kaart via HAND of kies PASS. Je hebt ${hand.length} kaart(en).`;
  }

  if (btnPass) btnPass.disabled = !(canPlayOverall && myTurnOverall);
}

function openHandModal() {
  if (!handModalOverlay || !handCardsGrid) return;
  if (!currentGame || !currentPlayer) return;
  renderHandGrid();
  handModalOverlay.classList.remove("hidden");
}

function closeHandModal() {
  if (!handModalOverlay) return;
  handModalOverlay.classList.add("hidden");
}

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
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "hand-card-tile";

  // Gebruik de centrale renderer met je imageFront uit ACTION_DEFS
  const cardEl = renderActionCard(card, {
    size: "medium",
    noOverlay: true,      // geen extra UI-overlay erbovenop
    footer: "",           // geen "Action Card" footer
  });

  if (cardEl) {
    cardEl.classList.add("hand-card"); // zodat je bestaande CSS blijft werken
    tile.appendChild(cardEl);
  } else {
    // fallback als er iets misgaat
    const fallback = document.createElement("div");
    fallback.className = "vj-card hand-card";
    const label = document.createElement("div");
    label.className = "hand-card-label";
    label.textContent = card.name || `Kaart #${idx + 1}`;
    fallback.appendChild(label);
    tile.appendChild(fallback);
  }

  tile.addEventListener("click", () => openHandCardDetail(idx));
  handCardsGrid.appendChild(tile);
 });
}

// ===== ACTION CARD INFO (voor spelersuitleg in HAND-modal) =====

const ACTION_CARD_INFO = {
  "Scatter!": {
    choice: null,
    effect:
      "Tot het einde van deze ronde mag geen enkele vos de MOVE ‘SCOUT’ gebruiken.",
    note:
      "Gebruik deze kaart bij voorkeur voordat andere vossen hun MOVE kiezen."
  },
  "Den Signal": {
    choice: "Kies één Den-kleur: RED, BLUE, GREEN of YELLOW.",
    effect:
      "Alle vossen met die Den-kleur zijn deze ronde immuun voor vang-events vanuit de Event Track (bijv. Dog Charge).",
    note:
      "Geldt alleen voor deze ronde en alleen tegen Event-gedreven vangacties."
  },
  "No-Go Zone": {
    choice: "Kies één positie op de Event Track (bijv. 3 voor het 3e event).",
    effect:
      "Die positie wordt een No-Go Zone: niemand mag daar deze ronde op SCOUTen.",
    note:
      "Het event blijft liggen; alleen SCOUT-moves naar die positie zijn verboden."
  },
  "Kick Up Dust": {
    choice: "Geen keuze nodig; het spel kiest willekeurig twee Event-posities.",
    effect:
      "Twee Event Cards op de Event Track wisselen willekeurig van plek.",
    note:
      "Werkt niet als Burrow Beacon (Event Track gelocked) al actief is."
  },
  "Burrow Beacon": {
    choice: null,
    effect:
      "De Event Track wordt gelocked: deze ronde kan de volgorde van Events niet meer veranderen.",
    note:
      "Blokkeert o.a. SHIFT, Kick Up Dust en Pack Tinker voor de rest van de ronde."
  },
  "Molting Mask": {
    choice: null,
    effect:
      "Verander jouw Den-kleur in een andere willekeurige kleur (RED / BLUE / GREEN / YELLOW), anders dan je huidige.",
    note:
      "Vanaf nu val je onder de Den-events en Dog-/Sheepdog-effects van je nieuwe kleur, niet meer van je oude."
  },
  "Hold Still": {
    choice: null,
    effect:
      "Vanaf nu mogen deze ronde geen nieuwe Action Cards meer worden gespeeld; spelers mogen alleen nog PASS kiezen in de OPS-fase.",
    note:
      "Gebruik deze kaart als je de OPS-chaos wilt stoppen en de situatie wilt bevriezen."
  },
  "Nose for Trouble": {
    choice:
      "Kies één Event uit de lijst waarvan jij denkt dat het als volgende wordt onthuld.",
    effect:
      "Je voorspelt welk Event als volgende uitkomt. De voorspelling wordt gelogd in deze ronde.",
    note:
      "Beloning/straffen voor juiste of foute voorspellingen horen bij de uitgebreide (fysieke) spelregels of jullie huisregels."
  },
  "Scent Check": {
    choice: "Kies één andere vos die nog in de Yard zit.",
    effect:
      "Je ziet direct de huidige DECISION van die vos (LURK/BURROW/DASH of nog geen keuze). Later, zodra jij jouw DECISION kiest, krijg je opnieuw een pop-up met hun actuele keuze.",
    note:
      "Je kopieert hun keuze niet; je krijgt alleen extra informatie over hun gedrag."
  },
  "Follow the Tail": {
    choice: "Kies één andere vos die nog in de Yard zit.",
    effect:
      "Aan het einde van de DECISION-fase wordt jouw definitieve DECISION automatisch gelijk aan die van de gekozen vos.",
    note:
      "Je mag zelf een DECISION kiezen, maar bij de reveal telt uiteindelijk wat jouw ‘staart-leider’ gekozen heeft."
  },
  "Alpha Call": {
    choice: "Kies één vos als nieuwe Lead Fox.",
    effect:
      "De gekozen vos wordt de nieuwe Lead Fox (neonkaart, rol in de raid volgens jullie spelvariant).",
    note:
      "De exacte speciale rechten van de Lead Fox staan verder uitgewerkt in de spelregels."
  },
  "Pack Tinker": {
    choice:
      "Kies twee posities op de Event Track (bijv. posities 2 en 5) om te wisselen.",
    effect:
      "De Event Cards op die twee posities wisselen van plek.",
    note:
      "Werkt niet als Burrow Beacon al actief is (Event Track gelocked)."
  },
  "Mask Swap": {
    choice:
      "Geen keuze nodig; alle vossen die nog in de Yard zitten doen automatisch mee.",
    effect:
      "Alle Den-kleuren van vossen in de Yard worden gehusseld en opnieuw uitgedeeld.",
    note:
      "Je weet niet welke kleur je terugkrijgt. Vang-events kunnen hierdoor plots heel anders uitpakken."
  }
};

function getActionCardInfo(card) {
  if (!card || !card.name) return null;
  const key = String(card.name).trim();
  return ACTION_CARD_INFO[key] || null;
}

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

  const bigCard = document.createElement("div");
  bigCard.className = "vj-card hand-card hand-card-large";

  const label = document.createElement("div");
  label.className = "hand-card-label";
  label.textContent = card.name || `Kaart #${index + 1}`;
  bigCard.appendChild(label);

  const textBox = document.createElement("div");
  textBox.className = "hand-card-detail-text";

  const titleEl = document.createElement("h3");
  titleEl.textContent = card.name || "Onbekende kaart";
  textBox.appendChild(titleEl);

  const info = getActionCardInfo(card);

  if (info) {
    if (info.moment) {
      const pMoment = document.createElement("p");
      pMoment.innerHTML = `<strong>Moment:</strong> ${info.moment}`;
      textBox.appendChild(pMoment);
    }
    if (info.choice) {
      const pChoice = document.createElement("p");
      pChoice.innerHTML = `<strong>Kies:</strong> ${info.choice}`;
      textBox.appendChild(pChoice);
    }
    if (info.effect) {
      const pEffect = document.createElement("p");
      pEffect.innerHTML = `<strong>Effect:</strong> ${info.effect}`;
      textBox.appendChild(pEffect);
    }
    if (info.note) {
      const pNote = document.createElement("p");
      pNote.innerHTML = `<strong>Let op:</strong> ${info.note}`;
      textBox.appendChild(pNote);
    }
  } else {
    const descEl = document.createElement("p");
    const desc =
      card.desc ||
      card.text ||
      "Deze kaart heeft nog geen digitale beschrijving. Gebruik de fysieke spelregels of speel hem op gevoel.";
    descEl.textContent = desc;
    textBox.appendChild(descEl);
  }

  const actions = document.createElement("div");
  actions.className = "hand-card-detail-actions";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "phase-btn phase-btn-primary";
  playBtn.textContent = "Speel deze kaart";

  const canPlayNow = canPlayActionNow(g, p) && isMyOpsTurn(g);
  playBtn.disabled = !canPlayNow;

  playBtn.addEventListener("click", async () => {
    await playActionCard(index);
    closeHandModal();
  });

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "phase-btn phase-btn-secondary";
  backBtn.textContent = "Terug naar hand";
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

// Kies juiste loot-kaart art op basis van type
function getLootCardImage(card) {
  const tRaw = (card && (card.t || card.type)) || "";
  const t = String(tRaw).toUpperCase();

  if (t.includes("PRIZE")) return "card_loot_prize_hen.png";
  if (t.includes("HEN")) return "card_loot_hen.png";
  if (t.includes("EGG")) return "card_loot_egg.png";

  // geen match → gebruik placeholder uit CSS
  return null;
}

// ===== LOOT MODAL =====

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

  let loot = Array.isArray(p.loot) ? [...p.loot] : [];

  if (!loot.length) {
    const eggs = p.eggs || 0;
    const hens = p.hens || 0;
    const prize = p.prize || 0;

    if (!eggs && !hens && !prize) {
      const msg = document.createElement("p");
      msg.textContent = "Je hebt nog geen buit verzameld.";
      msg.style.fontSize = "0.85rem";
      msg.style.opacity = "0.85";
      lootCardsGrid.appendChild(msg);
      return;
    }

    if (prize > 0) loot.push({ t: "Prize Hen", v: 3, count: prize });
    if (hens > 0) loot.push({ t: "Hen", v: 2, count: hens });
    if (eggs > 0) loot.push({ t: "Egg", v: 1, count: eggs });
  }

  loot.forEach((card) => {
    const tile = document.createElement("div");
    tile.className = "loot-card-tile";

    const cardDiv = document.createElement("div");
    cardDiv.className = "vj-card loot-card";

    // Kies de juiste loot-kaart afbeelding
    const imgFile = getLootCardImage(card);
    if (imgFile) {
      cardDiv.style.backgroundImage = `url('./assets/${imgFile}')`;
    }

    const label = document.createElement("div");
    label.className = "loot-card-label";

    const type = card.t || card.type || "Loot";
    const val = card.v ?? "?";
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
  if (extra) payload.extra = extra;

  await addDoc(actionsCol, payload);

  await addLog(gameId, {
    round: game.round || 0,
    phase,
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"}: ${choice}`,
  });
}

function computeNextOpsIndex(game) {
  const order = game.opsTurnOrder || [];
  if (!order.length) return 0;
  const idx = typeof game.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  return (idx + 1) % order.length;
}

function formatChoiceForDisplay(phase, rawChoice) {
  if (!rawChoice) return "–";
  const choice = String(rawChoice);

  // DECISION_xxx
  if (phase === "DECISION" && choice.startsWith("DECISION_")) {
    const kind = choice.slice("DECISION_".length);
    if (kind === "LURK")   return "LURK – in de Yard blijven";
    if (kind === "BURROW") return "BURROW – schuilen / verstoppen";
    if (kind === "DASH")   return "DASH – met buit vluchten";
    return kind;
  }

  // MOVE_xxx
  if (phase === "MOVE" && choice.startsWith("MOVE_")) {
    if (choice.includes("SNATCH")) {
      return "SNATCH – 1 buitkaart uit de stapel";
    }
    if (choice.includes("FORAGE")) {
      const m = choice.match(/FORAGE_(\d+)/);
      const n = m ? m[1] : "?";
      return `FORAGE – ${n} Action Card(s) getrokken`;
    }
    if (choice.includes("SCOUT_")) {
      const m = choice.match(/SCOUT_(\d+)/);
      const pos = m ? m[1] : "?";
      return `SCOUT – Event op positie ${pos} bekeken`;
    }
    if (choice.includes("SHIFT_")) {
      const m = choice.match(/SHIFT_(.+)/);
      const detail = m ? m[1] : "?";
      return `SHIFT – events gewisseld (${detail})`;
    }
    return choice.slice("MOVE_".length);
  }

  // ACTION_xxx
  if (phase === "ACTIONS" && choice.startsWith("ACTION_")) {
    const name = choice.slice("ACTION_".length);
    if (name === "PASS") {
      return "PASS – geen kaart gespeeld";
    }
    return `${name} – Action Card`;
  }

  return choice;
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
  await updateDoc(gameRef, { lootDeck, movedPlayerIds: arrayUnion(playerId) });

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
  await updateDoc(gameRef, { actionDeck, movedPlayerIds: arrayUnion(playerId) });
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
    scoutPeek: { round: game.round || 0, index: idx, eventId },
  });
  await updateDoc(gameRef, { movedPlayerIds: arrayUnion(playerId) });

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

  const game   = gameSnap.data();
  const player = playerSnap.data();

  // Alleen in MOVE-fase + juiste speler
  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  // Burrow Beacon / lockEvents blokkeert elke wijziging
  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert(
      "Events zijn gelocked (Burrow Beacon). Je kunt niet meer shiften."
    );
    return;
  }

  // Gebruik dezelfde helper als bij Kick Up Dust
  const { track, eventIndex } = splitEventTrackByStatus(game);
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return;
  }

  const futureCount = track.length - eventIndex;
  if (futureCount <= 1) {
    alert(
      "SHIFT heeft geen effect – er zijn te weinig toekomstige Events om te verschuiven."
    );
    return;
  }

  const maxPos = track.length;

  const pos1Str = prompt(
    `SHIFT – eerste positie (alleen toekomstige events: ${eventIndex + 1}-${maxPos})`
  );
  if (!pos1Str) return;

  const pos2Str = prompt(
    `SHIFT – tweede positie (alleen toekomstige events: ${eventIndex + 1}-${maxPos})`
  );
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

  // blokkeren als hij een al-onthulde kaart probeert te verplaatsen
  if (i1 < eventIndex || i2 < eventIndex) {
    alert(
      `Je kunt geen Events verschuiven die al onthuld zijn. Kies alleen posities vanaf ${eventIndex + 1}.`
    );
    return;
  }

  // swap alleen future-kaarten
  [track[i1], track[i2]] = [track[i2], track[i1]];

  await updateDoc(gameRef, {
    eventTrack: track,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(
    game,
    player,
    `MOVE_SHIFT_${pos1}<->${pos2}`,
    "MOVE"
  );

  setActionFeedback(
    `SHIFT: je hebt toekomstige Events op posities ${pos1} en ${pos2} gewisseld.`
  );
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

  const update = { decision: kind };
  if (kind === "BURROW" && !player.burrowUsed) update.burrowUsed = true;

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
  setHost("success", `Kaart gespeeld: ${cardName}`);
  hostSay("action_success");

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
  setHost(
    "pass",
    "PASS – je slaat deze beurt over. Als de ronde omgaat en iemand weer een kaart speelt, kun je later opnieuw meedoen."
  );
}

// ===== CONCRETE ACTION CARD EFFECTS =====

async function playScatter(game, player) {
  const flags = mergeRoundFlags(game);
  flags.scatter = true;
  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Scatter! – niemand mag Scouten deze ronde.`,
  });
  setActionFeedback("Scatter! is actief – niemand mag Scouten deze ronde.");
  setHost("scatter", "Scatter! – niemand mag SCOUTen.");
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

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Den Signal – Den ${color} is immuun voor vang-events deze ronde.`,
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

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt No-Go Zone – Scouten op positie ${pos} is verboden.`,
  });
  setActionFeedback(
    `No-Go Zone: positie ${pos} kan deze ronde niet gescout worden.`
  );
  return true;
}

async function playKickUpDust(game, player) {
  // 1) Burrow Beacon / Hold Still etc. via flags
  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert(
      "Burrow Beacon is actief – de Event Track is gelocked en kan niet meer veranderen."
    );
    return false;
  }

  // 2) Laat de engine-helper alles doen (incl. log + locks)
  await applyKickUpDust(gameId);

  // 3) Alleen visuele / UX feedback vanuit de player-klant
  setActionFeedback(
    "Kick Up Dust: de toekomstige Event kaarten zijn door elkaar geschud. Onthulde kaarten blijven op hun plek."
  );
  return true;
}

async function playBurrowBeacon(game, player) {
  const flags = mergeRoundFlags(game);
  flags.lockEvents = true;

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Burrow Beacon – Event Track kan deze ronde niet meer veranderen.`,
  });
  setActionFeedback(
    "Burrow Beacon: de Event Track is gelocked – geen SHIFT of schudden meer deze ronde."
  );
  setHost("beacon", "Burrow Beacon – Event Track gelocked.");
  return true;
}

async function playMoltingMask(game, player) {
  const colors = ["RED", "BLUE", "GREEN", "YELLOW"];
  const current = (player.color || "").toUpperCase();
  const pool = colors.filter((c) => c !== current);
  const newColor = pool.length
    ? pool[Math.floor(Math.random() * pool.length)]
    : colors[Math.floor(Math.random() * colors.length)];

  await updateDoc(playerRef, { color: newColor });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Molting Mask – nieuwe Den kleur: ${newColor}.`,
  });
  setActionFeedback(`Molting Mask: je Den kleur is nu ${newColor}.`);
  return true;
}

async function playHoldStill(game, player) {
  const flags = mergeRoundFlags(game);
  flags.opsLocked = true;

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Hold Still – geen nieuwe Action Cards meer deze ronde, alleen PASS.`,
  });
  setActionFeedback(
    "Hold Still is actief – er mogen geen Action Cards meer gespeeld worden, alleen PASS."
  );
  setHost("ops_locked", "Hold Still – alleen PASS is toegestaan deze ronde.");
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
  preds.push({ playerId, eventId: chosenId });
  flags.predictions = preds;

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Nose for Trouble – voorspelt: ${
      ev ? ev.title : chosenId
    }.`,
  });
  setActionFeedback(
    `Nose for Trouble: je hebt "${
      ev ? ev.title : chosenId
    }" voorspeld als volgende Event.`
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
  list.push({ viewerId: playerId, targetId: target.id });
  flags.scentChecks = list;

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Scent Check op ${target.name || "een vos"}.`,
  });
  setActionFeedback(
    `Scent Check: je volgt deze ronde de beslissingen van ${
      target.name || "de gekozen vos"
    } van dichtbij.`
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

  await updateDoc(gameRef, { flagsRound: flags });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Follow the Tail en volgt de keuze van ${
      target.name || "een vos"
    }.`,
  });
  setActionFeedback(
    `Follow the Tail: jouw uiteindelijke DECISION zal gelijk zijn aan die van ${
      target.name || "de gekozen vos"
    }.`
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
    "Alpha Call – kies wie de nieuwe Lead Fox wordt:\n" +
      lines.join("\n")
  );
  if (!choiceStr) return false;
  const idx = parseInt(choiceStr, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= ordered.length) {
    alert("Ongeldige keuze.");
    return false;
  }

  await updateDoc(gameRef, { leadIndex: idx });
  resetLeadCache();

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${
      player.name || "Speler"
    } speelt Alpha Call – Lead Fox wordt nu ${
      ordered[idx].name || "een vos"
    }.`,
  });
  setActionFeedback(
    `Alpha Call: Lead Fox is nu ${
      ordered[idx].name || "de gekozen vos"
    }.`
  );
  return true;
}
async function playPackTinker(game, player) {
  // 1) Flags van deze ronde (incl. Burrow Beacon)
  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert(
      "Burrow Beacon is actief – de Event Track is gelocked en kan niet meer veranderen."
    );
    return false;
  }

  // 2) Huidige Event Track + index van al onthulde kaarten
  const track = Array.isArray(game.eventTrack) ? [...game.eventTrack] : [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return false;
  }

  const eventIndex =
    typeof game.eventIndex === "number" ? game.eventIndex : 0; 
  // alles < eventIndex = al onthuld/gelocked
  const maxPos = track.length;

  // 3) Posities vragen aan de speler
  const p1Str = prompt(
    `Pack Tinker – eerste eventpositie (1–${maxPos}). Let op: posities 1–${eventIndex} zijn al onthuld en gelocked.`
  );
  if (!p1Str) return false;

  const p2Str = prompt(
    `Pack Tinker – tweede eventpositie (1–${maxPos}). Kies opnieuw een kaart die nog gesloten ligt.`
  );
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

  // 4) EXTRA GUARD: niet aan gelockte (reeds onthulde) kaarten komen
  if (i1 < eventIndex || i2 < eventIndex) {
    alert(
      "Je kunt geen Event kaarten verschuiven die al zijn onthuld. Kies twee kaarten die nog gesloten liggen."
    );
    return false;
  }

  // 5) Laat engine.js het echte werk doen (incl. server-side safety + log)
  await applyPackTinker(gameId, i1, i2);

  // 6) Alleen UI-feedback hier
  setActionFeedback(
    `Pack Tinker: je hebt toekomstige events op posities ${pos1} en ${pos2} gewisseld.`
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
    message: `${
      player.name || "Speler"
    } speelt Mask Swap – alle Den-kleuren in de Yard worden gehusseld.`,
  });
  setActionFeedback(
    "Mask Swap: Den-kleuren van alle vossen in de Yard zijn gehusseld."
  );
  return true;
}
// ===== LEAD FOX COMMAND CENTER =====

async function renderLeadCommandCenter() {
  if (!leadCommandContent || !currentGame) return;

  leadCommandContent.innerHTML = "";

  const round = currentGame.round || 0;

  const players = await fetchPlayersForGame();
  const playerById = {};
  players.forEach((p) => {
    playerById[p.id] = p;
  });

  const actionsCol = collection(db, "games", gameId, "actions");
  const snap = await getDocs(actionsCol);

  const perPlayer = new Map();

  snap.forEach((docSnap) => {
    const d = docSnap.data() || {};
    if ((d.round || 0) !== round) return;

    const pid   = d.playerId || "unknown";
    const phase = d.phase || "";

    let bucket = perPlayer.get(pid);
    if (!bucket) {
      bucket = { moves: [], actions: [], decisions: [] };
      perPlayer.set(pid, bucket);
    }

    if (phase === "MOVE")       bucket.moves.push(d);
    else if (phase === "ACTIONS")  bucket.actions.push(d);
    else if (phase === "DECISION") bucket.decisions.push(d);
  });

  const header = document.createElement("p");
  header.className = "lead-command-subtitle";
  header.textContent = `Ronde ${round} – overzicht van alle keuzes per speler.`;
  leadCommandContent.appendChild(header);

  const orderedPlayers = sortPlayersByJoinOrder(players);

  if (!orderedPlayers.length) {
    const msg = document.createElement("p");
    msg.textContent = "Er zijn nog geen spelers gevonden.";
    msg.style.fontSize = "0.9rem";
    msg.style.opacity = "0.8";
    leadCommandContent.appendChild(msg);
    return;
  }

  orderedPlayers.forEach((p) => {
    const group = perPlayer.get(p.id) || {
      moves: [],
      actions: [],
      decisions: [],
    };

    const block = document.createElement("div");
    block.className = "lead-player-block";

    const color = (p.color || p.denColor || p.den || "").toUpperCase();
    if (color === "RED") block.classList.add("den-red");
    else if (color === "BLUE") block.classList.add("den-blue");
    else if (color === "GREEN") block.classList.add("den-green");
    else if (color === "YELLOW") block.classList.add("den-yellow");

    if (currentPlayer && p.id === currentPlayer.id) {
      block.classList.add("is-self-lead");
    }

    const headerRow = document.createElement("div");
    headerRow.className = "lead-player-header";

    const nameEl = document.createElement("div");
    nameEl.className = "lead-player-name";
    nameEl.textContent = p.name || "Vos";

    const denEl = document.createElement("div");
    denEl.className = "lead-player-denpill";
    denEl.textContent = color ? `Den ${color}` : "Den onbekend";

    headerRow.appendChild(nameEl);
    headerRow.appendChild(denEl);

    const phaseGrid = document.createElement("div");
    phaseGrid.className = "lead-phase-grid";

    function buildPhaseCol(title, phaseKey, items) {
      const col = document.createElement("div");
      col.className = "lead-phase-col";

      const tEl = document.createElement("div");
      tEl.className = "lead-phase-title";
      tEl.textContent = title;
      col.appendChild(tEl);

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "lead-phase-line lead-phase-empty";
        empty.textContent = "Nog geen keuze.";
        col.appendChild(empty);
      } else {
        items.forEach((a) => {
          const line = document.createElement("div");
          line.className = "lead-phase-line";
          line.textContent = formatChoiceForDisplay(phaseKey, a.choice);
          col.appendChild(line);
        });
      }

      return col;
    }

    phaseGrid.appendChild(
      buildPhaseCol("MOVE", "MOVE", group.moves)
    );
    phaseGrid.appendChild(
      buildPhaseCol("ACTIONS", "ACTIONS", group.actions)
    );
    phaseGrid.appendChild(
      buildPhaseCol("DECISION", "DECISION", group.decisions)
    );

    block.appendChild(headerRow);
    block.appendChild(phaseGrid);

    leadCommandContent.appendChild(block);
  });
}

async function openLeadCommandCenter() {
  if (!currentGame || !currentPlayer) {
    alert("Geen game of speler geladen.");
    return;
  }

  const leadId = await resolveLeadPlayerId(currentGame);
  if (!leadId) {
    alert("Er is nog geen Lead Fox aangewezen.");
    return;
  }

  if (leadId !== currentPlayer.id) {
    alert(
      "Alleen de Lead Fox heeft toegang tot het Command Center met alle keuzes van deze ronde."
    );
    return;
  }

  if (!leadCommandModalOverlay || !leadCommandContent) {
    alert("Command Center UI ontbreekt in de HTML.");
    return;
  }

  leadCommandModalOverlay.classList.remove("hidden");
  await renderLeadCommandCenter();
}

function closeLeadCommandCenter() {
  if (!leadCommandModalOverlay) return;
  leadCommandModalOverlay.classList.add("hidden");
}

// ===== INIT / LISTENERS =====

async function ensurePlayerDoc() {
  if (!playerRef) return;
  const snap = await getDoc(playerRef);
  if (snap.exists()) return;

  const seed = {
    name: "Vos",
    joinOrder: Date.now(),
    inYard: true,
    dashed: false,
    hand: [],
    loot: [],
    eggs: 0,
    hens: 0,
    prize: 0,
    score: 0,
    color: null,
    decision: null,
    burrowUsed: false,
  };
  await setDoc(playerRef, seed, { merge: true });
}

initAuth(async () => {
  if (!gameId || !playerId) return;

  gameRef = doc(db, "games", gameId);
  playerRef = doc(db, "games", gameId, "players", playerId);

  await ensurePlayerDoc();
  hostInitUI();

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      if (gameStatusDiv) gameStatusDiv.textContent = "Spel niet gevonden.";
      return;
    }
    const newGame = { id: snap.id, ...snap.data() };

    if (prevGame && prevGame.leadIndex !== newGame.leadIndex) {
      resetLeadCache();
    }

    applyHostHooks(prevGame, newGame, prevPlayer, currentPlayer, null);

    currentGame = newGame;
    prevGame = newGame;
    renderGame();
  });

  onSnapshot(playerRef, (snap) => {
    if (!snap.exists()) {
      if (playerNameEl) playerNameEl.textContent = "Speler niet gevonden.";
      return;
    }
    const newPlayer = { id: snap.id, ...snap.data() };

    applyHostHooks(currentGame, currentGame, prevPlayer, newPlayer, null);

    currentPlayer = newPlayer;
    prevPlayer = newPlayer;
    renderPlayer();
  });

// MOVE
  if (btnSnatch) btnSnatch.addEventListener("click", performSnatch);
  if (btnForage) btnForage.addEventListener("click", performForage);
  if (btnScout)  btnScout.addEventListener("click", performScout);
  if (btnShift)  btnShift.addEventListener("click", performShift);

  // DECISION
  if (btnLurk) {
    btnLurk.addEventListener("click", () => selectDecision("LURK"));
  }
  if (btnBurrow) {
    btnBurrow.addEventListener("click", () => selectDecision("BURROW"));
  }
  if (btnDash) {
    btnDash.addEventListener("click", () => selectDecision("DASH"));
  }

  // ACTIONS
  if (btnPass) btnPass.addEventListener("click", passAction);
  if (btnHand) btnHand.addEventListener("click", openHandModal);
  if (btnLoot) btnLoot.addEventListener("click", openLootModal);
  if (btnLead) btnLead.addEventListener("click", openLeadCommandCenter);

  if (btnHint) {
    btnHint.addEventListener("click", () => {
      alert(
        "Hint-bot volgt later. Voor nu: maximaliseer je buit zonder te lang in de Yard te blijven…"
      );
    });
  }

  // Modals sluiten
  if (handModalClose) handModalClose.addEventListener("click", closeHandModal);
  if (handModalOverlay) {
    handModalOverlay.addEventListener("click", (e) => {
      if (e.target === handModalOverlay) closeHandModal();
    });
  }
  if (lootModalClose) lootModalClose.addEventListener("click", closeLootModal);
  if (lootModalOverlay) {
    lootModalOverlay.addEventListener("click", (e) => {
      if (e.target === lootModalOverlay) closeLootModal();
    });
  }

  // LEAD Command Center modal sluiten
  if (leadCommandModalClose) {
    leadCommandModalClose.addEventListener("click", closeLeadCommandCenter);
  }
  if (leadCommandModalOverlay) {
    leadCommandModalOverlay.addEventListener("click", (e) => {
      if (e.target === leadCommandModalOverlay) {
        closeLeadCommandCenter();
      }
    });
  }
});
