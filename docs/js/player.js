// VOSSENJACHT player.js – nieuwe UI: fase-panels + loot-meter + Host/Coach

// ===== IMPORTS (eerst alles) =====

// BOTS HINTS
import { getAdvisorHint } from "./bots/advisor/advisorBot.js";
import { showHint } from "./ui/hintOverlay.js";

// Engine hooks
import { applyKickUpDust, applyPackTinker } from "./engine.js";

// App helpers
import { initAuth } from "./firebase.js";
import { renderPlayerSlotCard, renderActionCard } from "./cardRenderer.js";
import { addLog } from "./log.js";
import { getEventById, getActionDefByName, getActionInfoByName } from "./cards.js";

// Firestore (alles in 1 import, nergens dubbel)
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
  query,
  where,
  orderBy,
  limit,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// ===== INIT (dan pas db/params/refs) =====
const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");
const playerId = params.get("player");

// ===== BOT STATE CACHES =====
let lastGame = null;
let lastMe = null;
let lastPlayers = [];
let lastActions = [];

// ===== EARLY STATE (avoid TDZ when listeners fire before full init) =====
let gameRef = null;
let playerRef = null;

let currentGame = null;
let currentPlayer = null;

// btnHint is read by updateHintButtonFromState() from early listeners:
let btnHint = null;

// ===== UI PULSE MEMORY (LOOT/HINT) =====
const _uiKey = (k) => `VJ_${k}_${gameId || "?"}_${playerId || "?"}`;

let _lootSeenHash = null;
let _lootCurrentHash = null;

let _hintSeenOpsHash = null;
let _hintSeenOpsRound = null;
let _hintCurrentHash = null;

function _safeLSGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function _safeLSSet(key, val) {
  try { localStorage.setItem(key, String(val ?? "")); } catch {}
}

function _fnv1aHex(str) {
  const s = String(str ?? "");
  let h = 0x811c9dc5; // 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0; // 16777619
  }
  return h.toString(16).padStart(8, "0");
}

(function initUiPulseMemoryOnce() {
  // run vroeg, maar veilig (localStorage kan geblokkeerd zijn)
  _lootSeenHash = _safeLSGet(_uiKey("lootSeenHash")) || null;
  _hintSeenOpsHash = _safeLSGet(_uiKey("hintSeenOpsHash")) || null;

  const r = _safeLSGet(_uiKey("hintSeenOpsRound"));
  const n = r != null ? Number(r) : NaN;
  _hintSeenOpsRound = Number.isFinite(n) ? n : null;
})();

async function ensureBurrowFlagForAllPlayers(gameId) {
  if (!gameId) return;

  const playersCol = collection(db, "games", gameId, "players");
  const qs = await getDocs(playersCol);

  const fixes = [];
  qs.forEach((d) => {
    const data = d.data() || {};
    if (data.burrowUsedThisRaid == null) {
      fixes.push(updateDoc(d.ref, { burrowUsedThisRaid: false }));
    }
  });

  if (fixes.length) await Promise.all(fixes);
}

// ===== BOOT =====
async function boot() {
  if (!gameId) {
    console.warn("[INIT] gameId ontbreekt in URL (?game=...)");
    return;
  }

  // ===== ACTIONS LISTENER (bots + humans schrijven hier) =====
  const actionsRef = collection(db, "games", gameId, "actions");
  const actionsQ = query(actionsRef, orderBy("createdAt", "desc"), limit(400));

  onSnapshot(
    actionsQ,
    (qs) => {
      const rows = qs.docs.map((d) => ({ id: d.id, ...d.data() }));

      lastActions = rows
        .filter((e) => String(e.phase || "").toUpperCase() === "ACTIONS")
        .map((e) => {
          const msg = typeof e.message === "string" ? e.message.trim() : "";
          const after = msg && msg.includes(":") ? msg.split(":").slice(1).join(":").trim() : msg;
          const choiceFallback = /^(MOVE|OPS|ACTION|ACTIONS|DECISION)_/i.test(after) ? after : "";
          return {
            id: e.id,
            createdAt: e.createdAt,
            round: e.round ?? e.turn ?? e.roundNo ?? e.roundIndex ?? null,
            phase: e.phase,
            kind: e.kind || e.type || null,
            playerId: e.playerId || e.actorId || e.by || e.uid || null,
            playerName: e.playerName || e.name || null,
            choice: e.choice || e.action || e.actionKey || choiceFallback,
            payload: e.payload || null,
            message: e.message || "",
          };
        })
        .filter((e) => !!e.choice && !!e.playerId);

      if (typeof updateHintButtonFromState === "function") updateHintButtonFromState();
    },
    (err) => console.warn("[actions listener] failed", err)
  );

  // ===== ensure burrow flag (1x per raid) =====
  try {
    await ensureBurrowFlagForAllPlayers(gameId);
  } catch (e) {
    console.warn("[ensureBurrowFlagForAllPlayers] failed", e);
  }

  // ===== players cache live (advisor + UI) =====
  const playersCol = collection(db, "games", gameId, "players");
  onSnapshot(playersCol, (qs) => {
    lastPlayers = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (typeof updateHintButtonFromState === "function") updateHintButtonFromState();
  });
}

boot().catch((e) => console.error("[boot] fatal", e));

// ===== DOM ELEMENTS – nieuwe player.html =====

// Header / host board
const gameStatusDiv = document.getElementById("gameStatus");
const hostStatusLine = document.getElementById("hostStatusLine");
const hostFeedbackLine = document.getElementById("hostFeedbackLine");

// ===== LEAD FOX COMMAND CENTER (LIVE, SINGLE SOURCE: /log) =====

let leadCCUnsubs = [];
let leadCCPlayers = [];
let leadCCLogs = [];

function stopLeadCommandCenterLive() {
  for (const fn of leadCCUnsubs) {
    try { if (typeof fn === "function") fn(); } catch {}
  }
  leadCCUnsubs = [];
  leadCCPlayers = [];
  leadCCLogs = [];
}

function tsToMs(t) {
  try {
    if (!t) return 0;
    if (typeof t.toMillis === "function") return t.toMillis();
    if (typeof t.seconds === "number") return t.seconds * 1000;
    return 0;
  } catch {
    return 0;
  }
}

function formatChoiceForDisplay(phaseKey, rawChoice, payload) {
  const c0 = String(rawChoice || "").trim();
  if (!c0) return "";

  // normalize prefixes
  const upper = c0.toUpperCase();
  const p = String(phaseKey || "").toUpperCase();

  function niceWords(s) {
    return String(s || "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // MOVE_*
  if (upper.startsWith("MOVE_")) {
    const kind = niceWords(c0.slice(5));
    // Scout positie in payload
    const pos =
      payload?.pos ??
      payload?.position ??
      payload?.slot ??
      payload?.index ??
      payload?.eventPos ??
      null;
    if (pos != null && String(kind).toUpperCase().startsWith("SCOUT")) {
      return `SCOUT #${pos}`;
    }
    return kind || "MOVE";
  }

  // ACTION_*
  if (upper.startsWith("ACTION_") || upper.startsWith("ACTIONS_") || upper.startsWith("OPS_")) {
    const name = c0.replace(/^(ACTIONS_|ACTION_|OPS_)/i, "");
    if (/^PASS$/i.test(name)) return "PASS";
    return niceWords(name) || "ACTION";
  }

  // DECISION_*
  if (upper.startsWith("DECISION_")) {
    const name = c0.slice(9);
    return niceWords(name) || "DECISION";
  }

  // fallback: show raw (pretty)
  return niceWords(c0);
}

function renderLeadCommandCenterUI(round, players, logs) {
  if (!leadCommandContent) return;

  leadCommandContent.innerHTML = "";

  const perPlayer = new Map();
  const targetRound = Number(round ?? 0);

  for (const d of (logs || [])) {
    const rr = Number(d?.round ?? d?.turn ?? d?.roundNo ?? d?.roundIndex ?? 0);
    if (rr !== targetRound) continue;

    const pid = d?.playerId || d?.actorId || d?.by || d?.uid || d?.player || null;
    if (!pid) continue;

    // choice: nieuw (choice/action/actionKey) of legacy message parsing
    const rawChoice =
      (typeof d?.choice === "string" && d.choice.trim()) ||
      (typeof d?.action === "string" && d.action.trim()) ||
      (typeof d?.actionKey === "string" && d.actionKey.trim()) ||
      (() => {
        const msg = typeof d?.message === "string" ? d.message.trim() : "";
        if (!msg) return "";
        const after = msg.includes(":") ? msg.split(":").slice(1).join(":").trim() : msg;
        return /^(MOVE|OPS|ACTION|ACTIONS|DECISION)_/i.test(after) ? after : "";
      })();

    if (!rawChoice) continue;

    // phase: direct, of infer uit choice
    let phase = String(d?.phase || d?.step || d?.stage || "").toUpperCase().trim();
    if (!phase) {
      if (/^MOVE_/i.test(rawChoice)) phase = "MOVE";
      else if (/^(OPS|ACTION|ACTIONS)_/i.test(rawChoice)) phase = "ACTIONS";
      else if (/^DECISION_/i.test(rawChoice)) phase = "DECISION";
    }
    if (phase === "OPS" || phase === "ACTION") phase = "ACTIONS";

    const row = { ...d, playerId: pid, choice: rawChoice, phase };

    let bucket = perPlayer.get(pid);
    if (!bucket) {
      bucket = { moves: [], actions: [], decisions: [] };
      perPlayer.set(pid, bucket);
    }

    if (phase === "MOVE") bucket.moves.push(row);
    else if (phase === "ACTIONS") bucket.actions.push(row);
    else if (phase === "DECISION") bucket.decisions.push(row);
  }

  // sort binnen buckets (oud->nieuw)
  for (const bucket of perPlayer.values()) {
    bucket.moves.sort((a, b) => (a.clientAt || a.at || tsToMs(a.createdAt)) - (b.clientAt || b.at || tsToMs(b.createdAt)));
    bucket.actions.sort((a, b) => (a.clientAt || a.at || tsToMs(a.createdAt)) - (b.clientAt || b.at || tsToMs(b.createdAt)));
    bucket.decisions.sort((a, b) => (a.clientAt || a.at || tsToMs(a.createdAt)) - (b.clientAt || b.at || tsToMs(b.createdAt)));
  }

  const header = document.createElement("p");
  header.className = "lead-command-subtitle";
  header.textContent = `Ronde ${targetRound} – overzicht van alle keuzes per speler.`;
  leadCommandContent.appendChild(header);

  const orderedPlayers = sortPlayersByJoinOrder(players || []);

  if (!orderedPlayers.length) {
    const msg = document.createElement("p");
    msg.textContent = "Er zijn nog geen spelers gevonden.";
    msg.style.fontSize = "0.9rem";
    msg.style.opacity = "0.8";
    leadCommandContent.appendChild(msg);
    return;
  }

  orderedPlayers.forEach((p) => {
    const group = perPlayer.get(p.id) || { moves: [], actions: [], decisions: [] };

    const block = document.createElement("div");
    block.className = "lead-player-block";

    const color = (p.color || p.denColor || p.den || "").toUpperCase();
    if (color === "RED") block.classList.add("den-red");
    else if (color === "BLUE") block.classList.add("den-blue");
    else if (color === "GREEN") block.classList.add("den-green");
    else if (color === "YELLOW") block.classList.add("den-yellow");

    if (currentPlayer && p.id === currentPlayer.id) block.classList.add("is-self-lead");

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
          line.textContent = formatChoiceForDisplay(phaseKey, a.choice, a.payload || null);
          col.appendChild(line);
        });
      }

      return col;
    }

    phaseGrid.appendChild(buildPhaseCol("MOVE", "MOVE", group.moves));
    phaseGrid.appendChild(buildPhaseCol("ACTIONS", "ACTIONS", group.actions));
    phaseGrid.appendChild(buildPhaseCol("DECISION", "DECISION", group.decisions));

    block.appendChild(headerRow);
    block.appendChild(phaseGrid);
    leadCommandContent.appendChild(block);
  });
}


