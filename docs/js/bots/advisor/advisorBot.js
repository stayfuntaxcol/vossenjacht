// /bots/advisor/advisorBot.js
// Log-first Advisor (single source of truth: /log)
// - Werkt ook met legacy /actions docs (zelfde shape: round/phase/playerId/choice)
// - Neemt roundState + flags uit logs mee (Den Signal / Scatter / No-Go Zone / Hold Still / Follow Tail / Burrow Beacon)
// - Voorkomt “Defensief vs Aanvallend is hetzelfde” via lichte style tie-break
// - Leakt geen event IDs/titels naar UI (sanitizers)
// - NEW output shape: { version, phase, commonBullets, def, agg, ... } voor de nieuwe overlay
// - UPGRADE: SCOUT-intel -> “Volgende kaart” kan 100% zeker zijn (en werkt ook voor +2).

import { ADVISOR_PROFILES } from "../core/botConfig.js";
import { buildPlayerView } from "../core/stateView.js";
import { getUpcomingEvents } from "../core/eventIntel.js";
import { scoreMoveMoves, scoreOpsPlays, scoreDecisions } from "../core/scoring.js";

// Action defs + info (1 bron: cards.js)
import { getActionDefByName, getActionInfoByName } from "../../cards.js";

const VERSION = "ADVISOR_V2026-01-09_SCOUT_1";

// ------------------------------
// Phase normalisatie
// ------------------------------
function normalizePhase(phase) {
  const p = String(phase || "").toUpperCase();
  if (p.includes("MOVE")) return "MOVE";
  if (p.includes("OPS")) return "OPS";
  if (p.includes("ACTIONS") || p.includes("ACTION")) return "OPS"; // jouw game gebruikt ACTIONS
  if (p.includes("DEC")) return "DECISION";
  if (p.includes("RES") || p.includes("REVEAL")) return "RESOLVE";
  return "UNKNOWN";
}

// ------------------------------
// View adapter: jouw buildPlayerView() shape -> advisor shape
// ------------------------------
function adaptAdvisorView(rawView, fallback = {}) {
  const r = rawView || {};
  const fbGame = fallback.game || {};
  const fbMe = fallback.me || null;
  const fbPlayers = Array.isArray(fallback.players) ? fallback.players : [];

  const phase = r.phase ?? fbGame.phase ?? "MOVE";
  const round = r.round ?? fbGame.round ?? 0;

  const eventTrack = Array.isArray(r.eventTrack)
    ? r.eventTrack
    : Array.isArray(fbGame.eventTrack)
    ? fbGame.eventTrack
    : [];

  // eventCursor is jouw pointer; advisor helpers gebruiken game.eventIndex
  const eventIndexRaw = r.eventCursor ?? r.eventIndex ?? fbGame.eventIndex ?? 0;
  const eventIndex = Number.isFinite(Number(eventIndexRaw)) ? Number(eventIndexRaw) : 0;

  const flagsRound = r.flags ?? fbGame.flagsRound ?? {};

  const me = r.me ?? fbMe;
  const playersPublic = Array.isArray(r.playersPublic)
    ? r.playersPublic
    : Array.isArray(r.players)
    ? r.players
    : fbPlayers;

  const game = {
    ...fbGame,
    phase,
    round,
    eventTrack,
    eventIndex,
    flagsRound,

    roosterSeen: r.roosterSeen ?? fbGame.roosterSeen ?? 0,
    leadIndex: r.leadIndex ?? fbGame.leadIndex ?? 0,
    eventRevealed: r.eventRevealed ?? fbGame.eventRevealed ?? null,
  };

  return {
    ...r,
    game,
    me,
    players: playersPublic,
    playersPublic,
    phase,
    round,
    eventTrack,
    eventCursor: eventIndex,
    flags: flagsRound,
  };
}

// ------------------------------
// Hand -> action names
// ------------------------------
function normalizeActionName(x) {
  const name = typeof x === "string" ? x : x?.name || x?.id || x?.cardId || "";
  return String(name).trim();
}
function getHandActionNames(me) {
  const hand = Array.isArray(me?.hand) ? me.hand : [];
  return hand.map(normalizeActionName).filter(Boolean);
}
function getKnownHandActions(me) {
  const names = getHandActionNames(me);
  return names.map((n) => ({
    name: n,
    def: getActionDefByName(n),
    info: getActionInfoByName(n),
  }));
}
function summarizeHandRecognition(me) {
  const names = getHandActionNames(me);
  const known = getKnownHandActions(me)
    .filter((x) => x.def || x.info)
    .map((x) => x.name);

  const unknown = names.filter((n) => !known.includes(n));

  return {
    names,
    known,
    unknown,
    lineHand: names.length ? `Hand: ${names.join(", ")}` : "Hand: —",
    lineKnown: known.length ? `Herkenning: ${known.join(", ")}` : "Herkenning: —",
    lineUnknown: unknown.length ? `Onbekend: ${unknown.join(", ")}` : null,
  };
}

// ------------------------------
// Profiel-variant (def/agg) via weights
// ------------------------------
function deriveProfile(baseProfile, style) {
  const p = baseProfile || {};
  const w = p.weights || {};

  if (style === "DEFENSIVE") {
    return {
      ...p,
      weights: {
        ...w,
        loot: (w.loot ?? 1.0) * 0.9,
        risk: (w.risk ?? 1.0) * 1.25,
        conserve: (w.conserve ?? 0.0) * 1.2,
        conserveOps: (w.conserveOps ?? 0.0) + 0.15,
      },
    };
  }

  if (style === "AGGRESSIVE") {
    return {
      ...p,
      weights: {
        ...w,
        loot: (w.loot ?? 1.0) * 1.25,
        risk: (w.risk ?? 1.0) * 0.85,
        conserve: (w.conserve ?? 0.0) * 0.8,
        conserveOps: (w.conserveOps ?? 0.0) - 0.1,
      },
    };
  }

  return p;
}

function safeBest(ranked, fallback) {
  return (Array.isArray(ranked) && ranked.length ? ranked[0] : null) || fallback;
}

function labelPlay(x) {
  if (!x) return "PASS";
  if (x.play === "PASS") return "PASS";
  return `Speel: ${x.cardId || x.cardName || x.name || "?"}`;
}
function labelMove(x) {
  return x?.move || "—";
}
function labelDecision(x) {
  return x?.decision || "—";
}