async function ensureBurrowFlag(gameId, playerId) {
  const pRef = doc(db, "games", gameId, "players", playerId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pRef);

    // als player doc nog niet bestaat: niks doen (jouw create flow zet het dan)
    if (!snap.exists()) return;

    const data = snap.data() || {};
    if (data.burrowUsedThisRaid == null) {
      tx.update(pRef, { burrowUsedThisRaid: false });
    }
  });
}

async function applyOpsActionAndAdvanceTurn({ db, gameRef, actorId, isPass }) {
  const now = Date.now();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists()) return;

    const g = snap.data();
    if (g.phase !== "ACTIONS") return;

    const order = Array.isArray(g.opsTurnOrder) ? g.opsTurnOrder : [];
    if (!order.length) return;

    const idx = Number.isFinite(g.opsTurnIndex) ? g.opsTurnIndex : 0;
    const expected = order[idx];

    // ✅ alleen de speler die aan de beurt is mag iets doen
    if (expected !== actorId) return;

    const opsLocked = !!g.flagsRound?.opsLocked;
    const target = Number(g.opsActiveCount || order.length);
    const passesNow = Number(g.opsConsecutivePasses || 0);

    // ✅ als OPS al klaar is: blokkeer alle nieuwe acties
    if (opsLocked || passesNow >= target) return;

    const nextIdx = (idx + 1) % order.length;

    // ✅ PASS telt op, elke echte action reset de teller
    let nextPasses = isPass ? passesNow + 1 : 0;

    // ✅ clamp: nooit boven target
    if (nextPasses > target) nextPasses = target;

    const ended = nextPasses >= target;

    tx.update(gameRef, {
      opsTurnIndex: nextIdx,
      opsConsecutivePasses: nextPasses,
      ...(ended
        ? {
            flagsRound: { ...(g.flagsRound || {}), opsLocked: true }, // ✅ hard stop
            opsEndedAtMs: now,
          }
        : {}),
    });
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
    alert("Alleen de Lead Fox heeft toegang tot het Command Center met alle keuzes van deze ronde.");
    return;
  }

  if (!leadCommandModalOverlay || !leadCommandContent) {
    alert("Command Center UI ontbreekt in de HTML.");
    return;
  }

  leadCommandModalOverlay.classList.remove("hidden");

  let round = Number(currentGame?.round ?? 0);

  stopLeadCommandCenterLive();

  // 1) Players live (handig voor namen/den)
  const playersRef = collection(db, "games", gameId, "players");
  const unsubPlayers = onSnapshot(playersRef, (qs) => {
    leadCCPlayers = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLeadCommandCenterUI(Number(currentGame?.round ?? round), leadCCPlayers, leadCCLogs);
  });
  leadCCUnsubs.push(unsubPlayers);
// 2) Actions live (bots + humans)
// BotRunner schrijft keuzes naar /actions; spelers doen dat ook via logMoveAction().
const actionsCol = collection(db, "games", gameId, "actions");
const actionsQ = query(actionsCol, orderBy("createdAt", "desc"), limit(800));

const unsubActions = onSnapshot(
  actionsQ,
  (qs) => {
    leadCCLogs = qs.docs.map((d) => d.data());
    renderLeadCommandCenterUI(Number(currentGame?.round ?? round), leadCCPlayers, leadCCLogs);
  },
  (err) => {
    console.error("[LCC] actions snapshot failed", err);
    if (leadCommandContent) {
      leadCommandContent.innerHTML =
        `<p style="opacity:.8">LCC kan actions niet lezen: ${String(err?.message || err)}</p>`;
    }
  }
);

leadCCUnsubs.push(unsubActions);

}

function closeLeadCommandCenter() {
  stopLeadCommandCenterLive();
  if (!leadCommandModalOverlay) return;
  leadCommandModalOverlay.classList.add("hidden");
}

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
const lootMeterFillEl = lootMeterEl ? lootMeterEl.querySelector(".loot-meter-fill") : null;

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
  btnHint = document.getElementById("btnHint");
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
  const eventIndex = typeof game.eventIndex === "number" ? game.eventIndex : 0;
  return {
    track,
    eventIndex,
    locked: track.slice(0, eventIndex),
    future: track.slice(eventIndex),
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
// (declared earlier to avoid TDZ)
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

  avatarEl.innerHTML = "";

  let isLead = false;
  if (game && Array.isArray(game.playersOrder)) {
    isLead = !!player.isLead;
  }

  const cardEl = renderPlayerSlotCard({ ...player, isLead }, { size: "large" });
  if (cardEl) avatarEl.appendChild(cardEl);
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
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
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
  if (!d || !p || typeof d.x !== "number" || typeof p.x !== "number") return null;
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

function calcLootStats(player) {
  if (!player) return { eggs: 0, hens: 0, prize: 0, lootBonus: 0, score: 0 };

  const loot = Array.isArray(player.loot) ? player.loot : [];

  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let otherPoints = 0;

  loot.forEach((card) => {
    const tRaw = card.t || card.type || "";
    const t = String(tRaw).toUpperCase();
    const v = typeof card.v === "number" ? card.v : 0;

    if (t.includes("PRIZE")) prize += 1;
    else if (t.includes("HEN")) hens += 1;
    else if (t.includes("EGG")) eggs += 1;
    else otherPoints += v;
  });

  const pointsFromCounts = eggs + hens * 2 + prize * 3 + otherPoints;
  const recordedScore = typeof player.score === "number" ? player.score : 0;
  const score = recordedScore > 0 ? recordedScore : pointsFromCounts;

  const lootBonus = recordedScore > pointsFromCounts ? recordedScore - pointsFromCounts : 0;
  return { eggs, hens, prize, lootBonus, score };
}

function updateLootUi(player) {
  if (!lootSummaryEl || !lootMeterFillEl) return;

  const { eggs, hens, prize, lootBonus, score } = calcLootStats(player || {});

  if (eggs === 0 && hens === 0 && prize === 0 && score === 0) {
    lootSummaryEl.textContent = "Nog geen buit verzameld.";
  } else {
    let line = `Eggs: ${eggs}  Hens: ${hens}  Prize Hens: ${prize}`;
    if (lootBonus > 0) line += `  | Loot Sack: +${lootBonus}`;
    lootSummaryEl.textContent = line;
  }

  const baseMax = 12;
  const rawPct = baseMax > 0 ? (score / baseMax) * 100 : 0;
  const meterPct = Math.max(5, Math.min(100, Math.round(rawPct)));
  lootMeterFillEl.style.width = `${meterPct}%`;

  if (playerScoreEl) {
    let label = `Score: ${score} (E:${eggs} H:${hens} P:${prize}`;
    if (lootBonus > 0) label += ` +${lootBonus}`;
    label += ")";
    playerScoreEl.textContent = label;
  }
}

// ===== LOOT / HINT BUTTON UI (glow + pulse) =====
function _setBtnGlow(btn, on) {
  if (!btn) return;
  if (on) btn.classList.add("is-glow");
  else btn.classList.remove("is-glow", "is-pulse");
}

function _setBtnPulse(btn, on) {
  if (!btn) return;
  if (on) btn.classList.add("is-pulse");
  else btn.classList.remove("is-pulse");
}

function _computeLootHash(player) {
  const p = player || {};
  const stats = calcLootStats(p);
  const lootLen = Array.isArray(p.loot) ? p.loot.length : 0;
  return _fnv1aHex(`${stats.eggs}|${stats.hens}|${stats.prize}|${stats.lootBonus}|${stats.score}|${lootLen}`);
}

function _hasAnyLoot(player) {
  const p = player || {};
  const lootLen = Array.isArray(p.loot) ? p.loot.length : 0;
  const stats = calcLootStats(p);
  return lootLen > 0 || (stats.score || 0) > 0;
}

function updateLootButtonState(prevP, newP) {
  if (!btnLoot) return;

  const hasLoot = _hasAnyLoot(newP);
  _setBtnGlow(btnLoot, hasLoot);

  if (!hasLoot) {
    _lootCurrentHash = _computeLootHash(newP);
    _setBtnPulse(btnLoot, false);
    return;
  }

  const prevStats = calcLootStats(prevP || {});
  const newStats = calcLootStats(newP || {});
  const gained = (newStats.score || 0) > (prevStats.score || 0);

  _lootCurrentHash = _computeLootHash(newP);

  // Pulse alleen bij "nieuw ontvangen" (score omhoog) én nog niet gezien
  const unseen = !_lootSeenHash || _lootCurrentHash !== _lootSeenHash;
  _setBtnPulse(btnLoot, gained && unseen);
}

function markLootSeen() {
  if (!_lootCurrentHash) return;
  _lootSeenHash = _lootCurrentHash;
  _safeLSSet(_uiKey("lootSeenHash"), _lootSeenHash);
  _setBtnPulse(btnLoot, false);
  _setBtnGlow(btnLoot, _hasAnyLoot(currentPlayer));
}

function _hintHasContent(h) {
  if (!h) return false;
  if (typeof h.title === "string" && h.title.trim()) return true;
  if (Array.isArray(h.bullets) && h.bullets.filter(Boolean).length) return true;
  return false;
}

function _hintHash(h) {
  if (!h) return null;
  const title = (h.title || "").trim();
  const bullets = Array.isArray(h.bullets) ? h.bullets.filter(Boolean).join("|") : "";
  const alts = Array.isArray(h.alternatives) ? h.alternatives.map((a) => (typeof a === "string" ? a : a?.title || "")).filter(Boolean).join("|") : "";
  return _fnv1aHex(`${title}||${bullets}||${alts}`);
}

function _computeAdvisorHintSafe() {
  try {
    if (typeof getAdvisorHint !== "function") return null;
    if (!lastGame || !lastMe) return null;
    return getAdvisorHint({
      game: lastGame,
      me: lastMe,
      players: lastPlayers || [],
      actions: lastActions || [],
      profileKey: "BEGINNER_COACH",
    });
  } catch {
    return null;
  }
}

function updateHintButtonFromState() {
  if (!btnHint) btnHint = document.getElementById("btnHint");
  if (!btnHint) return;

  const g = lastGame || currentGame || null;
  const hint = _computeAdvisorHintSafe();

  // Bright als er (waarschijnlijk) een hint is
  const hasHint = _hintHasContent(hint) || (!!lastGame && !!lastMe);
  _setBtnGlow(btnHint, hasHint);

  const phase = String(g?.phase || "").toUpperCase();
  if (!g || (phase !== "OPS" && phase !== "ACTIONS")) {
    _setBtnPulse(btnHint, false);
    return;
  }

  if (!_hintHasContent(hint)) {
    _setBtnPulse(btnHint, false);
    return;
  }

  const round = Number.isFinite(Number(g.round)) ? Number(g.round) : null;
  _hintCurrentHash = _hintHash(hint);

  const roundIsNew = round != null && _hintSeenOpsRound != null ? round > _hintSeenOpsRound : false;
  const hashIsNew = !!_hintCurrentHash && (!_hintSeenOpsHash || _hintCurrentHash !== _hintSeenOpsHash);

  _setBtnPulse(btnHint, roundIsNew || hashIsNew);
}

function markHintSeenIfOps(hintObj, gameObj) {
  const g = gameObj || lastGame || null;
  const phase = String(g?.phase || "").toUpperCase();
  if (!g || (phase !== "OPS" && phase !== "ACTIONS")) return;

  const h = hintObj || _computeAdvisorHintSafe();
  if (!_hintHasContent(h)) return;

  const round = Number.isFinite(Number(g.round)) ? Number(g.round) : null;
  const hh = _hintHash(h);

  if (hh) {
    _hintSeenOpsHash = hh;
    _safeLSSet(_uiKey("hintSeenOpsHash"), _hintSeenOpsHash);
  }
  if (round != null) {
    _hintSeenOpsRound = round;
    _safeLSSet(_uiKey("hintSeenOpsRound"), String(round));
  }

  _setBtnPulse(btnHint, false);
  _setBtnGlow(btnHint, true);
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
  if (typeof player.cardArt === "string" && player.cardArt) return player.cardArt;
  if (typeof player.avatarKey === "string" && player.avatarKey) return player.avatarKey;

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

  if (!player) {
    if (playerCardArtEl) playerCardArtEl.style.backgroundImage = "";
    return;
  }

  const color = (player.color || "").toUpperCase();
  if (color === "RED") playerAvatarEl.classList.add("den-red");
  else if (color === "BLUE") playerAvatarEl.classList.add("den-blue");
  else if (color === "GREEN") playerAvatarEl.classList.add("den-green");
  else if (color === "YELLOW") playerAvatarEl.classList.add("den-yellow");

  let statusClass = "status-yard";
  if (player.dashed) statusClass = "status-dashed";
  else if (player.inYard === false) statusClass = "status-caught";
  playerAvatarEl.classList.add(statusClass);

  const leadId = await resolveLeadPlayerId(game);
  if (leadId && player.id && leadId === player.id) {
    playerAvatarEl.classList.add("is-lead-fox");
  }

  if (playerCardArtEl) {
    const file = pickPlayerCardFile(player);
    playerCardArtEl.style.backgroundImage = file ? `url('./assets/${file}')` : "";
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
    setHost("end", "Raid is afgelopen – er worden geen keuzes meer gevraagd.");
    updateMoveButtonsState();
    updateDecisionButtonsState();
    renderHand();
    return;
  }

  if (phase === "MOVE") {
    phaseMovePanel.classList.add("active");
    if (player && canMoveNow(game, player)) {
      setHost("move_cta", "MOVE – kies: SNATCH / FORAGE / SCOUT / SHIFT.");
    } else {
      setHost("actions_wait", "MOVE – je kunt nu geen MOVE doen.");
    }
  } else if (phase === "ACTIONS") {
    phaseActionsPanel.classList.add("active");
    if (player && canPlayActionNow(game, player)) {
      if (isMyOpsTurn(game)) {
        setHost("actions_turn", "ACTIONS – jij bent aan de beurt. Speel een kaart of PASS.");
      } else {
        setHost("actions_wait", "ACTIONS – wacht tot je aan de beurt bent.");
      }
    } else {
      setHost("actions_wait", "ACTIONS – je doet niet (meer) mee in deze ronde.");
    }
  } else if (phase === "DECISION") {
    phaseDecisionPanel.classList.add("active");
    if (player && canDecideNow(game, player)) {
      setHost("decision_cta", "DECISION – kies LURK / HIDE (Burrow) / DASH.");
    } else if (player && player.decision) {
      setHost("actions_wait", `DECISION – jouw keuze staat al vast: ${player.decision}.`);
    } else {
      setHost("actions_wait", "DECISION – je doet niet mee.");
    }
  } else if (phase === "REVEAL") {
    setHost("reveal", "REVEAL – Event wordt toegepast. Kijk mee op het grote scherm.");
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

  gameStatusDiv.textContent = `Code: ${g.code} – Ronde: ${g.round || 0} – Fase: ${g.phase || "?"}`;

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
    setHostStatus("Raid afgelopen – bekijk het scorebord op het Community Board.");
  } else {
    setHostStatus("Even geduld…");
  }

  if (g.status === "finished" || g.phase === "END") {
    setActionFeedback("Het spel is afgelopen – het scorebord staat op het Community Board.");
    if (eventCurrentDiv) eventCurrentDiv.textContent = "Spel afgelopen. Bekijk het scorebord op het grote scherm.";
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
    eventCurrentDiv.textContent = "Nog geen Event Card onthuld (pas zichtbaar bij REVEAL of via SCOUT).";
  }

  if (eventScoutPreviewDiv && currentPlayer && currentPlayer.scoutPeek) {
    const peek = currentPlayer.scoutPeek;
    if (peek.round === (g.round || 0)) {
      const evPeek = getEventById(peek.eventId);
      if (evPeek) {
        eventScoutPreviewDiv.textContent = `SCOUT preview (alleen voor jou): positie ${peek.index + 1} – ${evPeek.title}`;
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

  if (playerNameEl) playerNameEl.textContent = p.name || "Onbekende vos";

  if (playerDenColorEl) {
    const color = p.color || p.denColor || p.den || "?";
    playerDenColorEl.textContent = color ? `Den-kleur: ${String(color).toUpperCase()}` : "Den-kleur onbekend";
  }

  if (playerStatusEl) {
    const status =
      p.inYard === false ? "Gevangen / uit de raid" : p.dashed ? "Met buit gevlucht (DASH)" : "In de Yard";
    playerStatusEl.textContent = `Status: ${status}`;
  }

  // Score UI blijft via updateLootUi (live)
  renderHeroAvatarCard(p, g);

  if (typeof updateLootMeterAndSummary === "function") updateLootMeterAndSummary(p);
  if (typeof updateLootUi === "function") updateLootUi(p);
  if (typeof updatePhasePanels === "function") updatePhasePanels(currentGame, p);
  if (typeof updateHeroCardVisual === "function") updateHeroCardVisual(currentGame, p);
}

// ===== MOVE / DECISION BUTTON STATE =====

function updateMoveButtonsState() {
  if (!btnSnatch || !btnForage || !btnScout || !btnShift || !moveStateText) return;

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
    moveStateText.textContent = "Het spel is afgelopen – je kunt geen MOVE meer doen.";
    return;
  }

  const canMove = canMoveNow(g, p);
  const moved = g.movedPlayerIds || [];

  btnSnatch.disabled = !canMove;
  btnForage.disabled = !canMove;
  btnScout.disabled = !canMove;
  btnShift.disabled = !canMove;

  if (!canMove) {
    if (g.phase !== "MOVE") moveStateText.textContent = `Je kunt nu geen MOVE doen (fase: ${g.phase}).`;
    else if (p.inYard === false) moveStateText.textContent = "Je bent niet meer in de Yard.";
    else if (p.dashed) moveStateText.textContent = "Je hebt al DASH gekozen in een eerdere ronde.";
    else if (moved.includes(playerId)) moveStateText.textContent = "Je hebt jouw MOVE voor deze ronde al gedaan.";
    else if (g.status !== "round") moveStateText.textContent = "Er is nog geen actieve ronde.";
    else moveStateText.textContent = "Je kunt nu geen MOVE doen.";
  } else {
    moveStateText.textContent = "Je kunt één MOVE doen: SNATCH, FORAGE, SCOUT of SHIFT.";
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
    decisionStateText.textContent = "Het spel is afgelopen – geen DECISION meer nodig.";
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
    decisionStateText.textContent = "Je zit niet meer in de Yard en doet niet mee aan deze DECISION.";
    return;
  }

  if (p.dashed) {
    btnLurk.disabled = true;
    btnBurrow.disabled = true;
    btnDash.disabled = true;
    decisionStateText.textContent = "Je hebt al eerder DASH gekozen en doet niet meer mee in de Yard.";
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

  decisionStateText.textContent = can
    ? "Kies jouw DECISION: LURK, HIDE (Burrow) of DASH."
    : "Je kunt nu geen DECISION kiezen.";
}
// ===== HAND UI (ACTIONS) — REWRITE (drop-in replacement) =====

// globale (module) guard tegen dubbel klikken / dubbel submit
window.__VJ_ACTION_PLAY_IN_FLIGHT__ = window.__VJ_ACTION_PLAY_IN_FLIGHT__ || false;

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

  const canPlayOverall = typeof canPlayActionNow === "function" ? canPlayActionNow(g, p) : false;
  const myTurnOverall = typeof isMyOpsTurn === "function" ? isMyOpsTurn(g) : false;

  if (!hand.length) {
    actionsStateText.textContent =
      g.status === "finished" || g.phase === "END"
        ? "Het spel is afgelopen – je kunt geen Action Cards meer spelen."
        : "Je hebt geen Action Cards in je hand.";

    if (btnHand) btnHand.disabled = true;
    if (btnPass) btnPass.disabled = !(canPlayOverall && myTurnOverall);
    return;
  }

  // HAND knop: alleen “openen” als je überhaupt action mag spelen
  if (btnHand) btnHand.disabled = !canPlayOverall;

  if (g.phase !== "ACTIONS") {
    actionsStateText.textContent = `ACTIONS-fase is nu niet actief. Je hebt ${hand.length} kaart(en) klaarstaan.`;
  } else if (!canPlayOverall) {
    actionsStateText.textContent = "Je kunt nu geen Action Cards spelen (niet in de Yard of al DASHED).";
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

    const cardName = typeof card === "string" ? card : (card?.name || card?.id || "");

    // renderActionCard verwacht naam; fallback naar object indien nodig
    let cardEl = null;
    try {
      if (typeof renderActionCard === "function") {
        cardEl = renderActionCard(cardName || card, {
          size: "medium",
          noOverlay: true,
          footer: "",
        });
      }
    } catch (e) {
      console.warn("[HAND] renderActionCard failed:", e);
    }

    if (cardEl) {
      cardEl.classList.add("hand-card");
      tile.appendChild(cardEl);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "vj-card hand-card";
      const label = document.createElement("div");
      label.className = "hand-card-label";
      label.textContent = cardName || `Kaart #${idx + 1}`;
      fallback.appendChild(label);
      tile.appendChild(fallback);
    }

    tile.addEventListener("click", () => openHandCardDetail(idx));
    handCardsGrid.appendChild(tile);
  });
}

// ===== ACTION CARD INFO =====

function getActionCardInfo(cardOrName) {
  const name =
    typeof cardOrName === "string"
      ? cardOrName
      : (cardOrName?.name || cardOrName?.id || "");
  if (!name) return null;
  if (typeof getActionInfoByName !== "function") return null;
  return getActionInfoByName(name) || null;
}

function openHandCardDetail(index) {
  if (!handCardsGrid) return;
  if (!currentGame || !currentPlayer) return;

  const g = currentGame;
  const p = currentPlayer;

  const hand = Array.isArray(p.hand) ? p.hand : [];
  if (index < 0 || index >= hand.length) return;

  const card = hand[index];
  const cardName = typeof card === "string" ? card : (card?.name || card?.id || "");

  handCardsGrid.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "hand-card-detail";

  const bigCard = document.createElement("div");
  bigCard.className = "vj-card hand-card hand-card-large";

  const def =
    cardName && typeof getActionDefByName === "function"
      ? getActionDefByName(cardName)
      : null;
  if (def?.imageFront) bigCard.style.backgroundImage = `url('${def.imageFront}')`;

  const label = document.createElement("div");
  label.className = "hand-card-label";
  label.textContent = def?.name || cardName || `Kaart #${index + 1}`;
  bigCard.appendChild(label);

  const textBox = document.createElement("div");
  textBox.className = "hand-card-detail-text";

  const titleEl = document.createElement("h3");
  titleEl.textContent = def?.name || cardName || "Onbekende kaart";
  textBox.appendChild(titleEl);

  const info = getActionCardInfo(cardName);

  if (def?.phase || def?.timing) {
    const pMoment = document.createElement("p");
    const phaseTxt = def?.phase ? String(def.phase) : "";
    const timingTxt = def?.timing ? String(def.timing) : "";
    const joined = [phaseTxt, timingTxt].filter(Boolean).join(" • ");
    pMoment.innerHTML = `<strong>Moment:</strong> ${joined}`;
    textBox.appendChild(pMoment);
  }

  if (info) {
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
    descEl.textContent =
      def?.description ||
      (typeof card === "object" && (card?.desc || card?.text)) ||
      "Deze kaart heeft nog geen digitale beschrijving.";
    textBox.appendChild(descEl);
  }

  const actions = document.createElement("div");
  actions.className = "hand-card-detail-actions";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "phase-btn phase-btn-primary";
  playBtn.textContent = "Speel deze kaart";

  const canPlayNow =
    (typeof canPlayActionNow === "function" ? canPlayActionNow(g, p) : false) &&
    (typeof isMyOpsTurn === "function" ? isMyOpsTurn(g) : false);

  const opsLocked = !!(g?.flagsRound?.opsLocked);

  // ook blokkeren als er al een submit “in flight” is
  playBtn.disabled = !canPlayNow || opsLocked || window.__VJ_ACTION_PLAY_IN_FLIGHT__ === true;

  playBtn.addEventListener("click", async () => {
    // hard guard tegen dubbel klikken
    if (window.__VJ_ACTION_PLAY_IN_FLIGHT__ === true) return;
    window.__VJ_ACTION_PLAY_IN_FLIGHT__ = true;

    // direct UI lock zodat de gebruiker feedback heeft
    playBtn.disabled = true;

    try {
      if (typeof playActionCard !== "function") {
        alert("playActionCard() staat later in player.js — niet gevonden.");
        return;
      }

      // ✅ wijziging: alleen sluiten als kaart ECHT gespeeld is
      // (playActionCard moet boolean returnen: true=gespeeld, false=niet gespeeld)
      const ok = await playActionCard(index);

      if (ok === true) {
        closeHandModal();
        return;
      }

      // niet gespeeld → overlay open houden en opnieuw syncen
      if (handModalOverlay && !handModalOverlay.classList.contains("hidden")) {
        // terug naar grid is meestal de prettigste UX
        renderHandGrid();
      }
    } catch (err) {
      console.error("[HAND] playActionCard error:", err);
      alert("Er ging iets mis bij het spelen van de kaart. Probeer opnieuw.");
      // overlay blijft open zodat speler opnieuw kan proberen
    } finally {
      // unlock na een korte tick zodat Firestore updates kunnen binnenkomen
      setTimeout(() => {
        window.__VJ_ACTION_PLAY_IN_FLIGHT__ = false;

        // als overlay nog open is: knopstatus opnieuw bepalen
        if (handModalOverlay && !handModalOverlay.classList.contains("hidden")) {
          const g2 = currentGame;
          const p2 = currentPlayer;
          const canPlayNow2 =
            (typeof canPlayActionNow === "function" ? canPlayActionNow(g2, p2) : false) &&
            (typeof isMyOpsTurn === "function" ? isMyOpsTurn(g2) : false);
          const opsLocked2 = !!(g2?.flagsRound?.opsLocked);
          playBtn.disabled = !canPlayNow2 || opsLocked2;
        }

        renderHand?.(); // update buttons + state text
      }, 200);
    }
  });

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "phase-btn phase-btn-secondary";
  backBtn.textContent = "Terug naar hand";
  backBtn.addEventListener("click", () => renderHandGrid());

  actions.appendChild(playBtn);
  actions.appendChild(backBtn);

  wrapper.appendChild(bigCard);
  wrapper.appendChild(textBox);
  wrapper.appendChild(actions);

  handCardsGrid.appendChild(wrapper);
}

// ===== LOOT MODAL =====

function getLootCardImage(card) {
  const tRaw = (card && (card.t || card.type)) || "";
  const t = String(tRaw).toUpperCase();
  if (t.includes("PRIZE")) return "card_loot_prize_hen.png";
  if (t.includes("HEN")) return "card_loot_hen.png";
  if (t.includes("EGG")) return "card_loot_egg.png";
  return null;
}

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

    const imgFile = getLootCardImage(card);
    if (imgFile) cardDiv.style.backgroundImage = `url('./assets/${imgFile}')`;

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

// ==========================================
// Advisor Hint Overlay — LEAD overlay stijl (PLAYER COMPACT + WHY THIS FULL)
// ==========================================

(() => {
  if (window.__advisorOverlayLoaded_v3) return;
  window.__advisorOverlayLoaded_v3 = true;

  let _advisorOverlay = null;
  let _advisorPanel = null;
  let _wired = false;

  function safeArr(x) { return Array.isArray(x) ? x : []; }
  function normLines(arr) {
    return safeArr(arr).map((x) => String(x ?? "").trim()).filter(Boolean);
  }

  function pct01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.max(0, Math.min(1, n)) * 100);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ---- Mini pills bovenaan (kort, mag blijven)
  function buildMiniPills(ctx) {
    const me = ctx?.me || {};
    const pills = [];

    const inYard = me.inYard !== false && !me.dashed;
    const caught = me.inYard === false;
    const dashed = !!me.dashed;

    let score = 0;
    try {
      if (typeof calcLootStats === "function") {
        const s = calcLootStats(me);
        score = Number(s?.score) || 0;
      }
    } catch (_) {}

    pills.push({ cls: inYard ? "safe" : "danger", text: `Yard: ${inYard ? "YES" : "NO"}` });
    pills.push({ cls: caught ? "danger" : "info", text: `Caught: ${caught ? "YES" : "NO"}` });
    pills.push({ cls: "info", text: `Dash: ${dashed ? "YES" : "NO"}` });
    pills.push({ cls: "info", text: `Loot: ${score}` });

    return pills;
  }

  // ---- Pick label in kaartkop
  function pickLine(best) {
    if (!best) return "—";
    if (best.pick) return String(best.pick);

    if (best.play === "PASS") return "PASS";
    if (best.cardId) return `Speel: ${best.cardId}`;
    if (best.cardName) return `Speel: ${best.cardName}`;
    if (best.move) return String(best.move);
    if (best.decision) return String(best.decision);
    if (best.play) return String(best.play);

    return "—";
  }

  // ---- Bullets splitsen (oude format)
  function splitBullets(bullets) {
    const src = normLines(bullets);
    const common = [];
    const def = [];
    const agg = [];
    let mode = "common";

    for (const line of src) {
      const s = String(line || "").trim();

      if (/^DEFENSIEF:/i.test(s)) {
        mode = "def";
        const cleaned = s.replace(/^DEFENSIEF:\s*/i, "").trim();
        if (cleaned) def.push(cleaned);
        continue;
      }
      if (/^AANVALLEND:/i.test(s)) {
        mode = "agg";
        const cleaned = s.replace(/^AANVALLEND:\s*/i, "").trim();
        if (cleaned) agg.push(cleaned);
        continue;
      }

      if (mode === "def") def.push(s);
      else if (mode === "agg") agg.push(s);
      else common.push(s);
    }

    return { common, def, agg };
  }

  // ---- Filter wat spelers NIET hoeven te zien (compact)
  function isPlayerHiddenLine(s) {
    if (!s) return true;
    const t = String(s).trim();

    if (/^Ronde:/i.test(t)) return true;
    if (t.includes("Fase:")) return true;
    if (/^Hand:/i.test(t)) return true;
    if (/^Herkenning:/i.test(t)) return true;
    if (/^Onbekend:/i.test(t)) return true;
    if (/^Jouw Den-kleur:/i.test(t)) return true;
    if (/^Kans:\s*Den-event/i.test(t)) return true;
    if (/^Context:/i.test(t)) return true;

    if (/^DEFENSIEF:/i.test(t)) return true;
    if (/^AANVALLEND:/i.test(t)) return true;

    return false;
  }

  function isRiskLine(s) {
    const t = String(s || "").trim();
    return t.startsWith("Volgende kaart:");
  }
  
function isStrategyLine(s) {
  const t = String(s || "").trim();
  return (
    /^Speel dit uit:/i.test(t) ||
    /^Strategie:/i.test(t) ||
    /^OPS tip:/i.test(t) ||
    /^Let op:/i.test(t) ||
    /^Alarm:/i.test(t) ||
    /^Speel /i.test(t) ||
    /^Gebruik /i.test(t) ||
    /^Kies /i.test(t) ||
    /^Probeer /i.test(t)
  );
}

function stripStrategyPrefix(s) {
  return String(s || "")
    .replace(/^(Speel dit uit:|Strategie:|OPS tip:|Let op:|Alarm:)\s*/i, "")
    .trim();
}

function pickRiskLineFromCommon(lines) {
  const arr = normLines(lines);
  return arr.find((x) => String(x).trim().startsWith("Volgende kaart:")) || null;
}

function normKey(s) {
  return String(s || "").trim().toLowerCase();
}

// extra: filter rommel die niet in de compacte kaart mag
function isExplainLine(x) {
  const t = String(x || "").trim();
  if (!t) return false;

  // nooit in compacte kaart
  if (typeof isPlayerHiddenLine === "function" && isPlayerHiddenLine(t)) return false;
  if (typeof isRiskLine === "function" && isRiskLine(t)) return false;
  if (t.startsWith("Volgende kaart:")) return false;

  // liever niet als "reason", dat is voor de 3e bullet
  if (isStrategyLine(t)) return false;

  // context-ruis
  if (/^Context:/i.test(t)) return false;

  return true;
}

// pak 1e/2e regel uit SPECIFIC die niet al in COMMON zit (en voldoet aan predicate)
function uniqueLinesFromSpecific(specific, common, predicate, max = 2) {
  const commonSet = new Set(normLines(common).map(normKey));
  const out = [];
  const seen = new Set();

  for (const l of normLines(specific)) {
    if (predicate && !predicate(l)) continue;
    const k = normKey(l);
    if (commonSet.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

function fallbackReasonFromPick(best, style) {
  const pick = pickLine(best).toUpperCase();

  if (style === "DEFENSIEF") {
    if (pick.includes("SHIFT")) return "SHIFT verlaagt je directe risico door de track slimmer te zetten.";
    if (pick.includes("SCOUT")) return "SCOUT geeft info zonder extra risico, zodat je straks beter kiest.";
    if (pick.includes("LURK")) return "LURK houdt je veilig en laat je flexibel reageren.";
    if (pick.includes("BURROW")) return "BURROW is je noodrem tegen gevaar, maar is schaars.";
    return "Defensief minimaliseert risico en houdt je opties open.";
  }

  // AANVALLEND
  if (pick.includes("SNATCH")) return "SNATCH maximaliseert je loot-kans nu (tempo maken).";
  if (pick.includes("FORAGE")) return "FORAGE is steady loot pakken met laag gedoe.";
  if (pick.includes("DASH")) return "DASH converteert je loot naar score voordat iets misgaat.";
  return "Aanvallend maximaliseert loot/tempo, met bewust meer risico.";
}

function fallbackPlayFromPick(best, style) {
  const pick = pickLine(best).toUpperCase();

  if (style === "DEFENSIEF") {
    if (pick.includes("SHIFT")) return "Zet risico later; hou de ronde gecontroleerd.";
    if (pick.includes("SCOUT")) return "Gebruik info om straks de veiligste keuze te maken.";
    if (pick.includes("BURROW")) return "Bewaar BURROW voor echte dreiging; niet panieken.";
    return "Speel op veiligheid: pak loot als het ‘gratis’ voelt.";
  }

  // AANVALLEND
  if (pick.includes("SNATCH")) return "Ga voor maximale buit nu; druk zetten op de ronde.";
  if (pick.includes("FORAGE")) return "Pak consistente loot, maar blijf tempo houden.";
  if (pick.includes("DASH")) return "Cash out als de timing gunstig is; voorkom verliezen.";
  return "Speel op tempo: loot pakken, kansen benutten, risico accepteren.";
}

// ---- Compact bullets per kaart
// NU: onderste 2 bullets worden bij voorkeur uit SPECIFIC gehaald (def/agg verschilt),
// zodat je die betere kaart-uitleg ziet in het adviesblok.
function buildPlayerCardBullets({ style, best, common, specific }) {
  const c = normLines(common);
  const s = normLines(specific);

  // 1) risk is common (zelfde voor beide)
  const risk = pickRiskLineFromCommon(c);

  // 2) pak 2 beste uitleg-regels uit SPECIFIC (uniek t.o.v. common)
  //    explain[0] => Waarom dit werkt
  //    explain[1] => Speel dit uit
  const explain = uniqueLinesFromSpecific(s, c, isExplainLine, 2);

  const reasonLine = explain[0] || fallbackReasonFromPick(best, style);

  // 3) tweede uitleg-regel óf een echte strategy-line uit SPECIFIC
  const stratRaw =
    explain[1] ||
    (uniqueLinesFromSpecific(s, c, (x) => isStrategyLine(x), 1)[0] || null);

  const stratLine = stratRaw ? stripStrategyPrefix(stratRaw) : fallbackPlayFromPick(best, style);

  const out = [];
  if (risk) out.push(risk);
  if (reasonLine) out.push(`Waarom dit werkt: ${reasonLine}`);

  // dedupe: als strategie hetzelfde is als reden, skip
  const r = normKey(reasonLine);
  const st = normKey(stratLine);
  if (stratLine && (!r || (st && r !== st && !r.includes(st)))) {
    out.push(`Speel dit uit: ${stratLine}`);
  }

  if (!out.length) out.push("Geen compact advies beschikbaar (check Why this).");
  return out.slice(0, 3);
}

  // ---- Why this = alles (incl. raw bullets + debug)
  function buildWhyThis(hint, ctx, split) {
    const v = hint?.version ? `Advisor: ${hint.version}` : "";
    const title = hint?.title ? `Titel: ${hint.title}` : "";
    const phase = hint?.phase || hint?.debug?.phase || "";

    const pills = buildMiniPills(ctx);

    const common = normLines(split?.common);
    const def = normLines(split?.def);
    const agg = normLines(split?.agg);

    const dbg = hint?.debug ? JSON.stringify(hint.debug, null, 2) : "";

    return `
      ${v ? `<div>${escapeHtml(v)}</div>` : ""}
      ${title ? `<div>${escapeHtml(title)}</div>` : ""}
      ${phase ? `<div>Fase: ${escapeHtml(phase)}</div>` : ""}

      <div class="advisor-tags" style="margin-top:.4rem;">
        ${pills.map((p) => `<span class="advisor-tag">${escapeHtml(p.text)}</span>`).join("")}
      </div>

      <div style="margin-top:.75rem;">
        <div style="font-weight:700; margin-bottom:.25rem;">Alle bullets (raw)</div>
        ${common.length ? `<div style="margin:.35rem 0;"><strong>Common</strong><ul>${common.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : ""}
        ${def.length ? `<div style="margin:.35rem 0;"><strong>Def</strong><ul>${def.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : ""}
        ${agg.length ? `<div style="margin:.35rem 0;"><strong>Agg</strong><ul>${agg.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : ""}
      </div>

      ${dbg ? `
        <details style="margin-top:.6rem;">
          <summary style="cursor:pointer;">Debug (json)</summary>
          <pre style="white-space:pre-wrap; font-size:.75rem; opacity:.85; margin-top:.45rem;">${escapeHtml(dbg)}</pre>
        </details>
      ` : ""}
    `;
  }

  function renderCard({ label, best, bullets }) {
    const pick = pickLine(best);
    const risk = best?.riskLabel || best?.risk || "—";
    const conf = pct01(best?.confidence) ?? pct01(best?.conf);

    const list = safeArr(bullets).filter(Boolean).slice(0, 4);

    return `
      <div class="advisor-card">
        <div class="k">${escapeHtml(label)}</div>
        <div class="pick">${escapeHtml(pick)}</div>
        <p class="meta">Risico: <strong>${escapeHtml(risk)}</strong>${conf !== null ? ` • Zekerheid: <strong>${conf}%</strong>` : ""}</p>
        <ul>
          ${list.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  function ensureDom() {
    if (_advisorOverlay && _advisorPanel) return;

    if (!document.getElementById("advisorHintStyles")) {
      const st = document.createElement("style");
      st.id = "advisorHintStyles";
      st.textContent = `
        .advisor-grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:.75rem; }
        @media (max-width: 820px){ .advisor-grid{ grid-template-columns: 1fr; } }
        .advisor-card{
          border-radius:.9rem;
          padding:.75rem .85rem;
          background: radial-gradient(circle at top left, rgba(255,255,255,0.08), rgba(10,10,20,0.9));
          border: 1px solid rgba(255,255,255,0.08);
        }
        .advisor-card .k{ font-size:.78rem; letter-spacing:.14em; text-transform:uppercase; opacity:.85; margin-bottom:.25rem; }
        .advisor-card .pick{ font-size:1rem; font-weight:700; margin-bottom:.2rem; }
        .advisor-card .meta{ font-size:.78rem; opacity:.85; margin:0 0 .45rem; }
        .advisor-card ul{ margin:.35rem 0 0; padding-left:1.05rem; }
        .advisor-card li{ font-size:.82rem; line-height:1.35; opacity:.92; margin:.18rem 0; }
        .advisor-mini { display:flex; flex-wrap:wrap; gap:.35rem; margin:.5rem 0 .75rem; }
        .advisor-pill{
          font-size:.75rem; padding:.15rem .5rem; border-radius:999px;
          border:1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.35);
        }
        .advisor-pill.safe{ border-color: rgba(34,197,94,.6); }
        .advisor-pill.danger{ border-color: rgba(248,113,113,.7); }
        .advisor-pill.info{ border-color: rgba(59,130,246,.65); }
        .advisor-why{ margin-top:.75rem; }
        .advisor-why summary{ cursor:pointer; font-size:.85rem; opacity:.9; }
        .advisor-why .body{ margin-top:.5rem; font-size:.82rem; opacity:.85; line-height:1.4; }
        .advisor-tags{ display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.4rem; }
        .advisor-tag{ font-size:.72rem; padding:.12rem .45rem; border-radius:999px; border:1px solid rgba(255,255,255,.18); opacity:.9; }
      `;
      document.head.appendChild(st);
    }

    let overlay = document.getElementById("advisorHintModalOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "advisorHintModalOverlay";
      overlay.className = "vj-modal-overlay hidden";
      overlay.innerHTML = `
        <div class="vj-modal-panel lead-command-panel" role="dialog" aria-modal="true">
          <button class="vj-modal-close" type="button" aria-label="Sluit">×</button>
          <h2 class="lead-command-title">LEAD FOX ADVISOR</h2>
          <p class="lead-command-subtitle" id="advisorHintSub">—</p>

          <div class="advisor-mini" id="advisorHintMini"></div>
          <div class="advisor-grid" id="advisorHintGrid"></div>

          <details class="advisor-why">
            <summary>Why this</summary>
            <div class="body" id="advisorHintWhy"></div>
          </details>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    _advisorOverlay = overlay;
    _advisorPanel = overlay.querySelector(".vj-modal-panel");

    if (!_wired) {
      _wired = true;

      const closeBtn = _advisorOverlay.querySelector(".vj-modal-close");
      closeBtn.addEventListener("click", () => closeAdvisorHintOverlay());

      _advisorOverlay.addEventListener("click", (e) => {
        if (e.target === _advisorOverlay) closeAdvisorHintOverlay();
      });

      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (_advisorOverlay && !_advisorOverlay.classList.contains("hidden")) closeAdvisorHintOverlay();
      });
    }

    window.openAdvisorHintOverlay = openAdvisorHintOverlay;
    window.closeAdvisorHintOverlay = closeAdvisorHintOverlay;
  }

  function openAdvisorHintOverlay(hint, ctx = {}) {
    ensureDom();

    const sub = _advisorOverlay.querySelector("#advisorHintSub");
    const mini = _advisorOverlay.querySelector("#advisorHintMini");
    const grid = _advisorOverlay.querySelector("#advisorHintGrid");
    const why = _advisorOverlay.querySelector("#advisorHintWhy");

    const conf = pct01(hint?.confidence);
    const v = hint?.version ? ` • ${hint.version}` : "";
    sub.textContent = `Risico: ${hint?.risk || "—"}${conf !== null ? ` • Zekerheid: ${conf}%` : ""}${v}`;

    const pills = buildMiniPills(ctx);
    mini.innerHTML = pills.map((p) => `<span class="advisor-pill ${p.cls}">${escapeHtml(p.text)}</span>`).join("");

    const hasNew = hint?.def && hint?.agg;

    let split = { common: [], def: [], agg: [] };
    let bestDef = null;
    let bestAgg = null;

    if (hasNew) {
      split.common = safeArr(hint.commonBullets || []);
      split.def = safeArr(hint.def?.bullets || []);
      split.agg = safeArr(hint.agg?.bullets || []);
      bestDef = hint.def;
      bestAgg = hint.agg;
    } else {
      split = splitBullets(hint?.bullets);
      bestDef = hint?.debug?.bestDef || hint || null;
      bestAgg = hint?.debug?.bestAgg || null;
    }

    const defPlayerBullets = buildPlayerCardBullets({
      style: "DEFENSIEF",
      best: bestDef,
      common: split.common,
      specific: split.def,
    });

    const aggPlayerBullets = buildPlayerCardBullets({
      style: "AANVALLEND",
      best: bestAgg,
      common: split.common,
      specific: split.agg,
    });

    grid.innerHTML = `
      ${renderCard({ label: "DEFENSIEF", best: bestDef, bullets: defPlayerBullets })}
      ${renderCard({ label: "AANVALLEND", best: bestAgg, bullets: aggPlayerBullets })}
    `;

    why.innerHTML = buildWhyThis(hint, ctx, split);

    _advisorOverlay.classList.remove("hidden");
  }

  function closeAdvisorHintOverlay() {
    ensureDom();
    _advisorOverlay.classList.add("hidden");
  }

  window.openAdvisorHintOverlay = openAdvisorHintOverlay;
  window.closeAdvisorHintOverlay = closeAdvisorHintOverlay;
})();

// ===== MOVE-ACTIES (single definitions + payload naar /log) =====

async function loadGameAndPlayer() {
  if (!gameRef || !playerRef) return null;

  const [gameSnap, playerSnap] = await Promise.all([getDoc(gameRef), getDoc(playerRef)]);
  if (!gameSnap.exists() || !playerSnap.exists()) return null;

  return { game: gameSnap.data(), player: playerSnap.data() };
}

async function performSnatch() {
  const loaded = await loadGameAndPlayer();
  if (!loaded) return;

  const { game, player } = loaded;

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

  await Promise.all([
    updateDoc(playerRef, { loot }),
    updateDoc(gameRef, { lootDeck, movedPlayerIds: arrayUnion(playerId) }),
  ]);

  await logMoveAction(game, player, "MOVE_SNATCH_FROM_DECK", "MOVE", {
    lootType: card?.t || null,
    lootValue: Number.isFinite(card?.v) ? card.v : null,
  });

  const label = card?.t || "Loot";
  const val = card?.v ?? "?";
  setActionFeedback(`SNATCH: je hebt een ${label} (waarde ${val}) uit de buitstapel getrokken.`);
}

async function performForage() {
  const loaded = await loadGameAndPlayer();
  if (!loaded) return;

  const { game, player } = loaded;

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const actionDeck = Array.isArray(game.actionDeck) ? [...game.actionDeck] : [];
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

  await Promise.all([
    updateDoc(playerRef, { hand }),
    updateDoc(gameRef, { actionDeck, movedPlayerIds: arrayUnion(playerId) }),
  ]);

  await logMoveAction(game, player, `MOVE_FORAGE_${drawn}cards`, "MOVE", { drawn });
}

async function performScout() {
  const loaded = await loadGameAndPlayer();
  if (!loaded) return;

  const { game, player } = loaded;

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const flags = mergeRoundFlags(game);
  if (flags.scatter) {
    alert("Scatter! is gespeeld: niemand mag Scouten deze ronde.");
    return;
  }

  const track = Array.isArray(game.eventTrack) ? game.eventTrack : [];
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return;
  }

  const posStr = prompt(`Welke event-positie wil je scouten? (1-${track.length})`);
  if (!posStr) return;

  const pos = parseInt(String(posStr).trim(), 10);
  if (Number.isNaN(pos) || pos < 1 || pos > track.length) {
    alert("Ongeldige positie.");
    return;
  }

  const noPeek = Array.isArray(flags.noPeek) ? flags.noPeek : [];
  if (noPeek.includes(pos)) {
    alert("Deze positie is geblokkeerd door een No-Go Zone.");
    return;
  }

  const idx = pos - 1;
  const eventId = track[idx];
  const ev = getEventById(eventId);

  alert(`Je scout Event #${pos}: ` + (ev ? ev.title : eventId || "Onbekend event"));

  await Promise.all([
    updateDoc(playerRef, { scoutPeek: { round: game.round || 0, index: idx, eventId } }),
    updateDoc(gameRef, { movedPlayerIds: arrayUnion(playerId) }),
  ]);

  await logMoveAction(game, player, `MOVE_SCOUT_${pos}`, "MOVE", { pos, eventId });

  setActionFeedback(
    `SCOUT: je hebt event #${pos} bekeken. Deze ronde zie je deze kaart als persoonlijke preview.`
  );
}

async function performShift() {
  const loaded = await loadGameAndPlayer();
  if (!loaded) return;

  const { game, player } = loaded;

  if (!canMoveNow(game, player)) {
    alert("Je kunt nu geen MOVE doen.");
    return;
  }

  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert("Events zijn gelocked (Burrow Beacon). Je kunt niet meer shiften.");
    return;
  }

  const { track, eventIndex } = splitEventTrackByStatus(game);
  if (!track.length) {
    alert("Geen Event Track beschikbaar.");
    return;
  }

  const futureCount = track.length - eventIndex;
  if (futureCount <= 1) {
    alert("SHIFT heeft geen effect – er zijn te weinig toekomstige Events om te verschuiven.");
    return;
  }

  const maxPos = track.length;

  const pos1Str = prompt(`SHIFT – eerste positie (alleen toekomstige events: ${eventIndex + 1}-${maxPos})`);
  if (!pos1Str) return;

  const pos2Str = prompt(`SHIFT – tweede positie (alleen toekomstige events: ${eventIndex + 1}-${maxPos})`);
  if (!pos2Str) return;

  const pos1 = parseInt(pos1Str, 10);
  const pos2 = parseInt(pos2Str, 10);

  if (
    Number.isNaN(pos1) ||
    Number.isNaN(pos2) ||
    pos1 < 1 || pos1 > maxPos ||
    pos2 < 1 || pos2 > maxPos ||
    pos1 === pos2
  ) {
    alert("Ongeldige posities voor SHIFT.");
    return;
  }

  const i1 = pos1 - 1;
  const i2 = pos2 - 1;

  if (i1 < eventIndex || i2 < eventIndex) {
    alert(`Je kunt geen Events verschuiven die al onthuld zijn. Kies alleen posities vanaf ${eventIndex + 1}.`);
    return;
  }

  [track[i1], track[i2]] = [track[i2], track[i1]];

  await updateDoc(gameRef, {
    eventTrack: track,
    movedPlayerIds: arrayUnion(playerId),
  });

  await logMoveAction(game, player, `MOVE_SHIFT_${pos1}<->${pos2}`, "MOVE", { pos1, pos2 });

  setActionFeedback(`SHIFT: je hebt toekomstige Events op posities ${pos1} en ${pos2} gewisseld.`);
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
    setActionFeedback("Follow the Tail is actief: jouw uiteindelijke DECISION zal gelijk worden aan de keuze van de gekozen vos.");
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

  const ok = confirm(`Je staat op het punt ${label} te kiezen als jouw definitieve beslissing voor deze ronde. Bevestigen?`);
  if (!ok) {
    setActionFeedback("Je DECISION is nog niet vastgelegd – je kunt nog even nadenken.");
    return;
  }

  const update = { decision: kind };
  if (kind === "BURROW" && !player.burrowUsed) update.burrowUsed = true;

  await updateDoc(playerRef, update);
  await logMoveAction(game, player, `DECISION_${kind}`, "DECISION");
}

// ===== ACTION TURN HELPERS + ACTION PLAY/PASS (CLEAN + NO REFRESH NEEDED) =====

// --- 0) Ensure logMoveAction exists (single source of truth) ---
// Safe: if this block accidentally exists twice, it won't crash.
var logMoveAction = globalThis.logMoveAction;
if (typeof logMoveAction !== "function") {
  logMoveAction = async function logMoveAction(game, player, choice, phase, payload = {}) {
    try {
      if (!db || !gameId) return;

      const round = Number(game?.round ?? 0);
      const pid = player?.id || (typeof playerId !== "undefined" ? playerId : null);
      const pname = player?.name || "Fox";

      const base = {
        createdAt: serverTimestamp(),
        round,
        phase: String(phase || game?.phase || ""),
        choice: String(choice || ""),
        playerId: pid,
        playerName: pname,
        payload: payload && typeof payload === "object" ? payload : { value: payload },
      };

      // 1) actions (voor roundInfo monitor)
      try {
        const actionsCol = collection(db, "games", gameId, "actions");
        await addDoc(actionsCol, base);
      } catch (e) {
        console.warn("[logMoveAction] actions write failed", e);
      }

      // 2) log (voor host log panel)
      try {
        const logCol = collection(db, "games", gameId, "log");
        await addDoc(logCol, {
          ...base,
          kind: "CHOICE",
          clientAt: Date.now(),
          message: `${pname}: ${base.choice}`,
        });
      } catch (e) {
        console.warn("[logMoveAction] log write failed", e);
      }
    } catch (err) {
      console.warn("[logMoveAction] failed hard", err);
    }
  };

  globalThis.logMoveAction = logMoveAction;
}
// --- 1) Next OPS index (prefers game.opsTurnOrder) ---
globalThis.computeNextOpsIndex =
  globalThis.computeNextOpsIndex ||
  function computeNextOpsIndex(game, players) {
    const order = Array.isArray(game?.opsTurnOrder) ? game.opsTurnOrder : null;
    const nOrder = order && order.length ? order.length : 0;

    if (nOrder > 0) {
      const curRaw = game?.opsTurnIndex ?? 0;
      const cur = Number.isFinite(Number(curRaw)) ? Number(curRaw) : 0;
      return (cur + 1) % nOrder;
    }

    // fallback: derive from active players
    const list = Array.isArray(players) ? [...players] : [];
    const ordered =
      typeof sortPlayersByJoinOrder === "function"
        ? sortPlayersByJoinOrder(list)
        : list.sort((a, b) => {
            const ao = Number.isFinite(a?.joinOrder) ? a.joinOrder : 999999;
            const bo = Number.isFinite(b?.joinOrder) ? b.joinOrder : 999999;
            return ao - bo;
          });

    const active = ordered.filter((p) => p && p.inYard !== false && !p.dashed);
    const n = active.length;
    if (!n) return 0;

    const curRaw = game?.opsTurnIndex ?? 0;
    const cur = Number.isFinite(Number(curRaw)) ? Number(curRaw) : 0;
    return (cur + 1) % n;
  };

// --- 2) Single in-flight guard (prevents double click + prevents stuck state) ---
const OPS_LOCK_KEY = "__VJ_OPS_ACTION_IN_FLIGHT__";
function opsTryLock() {
  if (globalThis[OPS_LOCK_KEY] === true) return false;
  globalThis[OPS_LOCK_KEY] = true;
  return true;
}
function opsUnlock() {
  globalThis[OPS_LOCK_KEY] = false;
}

// --- 3) Helpers ---
function getActionCardName(card) {
  if (typeof card === "string") return card.trim();
  return String(card?.name || card?.id || "").trim();
}

function getOpsParticipantCount(game, players) {
  const order = Array.isArray(game?.opsTurnOrder) ? game.opsTurnOrder : null;
  if (order && order.length) return order.length;

  const list = Array.isArray(players) ? players : [];
  return list.filter((p) => p && p.inYard !== false && !p.dashed).length;
}

function showActionError(cardName, err) {
  const msg = err?.message || String(err || "Onbekende fout");
  console.error("[OPS] playActionCard failed:", cardName, err);
  try { setActionFeedback?.(`❌ Fout bij "${cardName}": ${msg}`); } catch {}
  alert(`Er ging iets mis bij het spelen van "${cardName}".\n\n${msg}`);
}

function showPassError(err) {
  const msg = err?.message || String(err || "Onbekende fout");
  console.error("[OPS] passAction failed:", err);
  try { setActionFeedback?.(`❌ Fout bij PASS: ${msg}`); } catch {}
  alert(`Er ging iets mis bij PASS.\n\n${msg}`);
}

// Kaarten die NIET kunnen als je alleen bent
const NEEDS_OTHER_FOX = new Set(["Mask Swap", "Scent Check", "Follow the Tail"]);

// Safe logger (voorkomt: "logMoveAction is not defined" → crash)
async function safeLogMoveAction(game, player, choice, phase, payload) {
  if (typeof logMoveAction === "function") {
    return logMoveAction(game, player, choice, phase, payload);
  }
  console.warn("[OPS] logMoveAction ontbreekt, log skipped:", { choice, phase, payload });
  // Optioneel: als je addLog hebt bestaan, kun je hier nog fallback loggen.
  // if (typeof addLog === "function") await addLog(gameId, { ... })
}

// ===== PLAY ACTION CARD =====
// Returns boolean: true = played, false = not played
async function playActionCard(index) {
  if (!opsTryLock()) return false;

  try {
    if (!gameRef || !playerRef) return false;

    const [gameSnap, playerSnap] = await Promise.all([
      getDoc(gameRef),
      getDoc(playerRef),
    ]);
    if (!gameSnap.exists() || !playerSnap.exists()) return false;

    const game = gameSnap.data();
    const player = playerSnap.data();

    if (typeof canPlayActionNow !== "function" || !canPlayActionNow(game, player)) {
      alert("Je kunt nu geen Actiekaarten spelen.");
      return false;
    }
    if (typeof isMyOpsTurn !== "function" || !isMyOpsTurn(game)) {
      alert("Je bent niet aan de beurt in de OPS-fase.");
      return false;
    }

    const hand = Array.isArray(player.hand) ? [...player.hand] : [];
    if (!Number.isFinite(index) || index < 0 || index >= hand.length) return false;

    const card = hand[index];
    const cardName = getActionCardName(card);
    if (!cardName) {
      alert("Onbekende Action Card in je hand (geen name/id).");
      return false;
    }

    const flagsBefore = (typeof mergeRoundFlags === "function") ? mergeRoundFlags(game) : {};
    if (flagsBefore?.opsLocked) {
      alert("Hold Still is actief: je kunt alleen PASS kiezen.");
      try { setActionFeedback?.("Hold Still is actief – speel geen kaarten meer, kies PASS als je aan de beurt bent."); } catch {}
      return false;
    }

    // ✅ 1-speler precheck (scheelt refresh/verwarring)
    if (NEEDS_OTHER_FOX.has(cardName)) {
      const n = getOpsParticipantCount(game, lastPlayers || []);
      if (n < 2) {
        const m = `"${cardName}" kan nu niet: er is geen andere vos in de Yard.`;
        try { setActionFeedback?.(m); } catch {}
        alert(m);
        return false;
      }
    }

    // ---- execute effect ----
    let executed = false;
    try {
      switch (cardName) {
        case "Scatter!":         executed = await playScatter(game, player); break;
        case "Den Signal":       executed = await playDenSignal(game, player); break;
        case "No-Go Zone":       executed = await playNoGoZone(game, player); break;
        case "Kick Up Dust":     executed = await playKickUpDust(game, player); break;
        case "Burrow Beacon":    executed = await playBurrowBeacon(game, player); break;
        case "Molting Mask":     executed = await playMoltingMask(game, player); break;
        case "Hold Still":       executed = await playHoldStill(game, player); break;
        case "Nose for Trouble": executed = await playNoseForTrouble(game, player); break;
        case "Scent Check":      executed = await playScentCheck(game, player); break;
        case "Follow the Tail":  executed = await playFollowTail(game, player); break;
        case "Alpha Call":       executed = await playAlphaCall(game, player); break;
        case "Pack Tinker":      executed = await playPackTinker(game, player, index); break;
        case "Mask Swap":        executed = await playMaskSwap(game, player); break;
        default:
          alert("Deze kaart is nog niet volledig geïmplementeerd in de online versie.");
          return false;
      }
    } catch (err) {
      showActionError(cardName, err);
      return false;
    }

    if (!executed) {
      // “legaal mislukt”: effectregels zeggen "mag nu niet"
      try { setActionFeedback?.(`De kaart "${cardName}" kon nu niet worden gespeeld. Hij blijft in je hand.`); } catch {}
      return false;
    }

    // ---- consume card ----
// Pack Tinker wijzigt je hand via engine.js, dus eerst verse hand ophalen
let handToConsume = hand;

if (cardName === "Pack Tinker") {
  try {
    const fresh = await getDoc(playerRef);
    if (fresh.exists()) {
      const h2 = fresh.data()?.hand;
      if (Array.isArray(h2)) handToConsume = [...h2];
    }
  } catch {}
}

handToConsume.splice(index, 1);
await updateDoc(playerRef, { hand: handToConsume });

    // ---- log (fail-safe) ----
    await safeLogMoveAction(game, player, `ACTION_${cardName}`, "ACTIONS");

// ✅ bepaal actionId (zodat singleton rules op ID werken)
const def = getActionDefByName?.(cardName);
const actionId = String(def?.id || "");
    
    // ---- advance OPS turn + reset passes ----
    const nextIndex = computeNextOpsIndex(game, lastPlayers || []);
    const gUpdate = {
      opsTurnIndex: nextIndex,
      opsConsecutivePasses: 0,
    };

    // ✅ registreer dat deze actionId deze ronde al gespeeld is
if (actionId && typeof arrayUnion === "function") {
  gUpdate.discardThisRoundActionIds = arrayUnion(actionId);
}
    
  // optional: discard pile (zelfde write)
if (typeof arrayUnion === "function") {
  const meta = {
    by: (typeof playerId !== "undefined" ? playerId : null),
    round: Number(game?.round ?? 0),
    at: Date.now(),
  };

  // legacy/monitoring (laat bestaan)
  gUpdate.actionDiscard = arrayUnion({
    name: cardName,
    ...meta,
  });

  // ✅ echte aflegstapel voor Pack Tinker (met uid)
  const uid = `${meta.at}_${Math.random().toString(16).slice(2)}`;
  gUpdate.actionDiscardPile = arrayUnion({
    uid,
    name: cardName,
    ...meta,
  });
}
    await updateDoc(gameRef, gUpdate);

    try { setHost?.("success", `Kaart gespeeld: ${cardName}`); } catch {}
    try { hostSay?.("action_success"); } catch {}
    try { setActionFeedback?.(`✅ Je speelde "${cardName}".`); } catch {}

    return true;
  } finally {
    opsUnlock();
  }
}

// ===== PASS =====
// Returns boolean: true = pass recorded, false = not (not your turn etc.)
async function passAction() {
  if (!opsTryLock()) return false;

  try {
    if (!gameRef || !playerRef) return false;

    const [gameSnap, playerSnap] = await Promise.all([
      getDoc(gameRef),
      getDoc(playerRef),
    ]);
    if (!gameSnap.exists() || !playerSnap.exists()) return false;

    const game = gameSnap.data();
    const player = playerSnap.data();

    if (typeof canPlayActionNow !== "function" || !canPlayActionNow(game, player)) {
      alert("Je kunt nu geen PASS doen in deze fase.");
      return false;
    }
    if (typeof isMyOpsTurn !== "function" || !isMyOpsTurn(game)) {
      alert("Je bent niet aan de beurt in de OPS-fase.");
      return false;
    }

    const nextIndex = computeNextOpsIndex(game, lastPlayers || []);
    const newPasses = Number(game.opsConsecutivePasses || 0) + 1;

    await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: true });

    await safeLogMoveAction(game, player, "ACTION_PASS", "ACTIONS");

    try { setHost?.("pass", "PASS – je laat deze beurt voorbij gaan."); } catch {}
    try { setActionFeedback?.("PASS geregistreerd."); } catch {}

    return true;
  } catch (err) {
    showPassError(err);
    return false;
  } finally {
    opsUnlock();
  }
}

// ===== CONCRETE ACTION CARD EFFECTS =====

async function playScatter(game, player) {
  const flags = mergeRoundFlags(game);
  flags.scatter = true;
  await updateDoc(gameRef, { flagsRound: flags });
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Scatter! – niemand mag Scouten deze ronde.`,
  });
  setActionFeedback("Scatter! is actief – niemand mag Scouten deze ronde.");
  setHost("scatter", "Scatter! – niemand mag SCOUTen.");
  return true;
}

async function playDenSignal(game, player) {
  const colorInput = prompt("Den Signal – welke Den kleur wil je beschermen? (RED / BLUE / GREEN / YELLOW)");
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
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Den Signal – Den ${color} is immuun voor vang-events deze ronde.`,
  });
  setActionFeedback(`Den Signal: Den ${color} is immuun voor vang-events deze ronde.`);
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
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt No-Go Zone – Scouten op positie ${pos} is verboden.`,
  });
  setActionFeedback(`No-Go Zone: positie ${pos} kan deze ronde niet gescout worden.`);
  return true;
}

async function playKickUpDust(game, player) {
  const flags = mergeRoundFlags(game);
  if (flags.lockEvents) {
    alert("Burrow Beacon is actief – de Event Track is gelocked en kan niet meer veranderen.");
    return false;
  }
  await applyKickUpDust(gameId);
  setActionFeedback("Kick Up Dust: de toekomstige Event kaarten zijn door elkaar geschud. Onthulde kaarten blijven op hun plek.");
  return true;
}

async function playBurrowBeacon(game, player) {
  const flags = mergeRoundFlags(game);
  flags.lockEvents = true;

  await updateDoc(gameRef, { flagsRound: flags });
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Burrow Beacon – Event Track kan deze ronde niet meer veranderen.`,
  });
  setActionFeedback("Burrow Beacon: de Event Track is gelocked – geen SHIFT of schudden meer deze ronde.");
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
    message: `${player.name || "Speler"} speelt Molting Mask – nieuwe Den kleur: ${newColor}.`,
  });
  setActionFeedback(`Molting Mask: je Den kleur is nu ${newColor}.`);
  return true;
}

async function playHoldStill(game, player) {
  const flags = mergeRoundFlags(game);
  flags.opsLocked = true;

  await updateDoc(gameRef, { flagsRound: flags });
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Hold Still – geen nieuwe Action Cards meer deze ronde, alleen PASS.`,
  });
  setActionFeedback("Hold Still is actief – er mogen geen Action Cards meer gespeeld worden, alleen PASS.");
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
  const options = Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  options.sort((a, b) => a.title.localeCompare(b.title, "nl"));

  const menuLines = options.map((opt, idx) => `${idx + 1}. ${opt.title}`);
  const choiceStr = prompt("Nose for Trouble – kies het volgende Event dat je verwacht:\n" + menuLines.join("\n"));
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
  const preds = Array.isArray(flags.predictions) ? [...flags.predictions] : [];
  preds.push({ playerId, eventId: chosenId });
  flags.predictions = preds;

  await updateDoc(gameRef, { flagsRound: flags });
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Nose for Trouble – voorspelt: ${ev ? ev.title : chosenId}.`,
  });
  setActionFeedback(`Nose for Trouble: je hebt "${ev ? ev.title : chosenId}" voorspeld als volgende Event.`);
  return true;
}