// ------------------------------
// Lead fox helper
// ------------------------------
function computeLeadFoxId(game, players) {
  const list = Array.isArray(players) ? [...players] : [];
  const ordered = list.sort((a, b) => {
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  const active = ordered.filter((p) => p?.inYard !== false && !p?.dashed);
  const base = active.length ? active : [];

  let leadIdx = typeof game?.leadIndex === "number" ? game.leadIndex : 0;
  if (leadIdx < 0) leadIdx = 0;
  if (base.length) leadIdx = leadIdx % base.length;

  const lf = base[leadIdx];
  return lf?.id || null;
}

// ------------------------------
// Event track helpers
// ------------------------------
function getRemainingEventIds(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  return track.slice(Math.max(0, idx)).filter(Boolean);
}
function extractDenColorFromEventId(eventId) {
  if (!eventId) return null;
  if (!String(eventId).startsWith("DEN_")) return null;
  return String(eventId).substring(4).toUpperCase();
}

// ------------------------------
// Loot helpers
// ------------------------------
function getLootPoints(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);
}
function getLootCount(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.length;
}

// ------------------------------
// /log adapter (accept /log or legacy /actions)
// ------------------------------
function normalizeLogRow(raw) {
  const x = raw && typeof raw?.data === "function" ? raw.data() : raw || {};

  const round = Number.isFinite(Number(x.round)) ? Number(x.round) : 0;
  const phaseNorm = normalizePhase(x.phase);
  const playerId = x.playerId || x.actorId || null;

  const choice = typeof x.choice === "string" ? x.choice : x.choice == null ? "" : String(x.choice);

  const payload = x.payload && typeof x.payload === "object" ? x.payload : null;

  const createdAt = x.createdAt || null;
  const clientAt = Number.isFinite(Number(x.clientAt)) ? Number(x.clientAt) : 0;

  return {
    round,
    phase: phaseNorm,
    kind: x.kind || null,
    type: x.type || null,
    playerId,
    choice,
    payload,
    createdAt,
    clientAt,
  };
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
function logAtMs(d) {
  const c = Number.isFinite(Number(d?.clientAt)) ? Number(d.clientAt) : 0;
  if (c > 0) return c;
  return tsToMs(d?.createdAt);
}

function parseActionNameFromChoice(choice, payload) {
  const c = String(choice || "").trim();

  // Jouw standaard: ACTION_<name>
  if (c.startsWith("ACTION_")) return c.slice("ACTION_".length).trim();

  // alternatieven die vaak voorkomen
  if (c.startsWith("PLAY_")) return c.slice("PLAY_".length).trim();

  const m = c.match(/^(ACTION|PLAY)\s*[:_-]\s*(.+)$/i);
  if (m && m[2]) return String(m[2]).trim();

  // payload fallback
  const p = payload?.cardName || payload?.cardId || payload?.name;
  if (p) return String(p).trim();

  return null;
}

// ------------------------------
// RoundState uit /log (keuzes + flags + tellingen)
// ------------------------------
function buildRoundStateFromLog(logs, round) {
  const state = {
    round,
    choices: { move: {}, ops: {}, decision: {} },
    decisionCounts: { LURK: 0, BURROW: 0, DASH: 0 },
    flags: {
      scatter: false,
      lockEvents: false,
      opsLocked: false,   // NEW: Hold Still kan OPS locken (geen nieuwe actions)
      denImmune: {},      // {RED:true}
      noPeek: [],         // [pos]
      holdStill: {},      // {playerId:true}  (decision effect)
      followTail: {},     // {followerId: targetId}
    },
  };

  const arr = Array.isArray(logs) ? logs : [];
  for (const raw of arr) {
    const d = raw?.phase ? raw : normalizeLogRow(raw);
    if ((d.round || 0) !== round) continue;
    if (!d.playerId || !d.phase) continue;
    if (!d.choice) continue;

    if (d.phase === "MOVE") {
      state.choices.move[d.playerId] = { choice: d.choice, payload: d.payload || null };
      continue;
    }

    if (d.phase === "OPS") {
      state.choices.ops[d.playerId] = { choice: d.choice, payload: d.payload || null };

      const actionName = parseActionNameFromChoice(d.choice, d.payload);
      if (!actionName) continue;

      // flags afleiden uit actie-naam
      if (actionName === "Scatter!") state.flags.scatter = true;
      if (actionName === "Burrow Beacon") state.flags.lockEvents = true;

      if (actionName === "Den Signal") {
        const c = String(d.payload?.color || d.payload?.denColor || "").trim().toUpperCase();
        if (c) state.flags.denImmune[c] = true;
      }

      if (actionName === "No-Go Zone") {
        const pos = Number(d.payload?.pos ?? d.payload?.position);
        if (Number.isFinite(pos)) state.flags.noPeek.push(pos);
      }

      if (actionName === "Hold Still") {
        // (A) decision effect target
        const tid = d.payload?.targetId || d.payload?.targetPlayerId;
        if (tid) state.flags.holdStill[tid] = true;

        // (B) ops lock effect (jouw UI gebruikt flags.opsLocked)
        state.flags.opsLocked = true;
      }

      if (actionName === "Follow the Tail") {
        const tid = d.payload?.targetId || d.payload?.targetPlayerId;
        if (tid) state.flags.followTail[d.playerId] = tid;
      }

      continue;
    }

    if (d.phase === "DECISION") {
      state.choices.decision[d.playerId] = { choice: d.choice, payload: d.payload || null };
      if (d.choice === "DECISION_LURK") state.decisionCounts.LURK++;
      if (d.choice === "DECISION_BURROW") state.decisionCounts.BURROW++;
      if (d.choice === "DECISION_DASH") state.decisionCounts.DASH++;
      continue;
    }
  }

  // dedupe noPeek
  state.flags.noPeek = [...new Set(state.flags.noPeek.filter((n) => Number.isFinite(Number(n))))];

  return state;
}

// ------------------------------
// Merge flags: game.flagsRound + log-derived flags
// ------------------------------
function mergeEffectiveFlags(gameFlags, logFlags) {
  const g = gameFlags || {};
  const l = logFlags || {};

  const denImmune = {
    ...(g.denImmune || {}),
    ...(l.denImmune || {}),
  };

  const noPeek = [...new Set([...(g.noPeek || []), ...(l.noPeek || [])])];

  return {
    ...g,
    ...l,
    denImmune,
    noPeek,
    followTail: { ...(g.followTail || {}), ...(l.followTail || {}) },
    holdStill: { ...(g.holdStill || {}), ...(l.holdStill || {}) },
  };
}

// ------------------------------
// Kans / risico helpers
// ------------------------------
function normalizeColorKey(c) {
  if (!c) return "";
  return String(c).trim().toUpperCase();
}
function isDenImmuneForColor(flagsRound, color) {
  const key = normalizeColorKey(color);
  const map = flagsRound?.denImmune || {};
  return !!(map[key] || map[key.toLowerCase()]);
}

// ------------------------------
// Event danger evaluation (LURK baseline)
// Houdt rekening met Den Signal (immune) via ctx.denSignalActive
// ------------------------------
function isDangerousEventForMe(eventId, ctx) {
  const id = String(eventId || "");
  if (!id) return false;

  // 3e rooster is gevaarlijk
  if (id === "ROOSTER_CROW") return (ctx.roosterSeen ?? 0) >= 2;

  // Charges: gevaarlijk tenzij Den Signal actief
  if (id === "DOG_CHARGE" || id === "SECOND_CHARGE") return !ctx.denSignalActive;

  // Den event: gevaarlijk als jouw kleur, tenzij Den Signal actief
  if (id.startsWith("DEN_")) {
    const c = extractDenColorFromEventId(id);
    if (!c) return false;
    if (c !== ctx.myColor) return false;
    return !ctx.denSignalActive;
  }

  // Sheepdog Patrol: baseline LURK = veilig
  if (id === "SHEEPDOG_PATROL") return false;

  // Gate Toll: als je geen loot hebt, word je gepakt (als je niet DASHt)
  if (id === "GATE_TOLL") return (ctx.lootCount ?? 0) <= 0;

  // Magpie Snitch: gevaarlijk voor Lead Fox (baseline LURK = gevaar)
  if (id === "MAGPIE_SNITCH") return !!ctx.isLead;

  return false;
}

// "harmful" evaluation (veilig, maar nadelig)
function isHarmfulEventForMe(eventId, ctx) {
  const id = String(eventId || "");
  if (!id) return false;

  if (id === "PAINT_BOMB_NEST") return (ctx.sackCount ?? 0) > 0;

  return false;
}

function calcDangerProbFromRemaining(remainingIds, ctx) {
  const ids = Array.isArray(remainingIds) ? remainingIds.filter(Boolean) : [];
  if (!ids.length) return 0;

  let danger = 0;
  for (const id of ids) if (isDangerousEventForMe(id, ctx)) danger++;
  return danger / ids.length;
}

function countRemainingOf(remainingIds, predicate) {
  const ids = Array.isArray(remainingIds) ? remainingIds.filter(Boolean) : [];
  let n = 0;
  for (const id of ids) if (predicate(id)) n++;
  return n;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}
function pct(x) {
  return `${Math.round(clamp01(x) * 100)}%`;
}

// ------------------------------
// Bullet sanitizing: geen Event IDs/titels lekken
// ------------------------------
const KNOWN_EVENT_IDS = [
  "DOG_CHARGE",
  "SECOND_CHARGE",
  "SHEEPDOG_PATROL",
  "HIDDEN_NEST",
  "GATE_TOLL",
  "MAGPIE_SNITCH",
  "PAINT_BOMB_NEST",
  "ROOSTER_CROW",
  "DEN_RED",
  "DEN_BLUE",
  "DEN_GREEN",
  "DEN_YELLOW",
];

function sanitizeTextNoEventNames(text) {
  let s = String(text || "");

  for (const id of KNOWN_EVENT_IDS) {
    const re = new RegExp(`\\b${id}\\b`, "g");
    s = s.replace(re, "opkomend event");
  }
  s = s.replace(/\bDEN_(RED|BLUE|GREEN|YELLOW)\b/g, "Den-event");

  s = s.replace(/\bRooster Crow\b/gi, "rooster-event");
  s = s.replace(/\bHidden Nest\b/gi, "bonus-event");
  s = s.replace(/\bSheepdog Patrol\b/gi, "patrol-event");
  s = s.replace(/\bSecond Charge\b/gi, "charge-event");
  s = s.replace(/\bSheepdog Charge\b/gi, "charge-event");
  s = s.replace(/\bPaint[- ]?Bomb Nest\b/gi, "sack-reset event");

  return s;
}
function sanitizeBullets(bullets) {
  const arr = Array.isArray(bullets) ? bullets : [];
  return arr.map(sanitizeTextNoEventNames);
}

// ------------------------------
// Spelerslijst helpers
// ------------------------------
function getPlayersList(view, players) {
  return (view?.playersPublic || view?.players || players || []).filter(Boolean);
}
function resolveMyDenColor(view, me, players) {
  const m = view?.me || me || {};
  const direct = m.den ?? m.color ?? m.denColor ?? m.playerColor ?? m.maskColor ?? "";
  let c = String(direct || "").trim();

  if (!c) {
    const list = getPlayersList(view, players);
    const found = list.find((p) => p?.id === m?.id || p?.playerId === m?.id);
    const alt = found?.den ?? found?.color ?? found?.denColor ?? "";
    c = String(alt || "").trim();
  }

  c = c.toUpperCase();
  if (!["RED", "BLUE", "GREEN", "YELLOW"].includes(c)) return "";
  return c;
}

// ------------------------------
// Track-mutation detectie (voor SCOUT validity)
// ------------------------------
function extractSwapPositions(payload) {
  const p = payload || {};
  const pos1 = Number(p.pos1 ?? p.a ?? p.from ?? p.first ?? p.position1);
  const pos2 = Number(p.pos2 ?? p.b ?? p.to ?? p.second ?? p.position2);
  const ok1 = Number.isFinite(pos1) && pos1 >= 1;
  const ok2 = Number.isFinite(pos2) && pos2 >= 1;
  if (!ok1 || !ok2) return null;
  return { pos1, pos2, idx1: pos1 - 1, idx2: pos2 - 1 };
}

function detectTrackMutations(logs, round) {
  const mutations = [];
  const arr = Array.isArray(logs) ? logs : [];

  for (const d0 of arr) {
    const d = d0?.phase ? d0 : normalizeLogRow(d0);
    if ((d.round || 0) !== round) continue;

    const at = logAtMs(d);
    if (!at) continue;

    // MOVE: SHIFT
    if (d.phase === "MOVE") {
      const ch = String(d.choice || "").toUpperCase();
      if (ch.includes("SHIFT")) {
        const swap = extractSwapPositions(d.payload);
        mutations.push({
          at,
          kind: "SHIFT",
          affectsAll: false,
          idxs: swap ? [swap.idx1, swap.idx2] : null, // als onbekend: conservatief later
        });
      }
      continue;
    }

    // OPS: Pack Tinker / Kick Up Dust (track)
    if (d.phase === "OPS") {
      const name = parseActionNameFromChoice(d.choice, d.payload);
      if (!name) continue;

      if (name === "Kick Up Dust") {
        mutations.push({ at, kind: "KICK_UP_DUST", affectsAll: true, idxs: null });
      }
      if (name === "Pack Tinker") {
        const swap = extractSwapPositions(d.payload);
        mutations.push({
          at,
          kind: "PACK_TINKER",
          affectsAll: false,
          idxs: swap ? [swap.idx1, swap.idx2] : null,
        });
      }
    }
  }

  mutations.sort((a, b) => (a.at || 0) - (b.at || 0));
  return mutations;
}

function peekIsStaleByMutations({ peekAt, peekIndex, mutations }) {
  if (!peekAt || !Number.isFinite(Number(peekIndex))) return true;
  const muts = Array.isArray(mutations) ? mutations : [];

  for (const m of muts) {
    if (!m?.at) continue;
    if (m.at <= peekAt) continue; // alleen mutations NA jouw scout

    // shuffle -> altijd stale
    if (m.affectsAll) return true;

    // swap onbekend -> conservatief stale
    if (!Array.isArray(m.idxs) || m.idxs.length < 2) return true;

    // stale als jouw gescoute index geraakt wordt
    if (m.idxs.includes(peekIndex)) return true;
  }

  return false;
}

// ------------------------------
// SCOUT intel uit logs + player doc
// ------------------------------
function parseScoutFromChoice(choice) {
  const c = String(choice || "").trim();
  // MOVE_SCOUT_<pos>
  const m = c.match(/^MOVE_SCOUT_(\d+)$/i);
  if (m && m[1]) {
    const pos = Number(m[1]);
    if (Number.isFinite(pos) && pos >= 1) return { pos, index: pos - 1 };
  }
  return null;
}

function buildScoutIntel({ view, logs, round, me }) {
  const pid = me?.id || view?.me?.id || null;
  const mutations = detectTrackMutations(logs, round);

  const byIndex = {}; // { [idx]: { eventId, at, pos, source } }
  const arr = Array.isArray(logs) ? logs : [];

  // 1) uit logs (sterkst: heeft timestamps)
  for (const d0 of arr) {
    const d = d0?.phase ? d0 : normalizeLogRow(d0);
    if ((d.round || 0) !== round) continue;
    if (d.phase !== "MOVE") continue;
    if (!pid || d.playerId !== pid) continue;

    const info = parseScoutFromChoice(d.choice);
    if (!info) continue;

    const at = logAtMs(d);
    const pos = Number(d.payload?.pos ?? info.pos);
    const idx = Number(d.payload?.index ?? info.index);

    const eventId = d.payload?.eventId || d.payload?.id || d.payload?.event || null;
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (!eventId) continue;

    // validity check t.o.v. track mutations
    if (peekIsStaleByMutations({ peekAt: at, peekIndex: idx, mutations })) continue;

    // keep latest per index
    const prev = byIndex[idx];
    if (!prev || (prev.at || 0) <= (at || 0)) {
      byIndex[idx] = { eventId: String(eventId), at: at || 0, pos: pos || idx + 1, source: "LOG" };
    }
  }

  // 2) fallback: player doc scoutPeek (geen timestamp) -> alleen gebruiken als er nog niks is
  const sp = me?.scoutPeek || view?.me?.scoutPeek || null;
  if (sp && (Number(sp.round) === Number(round))) {
    const idx = Number(sp.index);
    const eventId = sp.eventId;
    if (Number.isFinite(idx) && idx >= 0 && eventId && !byIndex[idx]) {
      // geen timestamp -> alleen accepteren als er géén mutations in deze ronde zijn
      const hasMut = (mutations || []).length > 0;
      if (!hasMut) {
        byIndex[idx] = { eventId: String(eventId), at: 0, pos: idx + 1, source: "PLAYERDOC" };
      }
    }
  }

  return {
    byIndex,
    mutations,
  };
}

function applyScoutIntelToUpcoming({ upcomingPeek, game, scoutIntel }) {
  const up = Array.isArray(upcomingPeek) ? upcomingPeek.slice() : [];
  const idx0 = Number(game?.eventIndex ?? 0) || 0;
  const map = scoutIntel?.byIndex || {};

  return up.map((x, i) => {
    const idx = idx0 + i;
    const peek = map[idx];
    if (peek?.eventId) {
      return { ...(x || {}), id: peek.eventId, known: true, knownSource: peek.source, index: idx };
    }
    return { ...(x || {}), known: false, index: idx };
  });
}

// ------------------------------
// Risk meta (met effective flags + scout override)
// ------------------------------
function buildRiskMeta({ view, game, me, players, upcomingPeek, effectiveFlags, scoutIntel }) {
  const myColor = resolveMyDenColor(view, me, players);
  const roosterSeen = Number(game?.roosterSeen || 0);

  const lootCount = getLootCount(me);
  const lootPts = getLootPoints(me);

  const sackCount = Array.isArray(game?.sack) ? game.sack.length : 0;

  const leadFoxId = computeLeadFoxId(game, players);
  const isLead = !!me?.id && leadFoxId === me.id;

  const denSignalActive = myColor ? isDenImmuneForColor(effectiveFlags, myColor) : false;

  const ctx = { myColor, roosterSeen, lootCount, lootPts, isLead, sackCount, denSignalActive };

  const remaining = getRemainingEventIds(game);

  // deck probabilities (los van peek)
  const probNextDanger = calcDangerProbFromRemaining(remaining, ctx);

  const total = remaining.length || 1;
  const probNextHarmful =
    remaining.length ? countRemainingOf(remaining, (id) => isHarmfulEventForMe(id, ctx)) / total : 0;

  const myDenId = myColor ? `DEN_${myColor}` : null;
  const pMyDen = myDenId ? countRemainingOf(remaining, (id) => String(id) === myDenId) / total : 0;

  const pCharges =
    countRemainingOf(remaining, (id) => id === "DOG_CHARGE" || id === "SECOND_CHARGE") / total;

  const pThirdRooster =
    roosterSeen >= 2 ? countRemainingOf(remaining, (id) => id === "ROOSTER_CROW") / total : 0;

  // next card (zeker als gescout & valide)
  const eventIndex = Number(game?.eventIndex ?? view?.eventCursor ?? 0) || 0;
  const peekByIndex = scoutIntel?.byIndex || {};
  const knownPeek = peekByIndex[eventIndex] || null;

  const nextId = knownPeek?.eventId || upcomingPeek?.[0]?.id || null;
  const nextKnown = !!knownPeek?.eventId;

  const nextIsDanger = nextId ? isDangerousEventForMe(nextId, ctx) : false;
  const nextIsHarmful = nextId ? isHarmfulEventForMe(nextId, ctx) : false;

  const nextLabel = nextId
    ? nextIsDanger
      ? "GEVAARLIJK"
      : nextIsHarmful
      ? "VEILIG maar NADELIG"
      : "VEILIG"
    : "—";

  return {
    ctx,
    remaining,
    probNextDanger,
    probNextHarmful,
    pMyDen,
    pCharges,
    pThirdRooster,

    // intern (niet tonen als ID)
    nextId,
    nextIsDanger,
    nextIsHarmful,
    nextKnown,
    nextKnownSource: knownPeek?.source || null,
    nextKnownPos: Number.isFinite(Number(knownPeek?.pos)) ? Number(knownPeek.pos) : null,

    // toonbaar
    nextLabel,
  };
}

// ------------------------------
// Headerregels (compact)
// ------------------------------
function headerLinesCompact(view, riskMeta) {
  const knownTag = riskMeta.nextKnown ? " (100%)" : "";
  return [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    `Volgende kaart: ${riskMeta.nextLabel}${knownTag} • Kans gevaar (deck): ${pct(riskMeta.probNextDanger)} • Kans nadelig (deck): ${pct(
      riskMeta.probNextHarmful
    )} • Kans 3e rooster (deck): ${pct(riskMeta.pThirdRooster)}`,
  ];
}

// ------------------------------
// Style tie-break (maakt Def/Agg vaker verschillend)
// ------------------------------
function postRankByStyle(ranked, style) {
  const arr = Array.isArray(ranked) ? ranked.slice() : [];
  if (!arr.length) return arr;

  const bump = (x, delta) => ({ ...x, score: (Number(x.score) || 0) + delta });

  const moveName = (x) => String(x?.move || "").toUpperCase();
  const playName = (x) => String(x?.play || x?.cardId || x?.cardName || x?.name || "").toUpperCase();
  const decName = (x) => String(x?.decision || "").toUpperCase();

  if (style === "DEFENSIVE") {
    return arr
      .map((x) => {
        const m = moveName(x);
        const d = decName(x);
        const p = playName(x);
        let delta = 0;

        if (m.includes("SHIFT")) delta += 0.18;
        if (m.includes("SCOUT")) delta += 0.06;

        if (m.includes("SNATCH")) delta -= 0.05;
        if (m.includes("FORAGE")) delta -= 0.04;

        if (d === "BURROW") delta += 0.08;
        if (d === "LURK") delta += 0.05;
        if (d === "DASH") delta -= 0.06;

        if (p.includes("DEN SIGNAL")) delta += 0.08;
        if (p.includes("BURROW BEACON")) delta += 0.05;

        return bump(x, delta);
      })
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  }

  if (style === "AGGRESSIVE") {
    return arr
      .map((x) => {
        const m = moveName(x);
        const d = decName(x);
        const p = playName(x);
        let delta = 0;

        if (m.includes("SNATCH")) delta += 0.12;
        if (m.includes("FORAGE")) delta += 0.08;

        if (m.includes("SHIFT")) delta -= 0.03;
        if (m.includes("SCOUT")) delta -= 0.02;

        if (d === "DASH") delta += 0.1;
        if (d === "LURK") delta -= 0.02;

        if (p.includes("PACK TINKER")) delta += 0.06;
        if (p.includes("KICK UP DUST")) delta += 0.04;

        return bump(x, delta);
      })
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  }

  return arr;
}

// ------------------------------
// OPS: tactische override (met effective flags + scout)
// ------------------------------
function pickOpsTacticalAdvice({ view, handNames, riskMeta }) {
  const lines = [];
  const has = (name) => handNames.includes(name);

  const flags = view?.game?.flagsRound || view?.flags || {};
  const trackLocked = !!flags.lockEvents;
  const opsLocked = !!flags.opsLocked;

  if (riskMeta.nextKnown) {
    lines.push(`Strategie: je hebt de volgende kaart via SCOUT → status is ${riskMeta.nextLabel} (100%).`);
    if (!trackLocked && has("Burrow Beacon")) {
      lines.push("OPS tip: speel **Burrow Beacon** om de track te locken zodat niemand nog kan schuiven/ruilen/shufflen.");
    }
    if (!opsLocked && has("Hold Still")) {
      lines.push("OPS tip: als je je SCOUT-voordeel wil vasthouden, speel/bewaar **Hold Still** om verdere Action Cards te blokkeren (geen Pack Tinker/Kick Up Dust).");
    }
  }

  const myColor = riskMeta.ctx.myColor || "?";
  const denSignalActiveForMe = myColor ? isDenImmuneForColor(flags, myColor) : false;

  if (riskMeta.nextIsDanger) {
    if (has("Den Signal") && !denSignalActiveForMe) {
      lines.push("OPS tip: speel **Den Signal** op je eigen Den-kleur om jezelf veilig te zetten tegen charges en jouw Den-event.");
    }

    if (riskMeta.pMyDen >= 0.1) {
      if (has("Molting Mask")) lines.push("OPS tip: bij Den-gevaar is **Molting Mask** heel sterk (willekeurige nieuwe Den-kleur).");
      if (has("Mask Swap")) lines.push("OPS tip: **Mask Swap** is een alternatief als er andere actieve spelers in de Yard zijn.");
    }

    if (has("Pack Tinker")) lines.push("OPS tip: overweeg **Pack Tinker** om gevaar verder naar achter te schuiven.");
    if (has("Kick Up Dust")) lines.push("OPS tip: **Kick Up Dust** kan toekomstige events herschudden (als de track niet gelocked is).");
  }

  if (riskMeta.nextId === "PAINT_BOMB_NEST") {
    if ((riskMeta.ctx.sackCount ?? 0) > 0) {
      lines.push("Let op: volgende kaart is een **sack-reset event** → huidige Sack verdwijnt terug de Loot Deck in (minder eindbonus voor dashers).");
      if (has("Pack Tinker")) lines.push("OPS tip: **Pack Tinker** is hier sterk om dit event naar achteren te schuiven.");
      if (has("Kick Up Dust")) lines.push("OPS tip: **Kick Up Dust** kan toekomstige events herschudden (als de track niet gelocked is).");
    } else {
      lines.push("Volgende kaart is een **sack-reset event**, maar de Sack is nu klein → impact is beperkt.");
    }
  }

  if (riskMeta.nextId === "HIDDEN_NEST") {
    lines.push("Let op: volgende kaart is een **DASH-bonus event**. Bonus werkt alleen als 1–3 spelers DASH kiezen (3/2/1 loot).");
    lines.push("Strategie: vaak beter om dit bonus-event later te zetten (Pack Tinker / SHIFT), zodat je niet direct uit de Yard vertrekt.");
  }

  if (riskMeta.nextId === "ROOSTER_CROW") {
    if ((view?.game?.roosterSeen || 0) >= 2) {
      lines.push("Alarm: een **3e rooster-event** is gevaarlijk (raid eindigt). Probeer dit naar achteren te schuiven (Pack Tinker / SHIFT).");
    } else {
      lines.push("Strategie: rooster-events zijn vaak beter later in de track (meer rondes om loot te pakken).");
    }
  }

  return lines.map(sanitizeTextNoEventNames);
}

// ------------------------------
// DECISION: tactische guidance (Den Signal + Hold Still + Hidden Nest + scout)
// ------------------------------
function decisionTacticalAdvice({ view, riskMeta }) {
  const lines = [];
  const g = view?.game || {};
  const flags = g.flagsRound || view?.flags || {};

  if (riskMeta.nextKnown) {
    lines.push(`Strategie: volgende kaart is bekend via SCOUT → ${riskMeta.nextLabel} (100%).`);
  }

  const myColor = riskMeta.ctx.myColor || "";
  const denSignalActiveForMe = myColor ? isDenImmuneForColor(flags, myColor) : false;

  const holdStill = flags?.holdStill || {};
  if (view?.me?.id && holdStill[view.me.id]) {
    lines.push("Let op: **Hold Still** is op jou gespeeld → DASH werkt niet (je blijft LURK).");
  }

  if (denSignalActiveForMe) {
    lines.push("Den Signal actief voor jouw kleur → **kies LURK** (dus niet BURROW/DASH).");
  }

  if (riskMeta.nextId === "HIDDEN_NEST") {
    const dashSoFar = view?.roundState?.decisionCounts?.DASH ?? 0;

    lines.push("Aggressief: **DASH** kan hier extra loot opleveren (alleen als 1–3 spelers DASH kiezen: 3/2/1).");

    if (dashSoFar >= 3) {
      lines.push("Waarschuwing: er zijn al veel DASH-keuzes → bonus wordt snel 0.");
    } else {
      lines.push("Check: als jij DASH kiest, probeer te mikken op totaal 1–3 dashers voor maximale bonus.");
    }

    lines.push("Strategie: meestal is het beter om dit bonus-event later te zetten (Pack Tinker / SHIFT), zodat je niet te vroeg uit de Yard vertrekt.");
  }

  if (riskMeta.nextId === "ROOSTER_CROW" && (g.roosterSeen || 0) >= 2) {
    lines.push("3e rooster-event is gevaarlijk (raid eindigt). Defensief: voorkom paniek-dash; liever de track fixen (Pack Tinker / SHIFT).");
  }

  return lines.map(sanitizeTextNoEventNames);
}

// ------------------------------
// Helper: build new overlay-friendly output
// ------------------------------
function buildOverlayHint({ phase, title, risk, confidence, commonBullets, defObj, aggObj, alternatives, debug }) {
  return {
    version: VERSION,
    phase,
    title,
    risk,
    confidence,

    // nieuwe overlay velden
    commonBullets: sanitizeBullets(commonBullets || []),
    def: {
      pick: defObj.pick,
      confidence: defObj.confidence,
      riskLabel: defObj.riskLabel,
      bullets: sanitizeBullets(defObj.bullets || []),
    },
    agg: {
      pick: aggObj.pick,
      confidence: aggObj.confidence,
      riskLabel: aggObj.riskLabel,
      bullets: sanitizeBullets(aggObj.bullets || []),
    },

    // legacy compat (oude UI kan dit nog gebruiken)
    bullets: sanitizeBullets([
      ...(commonBullets || []),
      `DEFENSIEF: ${defObj.pick} (${defObj.riskLabel ?? "?"})`,
      ...(defObj.bullets || []),
      `AANVALLEND: ${aggObj.pick} (${aggObj.riskLabel ?? "?"})`,
      ...(aggObj.bullets || []),
    ])
      .filter(Boolean)
      .slice(0, 14),

    alternatives: Array.isArray(alternatives) ? alternatives : [],
    debug: debug || {},
  };
}

// ------------------------------
// Main hint
// ------------------------------
export function getAdvisorHint({
  game,
  me,
  players,
  actions = [], // <-- geef hier /log docs door (of legacy /actions; werkt ook)
  profileKey = "BEGINNER_COACH",
}) {
  const baseProfile = ADVISOR_PROFILES[profileKey] || ADVISOR_PROFILES.BEGINNER_COACH;

  const profileDef = deriveProfile(baseProfile, "DEFENSIVE");
  const profileAgg = deriveProfile(baseProfile, "AGGRESSIVE");

  // Normaliseer actions/logs naar log-rows
  const logs = Array.isArray(actions) ? actions.map(normalizeLogRow) : [];

  // 1) raw view (tolerant)
  const rawView = buildPlayerView({ game, me, players, actions: logs });

  // 2) adapter
  const view = adaptAdvisorView(rawView, { game, me, players });
  const phase = normalizePhase(view.phase || view.game?.phase);

  // RoundState uit logs
  const round = Number(view.round ?? view.game?.round ?? 0) || 0;
  const roundState = buildRoundStateFromLog(logs, round);
  view.roundState = roundState;

  // effective flags
  const effectiveFlags = mergeEffectiveFlags(view.game?.flagsRound || {}, roundState.flags || {});
  view.game.flagsRound = effectiveFlags;
  view.flags = effectiveFlags;

  // hand normaliseren
  const handMeta = summarizeHandRecognition(view.me || me || {});
  if (view?.me) {
    view.me.handNames = handMeta.names;
    view.me.handKnown = handMeta.known;
    view.me.handUnknown = handMeta.unknown;
    view.me.hand = handMeta.names.map((n) => ({ id: n, name: n }));
  }

  // SCOUT intel (per index, valide t.o.v. mutations)
  const scoutIntel = buildScoutIntel({ view, logs, round, me: view.me || me || {} });

  // upcoming peek (intern) + scout override
  const upcomingPeek0 = getUpcomingEvents(view, 2) || [];
  const upcomingPeek = applyScoutIntelToUpcoming({
    upcomingPeek: upcomingPeek0,
    game: view.game || game,
    scoutIntel,
  });

  // risk meta (met scout override)
  const riskMeta = buildRiskMeta({
    view,
    game: view.game || game,
    me: view.me || me,
    players: view.players || players,
    upcomingPeek,
    effectiveFlags,
    scoutIntel,
  });

  const riskBullets = [
    `Jouw Den-kleur: ${riskMeta.ctx.myColor || "—"}`,
    `Kans: Den-event van jouw kleur: ${pct(riskMeta.pMyDen)} • Charges: ${pct(riskMeta.pCharges)} • 3e rooster: ${pct(
      riskMeta.pThirdRooster
    )}`,
    riskMeta.ctx.denSignalActive ? "Den Signal actief: je bent veilig tegen charges + jouw Den-event." : null,
    riskMeta.nextKnown ? `SCOUT: volgende kaart is bekend → ${riskMeta.nextLabel} (100%).` : null,
  ].filter(Boolean);

  // =======================
  // MOVE
  // =======================
  if (phase === "MOVE") {
    const rankedDef0 = scoreMoveMoves({ view, upcoming: upcomingPeek, profile: profileDef }) || [];
    const rankedAgg0 = scoreMoveMoves({ view, upcoming: upcomingPeek, profile: profileAgg }) || [];

    const rankedDef = postRankByStyle(rankedDef0, "DEFENSIVE");
    const rankedAgg = postRankByStyle(rankedAgg0, "AGGRESSIVE");

    const bestDef = safeBest(rankedDef, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });
    const bestAgg = safeBest(rankedAgg, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });

    const strat = [];
    if (riskMeta.probNextDanger >= 0.35) strat.push("Strategie: kans op gevaar is vrij hoog → overweeg **SHIFT** (MOVE) om gevaar naar achter te duwen.");
    if (riskMeta.nextId === "HIDDEN_NEST") strat.push("Strategie: er komt een DASH-bonus event aan → vaak slim om die later te zetten (SHIFT / Pack Tinker).");
    if (riskMeta.nextId === "ROOSTER_CROW") strat.push("Strategie: rooster-events liever later (meer rondes om loot te pakken).");
    if (riskMeta.nextId === "PAINT_BOMB_NEST" && (riskMeta.ctx.sackCount ?? 0) > 0) strat.push("Strategie: er komt een sack-reset event aan en de Sack is gevuld → overweeg **SHIFT**.");

    const commonBullets = [
      ...headerLinesCompact(view, riskMeta),
      ...riskBullets,
      ...sanitizeBullets(strat),
    ].filter(Boolean);

    return buildOverlayHint({
      phase,
      title: `MOVE advies • Def: ${labelMove(bestDef)} • Agg: ${labelMove(bestAgg)}`,
      risk: riskMeta.nextIsDanger ? "HIGH" : riskMeta.nextIsHarmful ? "MED" : "MIX",
      confidence: Math.max(bestDef.confidence ?? 0.65, bestAgg.confidence ?? 0.65),
      commonBullets,
      defObj: {
        pick: labelMove(bestDef),
        confidence: bestDef.confidence,
        riskLabel: bestDef.riskLabel ?? "—",
        bullets: bestDef.bullets || [],
      },
      aggObj: {
        pick: labelMove(bestAgg),
        confidence: bestAgg.confidence,
        riskLabel: bestAgg.riskLabel ?? "—",
        bullets: bestAgg.bullets || [],
      },
      alternatives: [
        { mode: "DEF alt", pick: rankedDef[1]?.move || null },
        { mode: "AGG alt", pick: rankedAgg[1]?.move || null },
      ].filter((x) => x.pick),
      debug: {
        version: VERSION,
        phase: view.phase,
        hand: handMeta,
        scoutIntel: {
          knownIndexes: Object.keys(scoutIntel.byIndex || {}).map((k) => Number(k)),
          mutations: scoutIntel.mutations || [],
        },
        roundState: {
          decisionCounts: view.roundState?.decisionCounts || null,
          flags: view.roundState?.flags || null,
        },
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          nextKnown: !!riskMeta.nextKnown,
          nextKnownSource: riskMeta.nextKnownSource,
          nextKnownPos: riskMeta.nextKnownPos,
          probNextDanger: riskMeta.probNextDanger,
          probNextHarmful: riskMeta.probNextHarmful,
          pMyDen: riskMeta.pMyDen,
          pCharges: riskMeta.pCharges,
          pThirdRooster: riskMeta.pThirdRooster,
          denSignalActive: !!riskMeta.ctx.denSignalActive,
        },
      },
    });
  }

  // =======================
  // OPS
  // =======================
  if (phase === "OPS") {
    const def0 = scoreOpsPlays({ view, upcoming: upcomingPeek, profile: profileDef, style: "DEFENSIVE" }) || [];
    const agg0 = scoreOpsPlays({ view, upcoming: upcomingPeek, profile: profileAgg, style: "AGGRESSIVE" }) || [];

    const defRanked = postRankByStyle(def0, "DEFENSIVE");
    const aggRanked = postRankByStyle(agg0, "AGGRESSIVE");

    const bestDef = safeBest(defRanked, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });
    const bestAgg = safeBest(aggRanked, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });

    const labelDef = labelPlay(bestDef);
    const labelAgg = labelPlay(bestAgg);

    const tactical = pickOpsTacticalAdvice({ view, handNames: handMeta.names, riskMeta });

    const commonBullets = [
      ...headerLinesCompact(view, riskMeta),
      ...riskBullets,
      handMeta.lineHand,
      handMeta.lineKnown,
      ...(handMeta.lineUnknown ? [handMeta.lineUnknown] : []),
      ...tactical,
    ].filter(Boolean);

    return buildOverlayHint({
      phase,
      title: `OPS advies • Def: ${labelDef} • Agg: ${labelAgg}`,
      risk: riskMeta.nextIsDanger ? "HIGH" : riskMeta.nextIsHarmful ? "MED" : "MIX",
      confidence: Math.max(bestDef.confidence ?? 0.65, bestAgg.confidence ?? 0.65),
      commonBullets,
      defObj: {
        pick: labelDef,
        confidence: bestDef.confidence,
        riskLabel: bestDef.riskLabel ?? "—",
        bullets: bestDef.bullets || [],
      },
      aggObj: {
        pick: labelAgg,
        confidence: bestAgg.confidence,
        riskLabel: bestAgg.riskLabel ?? "—",
        bullets: bestAgg.bullets || [],
      },
      alternatives: [
        {
          mode: "DEF alt",
          pick: defRanked[1]
            ? defRanked[1].play === "PASS"
              ? "PASS"
              : defRanked[1].cardId || defRanked[1].cardName || defRanked[1].name
            : null,
        },
        {
          mode: "AGG alt",
          pick: aggRanked[1]
            ? aggRanked[1].play === "PASS"
              ? "PASS"
              : aggRanked[1].cardId || aggRanked[1].cardName || aggRanked[1].name
            : null,
        },
      ].filter((x) => x.pick),
      debug: {
        version: VERSION,
        phase: view.phase,
        hand: handMeta,
        scoutIntel: {
          knownIndexes: Object.keys(scoutIntel.byIndex || {}).map((k) => Number(k)),
          mutations: scoutIntel.mutations || [],
        },
        roundState: { flags: view.roundState?.flags || null },
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          nextKnown: !!riskMeta.nextKnown,
          nextKnownSource: riskMeta.nextKnownSource,
          nextKnownPos: riskMeta.nextKnownPos,
          probNextDanger: riskMeta.probNextDanger,
          probNextHarmful: riskMeta.probNextHarmful,
          denSignalActive: !!riskMeta.ctx.denSignalActive,
        },
      },
    });
  }

  // =======================
  // DECISION
  // =======================
  if (phase === "DECISION") {
    const rankedDef0 = scoreDecisions({ view, upcoming: upcomingPeek, profile: profileDef }) || [];
    const rankedAgg0 = scoreDecisions({ view, upcoming: upcomingPeek, profile: profileAgg }) || [];

    const rankedDef = postRankByStyle(rankedDef0, "DEFENSIVE");
    const rankedAgg = postRankByStyle(rankedAgg0, "AGGRESSIVE");

    const bestDef = safeBest(rankedDef, { decision: "—", riskLabel: "MED", confidence: 0.65, bullets: [] });
    const bestAgg = safeBest(rankedAgg, { decision: "—", riskLabel: "MED", confidence: 0.65, bullets: [] });

    const tactical = decisionTacticalAdvice({ view, riskMeta });

    const extraBurrowWarn =
      bestDef.decision === "BURROW" && (view.me?.burrowRemaining ?? 1) === 1
        ? ["Let op: BURROW is schaars (1x per Raid). Alleen doen als het echt nodig is."]
        : [];

    const commonBullets = [
      ...headerLinesCompact(view, riskMeta),
      ...riskBullets,
      ...extraBurrowWarn,
      ...tactical,
    ].filter(Boolean);

    return buildOverlayHint({
      phase,
      title: `Decision advies • Def: ${labelDecision(bestDef)} • Agg: ${labelDecision(bestAgg)}`,
      risk: riskMeta.nextIsDanger ? "HIGH" : riskMeta.nextIsHarmful ? "MED" : "MIX",
      confidence: Math.max(bestDef.confidence ?? 0.7, bestAgg.confidence ?? 0.7),
      commonBullets,
      defObj: {
        pick: labelDecision(bestDef),
        confidence: bestDef.confidence,
        riskLabel: bestDef.riskLabel ?? "—",
        bullets: bestDef.bullets || [],
      },
      aggObj: {
        pick: labelDecision(bestAgg),
        confidence: bestAgg.confidence,
        riskLabel: bestAgg.riskLabel ?? "—",
        bullets: bestAgg.bullets || [],
      },
      alternatives: [
        { mode: "DEF alt", pick: rankedDef[1]?.decision || null },
        { mode: "AGG alt", pick: rankedAgg[1]?.decision || null },
      ].filter((x) => x.pick),
      debug: {
        version: VERSION,
        phase: view.phase,
        hand: handMeta,
        scoutIntel: {
          knownIndexes: Object.keys(scoutIntel.byIndex || {}).map((k) => Number(k)),
          mutations: scoutIntel.mutations || [],
        },
        roundState: {
          decisionCounts: view.roundState?.decisionCounts || null,
          flags: view.roundState?.flags || null,
        },
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          nextKnown: !!riskMeta.nextKnown,
          nextKnownSource: riskMeta.nextKnownSource,
          nextKnownPos: riskMeta.nextKnownPos,
          probNextDanger: riskMeta.probNextDanger,
          probNextHarmful: riskMeta.probNextHarmful,
          denSignalActive: !!riskMeta.ctx.denSignalActive,
        },
      },
    });
  }

  // fallback
  const commonBullets = [`Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`, handMeta.lineHand, "Geen fase herkend."].filter(Boolean);

  return buildOverlayHint({
    phase: phase || "UNKNOWN",
    title: "Hint",
    risk: "MED",
    confidence: 0.6,
    commonBullets,
    defObj: { pick: "—", confidence: 0.6, riskLabel: "—", bullets: [] },
    aggObj: { pick: "—", confidence: 0.6, riskLabel: "—", bullets: [] },
    alternatives: [],
    debug: {
      version: VERSION,
      phase: view.phase,
      hand: handMeta,
      scoutIntel: {
        knownIndexes: Object.keys(scoutIntel.byIndex || {}).map((k) => Number(k)),
        mutations: scoutIntel.mutations || [],
      },
      roundState: view.roundState || null,
    },
  });
}