async function playScentCheck(game, player) {
  const target = await chooseOtherPlayerPrompt("Scent Check – kies een vos om te besnuffelen");
  if (!target) return false;

  try {
    const pref = doc(db, "games", gameId, "players", target.id);
    const snap = await getDoc(pref);
    if (snap.exists()) {
      const t = snap.data();
      const dec = t.decision || "(nog geen keuze)";
      alert(`[Scent Check] ${t.name || "Vos"} heeft op dit moment DECISION: ${dec}.`);
    }
  } catch (err) {
    console.error("ScentCheck immediate peek error", err);
  }

  const flags = mergeRoundFlags(game);
  const list = Array.isArray(flags.scentChecks) ? [...flags.scentChecks] : [];
  list.push({ viewerId: playerId, targetId: target.id });
  flags.scentChecks = list;

  await updateDoc(gameRef, { flagsRound: flags });
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Scent Check op ${target.name || "een vos"}.`,
  });
  setActionFeedback(`Scent Check: je volgt deze ronde de beslissingen van ${target.name || "de gekozen vos"} van dichtbij.`);
  return true;
}

async function playFollowTail(game, player) {
  const target = await chooseOtherPlayerPrompt("Follow the Tail – kies een vos om te volgen");
  if (!target) return false;

  const flags = mergeRoundFlags(game);
  const ft = flags.followTail || {};
  ft[playerId] = target.id;
  flags.followTail = ft;

  await updateDoc(gameRef, { flagsRound: flags });
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });
  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Follow the Tail en volgt de keuze van ${target.name || "een vos"}.`,
  });
  setActionFeedback(`Follow the Tail: jouw uiteindelijke DECISION zal gelijk zijn aan die van ${target.name || "de gekozen vos"}.`);
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
  const choiceStr = prompt("Alpha Call – kies wie de nieuwe Lead Fox wordt:\n" + lines.join("\n"));
  if (!choiceStr) return false;

  const idx = parseInt(choiceStr, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= ordered.length) {
    alert("Ongeldige keuze.");
    return false;
  }

  await updateDoc(gameRef, { leadIndex: idx });
  resetLeadCache();
  await applyOpsActionAndAdvanceTurn({ db, gameRef, actorId: playerId, isPass: false });

  await addLog(gameId, {
    round: game.round || 0,
    phase: "ACTIONS",
    kind: "ACTION",
    playerId,
    message: `${player.name || "Speler"} speelt Alpha Call – Lead Fox wordt nu ${ordered[idx].name || "een vos"}.`,
  });
  setActionFeedback(`Alpha Call: Lead Fox is nu ${ordered[idx].name || "de gekozen vos"}.`);
  return true;
}

async function playPackTinker(game, player, playedIndex) {
  // ✅ Nieuwe regels: wissel 1 kaart uit hand met 1 kaart uit aflegstapel
  const discard = Array.isArray(game?.actionDiscardPile) ? [...game.actionDiscardPile] : [];
  if (!discard.length) {
    alert("Aflegstapel is leeg. Pack Tinker heeft nu geen effect.");
    return false;
  }

  const handRaw = Array.isArray(player?.hand) ? [...player.hand] : [];
  const handOptions = handRaw
    .map((c, idx) => ({ idx, name: getActionCardName(c) }))
    .filter((x) => x.name && x.idx !== playedIndex); // speel-kaart zelf niet kiezen

  if (!handOptions.length) {
    alert("Je hebt geen andere Action Card in je hand om te wisselen.");
    return false;
  }

  const handLines = handOptions.map((h, i) => `${i + 1}. ${h.name}`).join("\n");
  const giveStr = prompt("Pack Tinker – kies 1 kaart uit je hand om te ruilen:\n" + handLines);
  if (!giveStr) return false;

  const gi = parseInt(giveStr, 10) - 1;
  if (Number.isNaN(gi) || gi < 0 || gi >= handOptions.length) {
    alert("Ongeldige keuze (hand).");
    return false;
  }
  const giveName = handOptions[gi].name;

  const discLines = discard
    .map((d, i) => `${i + 1}. ${getActionCardName(d?.name || d)}`)
    .join("\n");
  const takeStr = prompt("Pack Tinker – kies 1 kaart uit de Aflegstapel:\n" + discLines);
  if (!takeStr) return false;

  const ti = parseInt(takeStr, 10) - 1;
  if (Number.isNaN(ti) || ti < 0 || ti >= discard.length) {
    alert("Ongeldige keuze (aflegstapel).");
    return false;
  }

  const takeUid = discard[ti]?.uid;
  const takeName = getActionCardName(discard[ti]?.name || discard[ti]);

  if (!takeUid || !takeName) {
    alert("Aflegstapel-item mist uid/name. Start even een nieuwe raid na deploy.");
    return false;
  }

  await applyPackTinker(gameId, playerId, giveName, takeUid);
  setActionFeedback?.(`Pack Tinker: "${giveName}" gewisseld met "${takeName}" uit de aflegstapel.`);
  return true;
}
async function playMaskSwap(game, player) {
  const target = await chooseOtherPlayerPrompt(
    "Mask Swap – kies een vos in de Yard om Den-kleur mee te wisselen"
  );
  if (!target) return false;

  const meRef = doc(db, "games", gameId, "players", playerId);
  const tRef = doc(db, "games", gameId, "players", target.id);

  try {
    await runTransaction(db, async (tx) => {
      const meSnap = await tx.get(meRef);
      const tSnap = await tx.get(tRef);
      if (!meSnap.exists() || !tSnap.exists()) throw new Error("player_missing");

      const me = { id: playerId, ...meSnap.data() };
      const t = { id: target.id, ...tSnap.data() };

      // safety: beide moeten nog in de Yard zijn
      if (!isInYardLocal(me) || !isInYardLocal(t)) throw new Error("not_in_yard");

      const a = (me.color || "").toUpperCase();
      const b = (t.color || "").toUpperCase();
      if (!a || !b) throw new Error("missing_color");
      if (a === b) throw new Error("same_color");

      // swap (ook den mee voor consistentie met bots)
      tx.update(meRef, { color: b, den: b });
      tx.update(tRef, { color: a, den: a });
    });

    await addLog(gameId, {
      round: game.round || 0,
      phase: "ACTIONS",
      kind: "ACTION",
      playerId,
      message: `${player.name || "Speler"} speelt Mask Swap – wisselt Den-kleur met ${target.name || "een vos"}.`,
    });

    setActionFeedback(
      `Mask Swap: jij wisselde Den-kleur met ${target.name || "de gekozen vos"}.`
    );
    return true;
  } catch (err) {
    console.error("Mask Swap error", err);
    alert("Mask Swap mislukt: " + (err?.message || err));
    return false;
  }
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

// ===== MODAL CLOSE WIRING (SAFE: no redeclare) =====
(() => {
  // voorkom dubbel binden als dit blok per ongeluk 2x in player.js staat
  if (globalThis.__VJ_MODAL_CLOSE_WIRING__) return;
  globalThis.__VJ_MODAL_CLOSE_WIRING__ = true;

  function bindModalClose(overlayEl, closeBtnEl, closeFn) {
    if (closeBtnEl) {
      closeBtnEl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeFn();
      });
    }

    // klik op backdrop sluit ook
    if (overlayEl) {
      overlayEl.addEventListener("click", (e) => {
        if (e.target === overlayEl) closeFn();
      });
    }
  }

  // --- Lead Fox Command Center (IDs uit HTML) ---
  const leadOverlay = document.getElementById("leadCommandModalOverlay");
  const leadCloseBtn = document.getElementById("leadCommandModalClose");

  const closeLead = () => {
    try {
      // als jouw functie bestaat, gebruik die
      if (typeof closeLeadCommandCenter === "function") {
        closeLeadCommandCenter();
        return;
      }
    } catch {}
    // fallback: gewoon verbergen
    if (leadOverlay) leadOverlay.classList.add("hidden");
  };

  bindModalClose(leadOverlay, leadCloseBtn, closeLead);

  // --- Action Cards Hand modal (IDs uit HTML) ---
  const handOverlay = document.getElementById("handModalOverlay");
  const handCloseBtn = document.getElementById("handModalClose");

  const closeHand = () => {
    // als je elders al closeHandModal() hebt, mag die blijven bestaan,
    // maar we hebben hem niet nodig
    if (handOverlay) handOverlay.classList.add("hidden");
  };
  
// ✅ maak 'm weer bruikbaar voor playActionCard / andere code
if (typeof globalThis.closeHandModal !== "function") {
  globalThis.closeHandModal = closeHand;
}

  bindModalClose(handOverlay, handCloseBtn, closeHand);


  // --- Loot modal (IDs uit HTML) ---
  const lootOverlay = document.getElementById("lootModalOverlay");
  const lootCloseBtn = document.getElementById("lootModalClose");

  const closeLoot = () => {
    try {
      if (typeof closeLootModal === "function") {
        closeLootModal();
        return;
      }
    } catch {}
    if (lootOverlay) lootOverlay.classList.add("hidden");
  };

  bindModalClose(lootOverlay, lootCloseBtn, closeLoot);

  // --- ESC sluit overlays ---
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;

      if (leadOverlay && !leadOverlay.classList.contains("hidden")) closeLead();
      if (handOverlay && !handOverlay.classList.contains("hidden")) closeHand();
      if (lootOverlay && !lootOverlay.classList.contains("hidden")) closeLoot();
    },
    { passive: true }
  );
})();

// ====== AUTH START ======
initAuth(async () => {
  if (!gameId || !playerId) return;

  gameRef = doc(db, "games", gameId);
  playerRef = doc(db, "games", gameId, "players", playerId);

  await ensurePlayerDoc();
  hostInitUI();

  onSnapshot(gameRef, (snap) => {
    if (!snap.exists()) {
      currentGame = null;
      lastGame = null;
      if (gameStatusDiv) gameStatusDiv.textContent = "Spel niet gevonden.";
      return;
    }

    const newGame = { id: snap.id, ...snap.data() };

    if (prevGame && prevGame.leadIndex !== newGame.leadIndex) resetLeadCache();

    applyHostHooks(prevGame, newGame, prevPlayer, currentPlayer, null);

    currentGame = newGame;
    prevGame = newGame;
    lastGame = newGame;

    if (typeof updateHintButtonFromState === "function") updateHintButtonFromState();

    renderGame();
  });

  onSnapshot(playerRef, (snap) => {
    if (!snap.exists()) {
      currentPlayer = null;
      lastMe = null;
      if (playerNameEl) playerNameEl.textContent = "Speler niet gevonden.";
      return;
    }

    const newPlayer = { id: snap.id, ...snap.data() };

    try { if (typeof updateLootButtonState === "function") updateLootButtonState(prevPlayer, newPlayer); } catch {}

    applyHostHooks(currentGame, currentGame, prevPlayer, newPlayer, null);

    currentPlayer = newPlayer;
    prevPlayer = newPlayer;
    lastMe = newPlayer;

    if (typeof updateHintButtonFromState === "function") updateHintButtonFromState();

    renderPlayer();
  });

  // MOVE
  if (btnSnatch) btnSnatch.addEventListener("click", performSnatch);
  if (btnForage) btnForage.addEventListener("click", performForage);
  if (btnScout) btnScout.addEventListener("click", performScout);
  if (btnShift) btnShift.addEventListener("click", performShift);

  // DECISION
  if (btnLurk) btnLurk.addEventListener("click", () => selectDecision("LURK"));
  if (btnBurrow) btnBurrow.addEventListener("click", () => selectDecision("BURROW"));
  if (btnDash) btnDash.addEventListener("click", () => selectDecision("DASH"));

  // ACTIONS
  if (btnPass) btnPass.addEventListener("click", passAction);
  if (btnHand) btnHand.addEventListener("click", openHandModal);
  if (btnLoot) btnLoot.addEventListener("click", () => { openLootModal(); markLootSeen(); });
  if (btnLead) btnLead.addEventListener("click", openLeadCommandCenter);

 // HINT (1 try/catch)
if (btnHint) {
  btnHint.addEventListener("click", () => {
    try { btnHint.classList.remove("is-pulse"); } catch {}
    console.log("[HINT] clicked", {
      hasGame: !!lastGame,
      hasMe: !!lastMe,
      gameId: lastGame?.id,
      meId: lastMe?.id,
    });

    if (!lastGame || !lastMe) {
      alert("Hint: game/player state nog niet geladen.");
      return;
    }

    let hint = null;

    try {
      hint = getAdvisorHint({
        game: lastGame,
        me: lastMe,
        players: lastPlayers || [],
        actions: lastActions || [],
        profileKey: "BEGINNER_COACH",
      });

      
      // UI: stop pulse + mark hint as "seen" (alleen OPS)
      try { markHintSeenIfOps(hint, lastGame); } catch {}
console.log("[advisor] hint object:", hint);
      console.log("[advisor] title:", hint?.title);
      console.log("[advisor] bullets:", hint?.bullets);
      console.log("[advisor] alternatives:", hint?.alternatives);
      console.log("[advisor] debug:", hint?.debug);

      // NEW overlay (Lead Fox style) als default
      if (typeof window.openAdvisorHintOverlay === "function") {
        window.openAdvisorHintOverlay(hint, { game: lastGame, me: lastMe });
        return;
      }

      // fallback: oude overlay
      if (typeof showHint === "function") {
        showHint(hint);
        return;
      }

      console.warn("[HINT] geen overlay-functie gevonden (openAdvisorHintOverlay/showHint).");
    } catch (err) {
      console.error("[HINT] crashed:", err);

      // fallback 1: oude overlay
      try {
        if (hint && typeof showHint === "function") {
          showHint(hint);
          return;
        }
      } catch (e) {}

      // fallback 2: alert
      alert("Hint crash: " + (err?.message || err));
    }
  });
} else {
  console.warn("[HINT] btnHint niet gevonden in DOM");
}
});

