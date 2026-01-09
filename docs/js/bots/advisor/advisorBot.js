// /bots/advisor/advisorBot.js
// Log-first Advisor (single source of truth: /log)
// - Werkt ook met legacy /actions docs (zelfde shape: round/phase/playerId/choice)
// - Neemt roundState + flags uit logs mee (Den Signal / Scatter / No-Go Zone / Hold Still / Follow Tail / Burrow Beacon)
// - Per-speler “Scout Intel”: onthoudt (en verplaatst) gescoute event-kennis via track-swaps (Pack Tinker / Kick Up Dust / SHIFT)
// - “Hold Still” = OPS lock (global), NIET target-buff in DECISION
// - Voorkomt “Defensief vs Aanvallend is hetzelfde” via lichte style tie-break
// - Leakt geen event IDs/titels naar UI (sanitizers)
// - NEW output shape: { version, phase, commonBullets, def, agg, ... } voor de nieuwe overlay

import { ADVISOR_PROFILES } from "../core/botConfig.js";
import { buildPlayerView } from "../core/stateView.js";
import { getUpcomingEvents } from "../core/eventIntel.js";
import { scoreMoveMoves, scoreOpsPlays, scoreDecisions } from "../core/scoring.js";

// Action defs + info (1 bron: cards.js)
import { getActionDefByName, getActionInfoByName } from "../../cards.js";

const VERSION = "ADVISOR_V2026-01-09_1";

// ------------------------------
// Utils
// ------------------------------
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}
function pct(x) {
  return `${Math.round(clamp01(x) * 100)}%`;
}
function normalizeKey(s) {
  return String(s || "").trim().toLowerCase();
}
function dedupeLines(lines) {
  const out = [];
  const seen = new Set();
  for (const l of safeArr(lines)) {
    const s = String(l || "").trim();
    if (!s) continue;
    const k = normalizeKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

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
// buildPlayerView geeft: { phase, round, eventTrack, eventCursor, flags, me, playersPublic }
// advisor verwacht: view.game, view.me, view.players, view.phase, view.round
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
// RoundState uit /log (keuzes + flags + tellingen + track ops + scout intel)
// ------------------------------
function parsePosFromScoutChoice(choice, payload) {
  const p0 = Number(payload?.pos ?? payload?.position);
  if (Number.isFinite(p0) && p0 > 0) return p0;

  const m = String(choice || "").match(/MOVE_SCOUT_(\d+)/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function extractSwapIndicesFromPayload(payload) {
  const p = payload || {};
  const a0 = Number(p.indexA ?? p.a ?? p.iA);
  const b0 = Number(p.indexB ?? p.b ?? p.iB);

  if (Number.isFinite(a0) && Number.isFinite(b0)) {
    return { indexA: a0, indexB: b0 };
  }

  // pos1/pos2 zijn 1-based in jouw logs
  const pos1 = Number(p.pos1 ?? p.position1);
  const pos2 = Number(p.pos2 ?? p.position2);
  if (Number.isFinite(pos1) && Number.isFinite(pos2)) {
    return { indexA: pos1 - 1, indexB: pos2 - 1 };
  }

  // andere varianten
  const x = Number(p.x);
  const y = Number(p.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { indexA: x, indexB: y };

  return null;
}

function buildRoundStateFromLog(logs, round) {
  const state = {
    round,
    choices: { move: {}, ops: {}, decision: {} },
    decisionCounts: { LURK: 0, BURROW: 0, DASH: 0 },

    // flags die live gebruikt worden
    flags: {
      scatter: false,
      lockEvents: false,
      opsLocked: false,   // <-- Hold Still (global) (NIEUW)
      denImmune: {},      // {RED:true}
      noPeek: [],         // [pos]
      followTail: {},     // {followerId: targetId}
    },

    // track-manip ops (voor scout-kennis verplaatsen)
    trackOps: [],         // [{at, by, indexA, indexB, actorId}]

    // per speler: wat heeft hij gescout (met timestamp)
    intel: {
      scout: {},           // {playerId: {pos,index,eventId,at}}
    },
  };

  const arr = safeArr(logs)
    .map(normalizeLogRow)
    .filter((d) => (d.round || 0) === round)
    .sort((a, b) => (a.clientAt || 0) - (b.clientAt || 0));

  for (const d of arr) {
    if (!d.playerId || !d.phase || !d.choice) continue;

    if (d.phase === "MOVE") {
      state.choices.move[d.playerId] = { choice: d.choice, payload: d.payload || null };

      // Scout intel (per speler)
      if (String(d.choice).startsWith("MOVE_SCOUT_") || String(d.choice).toUpperCase().includes("SCOUT")) {
        const pos = parsePosFromScoutChoice(d.choice, d.payload);
        const idx = Number.isFinite(Number(d.payload?.index)) ? Number(d.payload.index) : (Number.isFinite(pos) ? pos - 1 : null);
        const eventId = d.payload?.eventId || d.payload?.id || null;

        if (Number.isFinite(pos) && Number.isFinite(idx) && eventId) {
          state.intel.scout[d.playerId] = { pos, index: idx, eventId: String(eventId), at: d.clientAt || 0 };
        }
      }

      // SHIFT kan ook track manipuleren (als je logs payload pos1/pos2 bevat)
      if (String(d.choice || "").toUpperCase().includes("SHIFT")) {
        const sw = extractSwapIndicesFromPayload(d.payload);
        if (sw && Number.isFinite(sw.indexA) && Number.isFinite(sw.indexB)) {
          state.trackOps.push({
            at: d.clientAt || 0,
            by: "SHIFT",
            indexA: sw.indexA,
            indexB: sw.indexB,
            actorId: d.playerId,
          });
        }
      }

      continue;
    }

    if (d.phase === "OPS") {
      state.choices.ops[d.playerId] = { choice: d.choice, payload: d.payload || null };

      const actionName = parseActionNameFromChoice(d.choice, d.payload);

      // flags afleiden uit actie-naam
      if (actionName === "Scatter!") state.flags.scatter = true;
      if (actionName === "Burrow Beacon") state.flags.lockEvents = true;

      // Hold Still = OPS lock (global) (NIEUW)
      if (actionName === "Hold Still") state.flags.opsLocked = true;

      if (actionName === "Den Signal") {
        const c = String(d.payload?.color || d.payload?.denColor || "").trim().toUpperCase();
        if (c) state.flags.denImmune[c] = true;
      }

      if (actionName === "No-Go Zone") {
        const pos = Number(d.payload?.pos ?? d.payload?.position);
        if (Number.isFinite(pos)) state.flags.noPeek.push(pos);
      }

      if (actionName === "Follow the Tail") {
        const tid = d.payload?.targetId || d.payload?.targetPlayerId;
        if (tid) state.flags.followTail[d.playerId] = tid;
      }

      // Track ops: Pack Tinker / Kick Up Dust effect logs (en ook als actie-play payload indices bevat)
      const choiceUpper = String(d.choice || "").toUpperCase();
      const isPackTinker =
        actionName === "Pack Tinker" || choiceUpper.includes("PACK_TINKER") || choiceUpper.includes("EFFECT_PACK_TINKER");
      const isKickUpDust =
        actionName === "Kick Up Dust" || choiceUpper.includes("KICK_UP_DUST") || choiceUpper.includes("EFFECT_KICK_UP_DUST");

      if (isPackTinker || isKickUpDust) {
        const sw = extractSwapIndicesFromPayload(d.payload);
        if (sw && Number.isFinite(sw.indexA) && Number.isFinite(sw.indexB)) {
          state.trackOps.push({
            at: d.clientAt || 0,
            by: isPackTinker ? "PACK_TINKER" : "KICK_UP_DUST",
            indexA: sw.indexA,
            indexB: sw.indexB,
            actorId: d.playerId,
          });
        }
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

  // sort trackOps ook op at
  state.trackOps = safeArr(state.trackOps).sort((a, b) => (a.at || 0) - (b.at || 0));

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
// Event danger/harmful evaluation (baseline LURK)
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

  // Sheepdog Patrol: baseline LURK = veilig (gevaar zit op DASH)
  if (id === "SHEEPDOG_PATROL") return false;

  // Gate Toll: als je geen loot hebt, word je gepakt (als je niet DASHt)
  if (id === "GATE_TOLL") return (ctx.lootCount ?? 0) <= 0;

  // Magpie Snitch: gevaarlijk voor Lead Fox (baseline LURK = gevaar)
  if (id === "MAGPIE_SNITCH") return !!ctx.isLead;

  // Silent Alarm: geen catch, wel penalty (dus niet "dangerous")
  if (id === "SILENT_ALARM") return false;

  // Barn Fire Drill: geen catch
  if (id === "BARN_FIRE_DRILL") return false;

  // Bad Map / Stormy Night: geen directe catch
  if (id === "BAD_MAP" || id === "STORMY_NIGHT") return false;

  return false;
}

function isHarmfulEventForMe(eventId, ctx) {
  const id = String(eventId || "");
  if (!id) return false;

  // Sack reset is nadelig als er iets in Sack zit
  if (id === "PAINT_BOMB_NEST") return (ctx.sackCount ?? 0) > 0;

  // Bad Map = chaos: kan toekomstige events randomizen
  if (id === "BAD_MAP") return true;

  // Stormy Night = condition: verandert waarde/risico van rooster/hond later (altijd impact)
  if (id === "STORMY_NIGHT") return true;

  // Silent Alarm = lead penalty (loot/lead)
  if (id === "SILENT_ALARM") return !!ctx.isLead || (ctx.lootCount ?? 0) >= 2;

  // Barn Fire Drill = Sack eerlijk verdeeld: nadelig als jij juist op Sack/tempo speelt
  if (id === "BARN_FIRE_DRILL") return (ctx.sackCount ?? 0) > 0;

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
  "BAD_MAP",
  "STORMY_NIGHT",
  "SILENT_ALARM",
  "BARN_FIRE_DRILL",
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

  // DEN IDs -> Den-event
  s = s.replace(/\bDEN_(RED|BLUE|GREEN|YELLOW)\b/g, "Den-event");

  // Veel voorkomende titels -> generiek
  s = s.replace(/\bRooster Crow\b/gi, "rooster-event");
  s = s.replace(/\bHidden Nest\b/gi, "bonus-event");
  s = s.replace(/\bSheepdog Patrol\b/gi, "patrol-event");
  s = s.replace(/\bSecond Charge\b/gi, "charge-event");
  s = s.replace(/\bSheepdog Charge\b/gi, "charge-event");
  s = s.replace(/\bPaint[- ]?Bomb Nest\b/gi, "sack-reset event");
  s = s.replace(/\bBad Map\b/gi, "chaos-event");
  s = s.replace(/\bStormy Night\b/gi, "conditie-event");
  s = s.replace(/\bSilent Alarm\b/gi, "lead-penalty event");
  s = s.replace(/\bBarn Fire Drill\b/gi, "sack-split event");

  return s;
}
function sanitizeBullets(bullets) {
  const arr = Array.isArray(bullets) ? bullets : [];
  return arr.map(sanitizeTextNoEventNames);
}

// ------------------------------
// Headerregels (met “bekend 100%”)
// ------------------------------
function headerLinesCompact(view, riskMeta) {
  const knownTag = riskMeta.nextKnown ? " (BEKEND • 100%)" : " (ONBEKEND)";
  return [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    `Volgende kaart: ${riskMeta.nextLabel}${knownTag} • Kans gevaar (deck): ${pct(riskMeta.probNextDanger)} • Kans nadelig (deck): ${pct(riskMeta.probNextHarmful)}`,
  ];
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
// Per speler: Scout Intel (bekende eventId op indices) + verplaats via swaps
// ------------------------------
function buildPlayerScoutIntel({ view, me, roundState }) {
  const myId = me?.id || me?.playerId || null;
  const round = Number(view?.round ?? view?.game?.round ?? 0) || 0;

  const game = view?.game || {};
  const eventIndex = Number(game.eventIndex ?? 0) || 0;

  // prefer: log-derived scout (timestamped)
  let peek = myId ? roundState?.intel?.scout?.[myId] || null : null;

  // fallback: player doc field (geen timestamp -> at=0)
  if (!peek && me?.scoutPeek && Number(me.scoutPeek.round) === round) {
    const idx = Number(me.scoutPeek.index);
    const eventId = me.scoutPeek.eventId;
    if (Number.isFinite(idx) && eventId) {
      peek = { pos: idx + 1, index: idx, eventId: String(eventId), at: 0 };
    }
  }

  const knownByIndex = {}; // index -> eventId
  if (peek && Number.isFinite(Number(peek.index)) && peek.eventId) {
    knownByIndex[Number(peek.index)] = String(peek.eventId);
  }

  // verplaats kennis via trackOps (alleen ops NA scout-moment als we timestamp hebben)
  const ops = safeArr(roundState?.trackOps).sort((a, b) => (a.at || 0) - (b.at || 0));
  const peekAt = Number(peek?.at || 0);

  const hasKey = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  for (const op of ops) {
    const at = Number(op?.at || 0);
    if (peek && peekAt && at && at < peekAt) continue;

    const a = Number(op?.indexA);
    const b = Number(op?.indexB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    const aKnown = hasKey(knownByIndex, a);
    const bKnown = hasKey(knownByIndex, b);
    if (!aKnown && !bKnown) continue;

    const va = aKnown ? knownByIndex[a] : undefined;
    const vb = bKnown ? knownByIndex[b] : undefined;

    // swap
    if (aKnown) knownByIndex[b] = va;
    else delete knownByIndex[b];

    if (bKnown) knownByIndex[a] = vb;
    else delete knownByIndex[a];
  }

  const nextIndex = eventIndex;
  const nextKnownId = Object.prototype.hasOwnProperty.call(knownByIndex, nextIndex)
    ? knownByIndex[nextIndex]
    : null;

  const knownAhead = [];
  for (const [k, v] of Object.entries(knownByIndex)) {
    const idx = Number(k);
    if (!Number.isFinite(idx)) continue;
    if (idx < eventIndex) continue;
    knownAhead.push({ index: idx, eventId: String(v || "") });
  }
  knownAhead.sort((a, b) => a.index - b.index);

  return {
    peek,                // {pos,index,eventId,at} | null
    knownByIndex,        // { [index]: eventId }
    knownAhead,          // [{index,eventId}]
    nextIndex,
    nextKnownId,
    nextKnown: !!nextKnownId,
  };
}

// ------------------------------
// Risk meta (met effective flags + scout-known “100%” status)
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

  // “Deck”-kansen (uit remaining track)
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

  // Scout-known next (100%)
  const nextKnown = !!scoutIntel?.nextKnown;
  const nextKnownId = scoutIntel?.nextKnownId || null;

  const nextKnownIsDanger = nextKnownId ? isDangerousEventForMe(nextKnownId, ctx) : false;
  const nextKnownIsHarmful = nextKnownId ? isHarmfulEventForMe(nextKnownId, ctx) : false;

  const nextLabel = nextKnown
    ? nextKnownIsDanger
      ? "GEVAARLIJK"
      : nextKnownIsHarmful
      ? "VEILIG maar NADELIG"
      : "VEILIG"
    : "ONBEKEND";

  return {
    ctx,
    remaining,
    probNextDanger,
    probNextHarmful,
    pMyDen,
    pCharges,
    pThirdRooster,

    // scout-known
    nextKnown,
    nextKnownId,
    nextKnownIsDanger,
    nextKnownIsHarmful,

    // toonbaar
    nextLabel,
  };
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
        if (p.includes("HOLD STILL")) delta += 0.05;

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
// Extra “Why/How” bullets per keuze (voor je overlay: onderste 2 regels)
// ------------------------------
const ACTION_TIPS = {
  "Molting Mask": {
    why: "Molting Mask: wisselt jouw Den-kleur (kan Den-check ontwijken).",
    how: "Strategie: speel dit als jouw Den-kleur waarschijnlijk ‘in de problemen’ komt, of als je targeting wilt breken.",
  },
  "Pack Tinker": {
    why: "Track manipulation: beïnvloedt toekomstige events.",
    how: "Strategie: gebruik SCOUT-info om een dreiging naar achter te schuiven of een bonus gunstig te timen (werkt niet bij lock).",
  },
  "Burrow Beacon": {
    why: "Burrow Beacon: lockt de Event Track (geen SHIFT/track-manip deze ronde).",
    how: "Strategie: speel dit nadat jij de track gunstig hebt gezet (Scout/Pack Tinker), of als je chaos wilt stoppen.",
  },
  "Hold Still": {
    why: "Hold Still: OPS lock (na deze kaart mag alleen PASS).",
    how: "Strategie: speel dit als jij klaar bent met je sleutelzet en je geen tegenreacties meer wilt toestaan.",
  },
  "Den Signal": {
    why: "Den Signal: jouw gekozen Den-kleur wordt immuun tegen track-catch (deze ronde).",
    how: "Strategie: speel dit als charges/Den-checks waarschijnlijk zijn, of als veel spelers in dezelfde kleur zitten.",
  },
  "Kick Up Dust": {
    why: "Kick Up Dust: veroorzaakt chaos in toekomstige events (als de track niet gelocked is).",
    how: "Strategie: speel als iemand anders voordeel lijkt te hebben van SCOUT/track-planning, of om dreiging weg te spoelen.",
  },
  "Scatter!": {
    why: "Scatter!: niemand mag SCOUTen deze ronde (info-denial).",
    how: "Strategie: speel als jij al info hebt (of als je wil dat anderen jouw plan niet kunnen lezen).",
  },
  "No-Go Zone": {
    why: "No-Go Zone: blokkeert SCOUT op 1 gekozen positie.",
    how: "Strategie: zet op een cruciale positie die jij wil afschermen (bijv. de volgende kaart of een sleutelpositie).",
  },
  "Scent Check": {
    why: "Scent Check: je ziet (straks opnieuw) de DECISION van 1 speler.",
    how: "Strategie: target een sleutelspeler (Lead/high score) om DASH-timing of Hidden Nest beter te spelen.",
  },
  "Follow the Tail": {
    why: "Follow the Tail: jouw DECISION wordt gekopieerd van een andere vos (later).",
    how: "Strategie: kies iemand met betrouwbare timing, of gebruik als ‘verzekering’ als jij onzeker bent.",
  },
  "Alpha Call": {
    why: "Alpha Call: verplaatst de Lead-rol (en dus Lead-risico).",
    how: "Strategie: zet Lead weg bij jezelf als lead-events dreigen, of zet Lead op iemand die kwetsbaar is.",
  },
  "Mask Swap": {
    why: "Mask Swap: husselt Den-kleuren van vossen in de Yard opnieuw.",
    how: "Strategie: sterk als Den-targeting/Den-synergy gevaarlijk wordt of als jij uit de spotlight wil.",
  },
  "Nose for Trouble": {
    why: "Nose for Trouble: je voorspelt de volgende Event kaart (kan beloning geven in huisregels).",
    how: "Strategie: alleen doen als je (via SCOUT) echt hoge zekerheid hebt; anders is het tempoverlies.",
  },
};

function addFlavorBulletsForPick(best, phase, style) {
  const x = best || {};
  const out = [];

  if (phase === "OPS") {
    if (x.play === "PASS") return x;

    const name =
      x.cardName || x.cardId || x.name || (typeof x.play === "string" ? x.play : null);

    const def = name ? getActionDefByName(name) : null;
    const display = def?.name || name || null;
    const tips = display ? ACTION_TIPS[display] : null;

    if (tips?.why) out.push(tips.why);
    if (tips?.how) out.push(tips.how);

    // fallback uit cards.js
    if (!tips && def?.description) {
      out.push(`${def.name}: ${def.description}`);
      out.push("Strategie: speel dit op een moment dat het maximale voordeel geeft en tegenreacties beperkt.");
    }

    return { ...x, bullets: dedupeLines([...out, ...safeArr(x.bullets)]) };
  }

  if (phase === "DECISION") {
    const d = String(x.decision || "").toUpperCase();
    if (d === "LURK") {
      out.push("LURK: veilig blijven en opties openhouden.");
      out.push(style === "DEFENSIVE"
        ? "Strategie: kies LURK als je risico wilt minimaliseren of als je info/controle wil afwachten."
        : "Strategie: kies LURK als je nog niet wil ‘cashen’, maar wel tempo wil bewaren.");
    } else if (d === "BURROW") {
      out.push("BURROW: noodrem tegen vang-events (maar schaars).");
      out.push("Strategie: alleen gebruiken als het risico echt hoog is of als je anders grote buit verliest.");
    } else if (d === "DASH") {
      out.push("DASH: cash out — je scoret nu, maar je verlaat de Yard.");
      out.push("Strategie: kies DASH als timing perfect is (bonus, veel loot, of dreiging die je niet kunt pareren).");
    }
    return { ...x, bullets: dedupeLines([...out, ...safeArr(x.bullets)]) };
  }

  // MOVE: behoud scoring-bullets, geen extra needed
  return x;
}

// ------------------------------
// OPS: tactische override (met scout intel + effective flags)
// (geen “cheat”: next-id specifieke adviezen alleen als nextKnown=true)
// ------------------------------
function pickOpsTacticalAdvice({ view, handNames, riskMeta, scoutIntel, effectiveFlags }) {
  const lines = [];
  const has = (name) => handNames.includes(name);

  const flags = effectiveFlags || view?.game?.flagsRound || view?.flags || {};

  const trackLocked = !!flags.lockEvents;
  const opsLocked = !!flags.opsLocked;

  // 1) Info-voordeel vasthouden (SCOUT)
  if (scoutIntel?.peek) {
    if (!trackLocked && has("Burrow Beacon")) {
      lines.push("OPS tip: je hebt SCOUT-info → **Burrow Beacon** kan de Event Track deze ronde vastzetten (niemand kan SHIFT/Pack Tinker/Kick Up Dust).");
    }
    if (!opsLocked && has("Hold Still")) {
      lines.push("OPS tip: je hebt SCOUT-info → bewaar of speel **Hold Still** op het juiste moment om tegenreacties (track-manip) te stoppen.");
    }
    if (has("Scatter!")) {
      lines.push("OPS tip: jij hebt info → **Scatter!** voorkomt dat anderen ook SCOUTen deze ronde.");
    }
  }

  // 2) Als volgende kaart bekend is: 100% tactiek
  if (riskMeta.nextKnown && riskMeta.nextKnownId) {
    const id = riskMeta.nextKnownId;

    if (riskMeta.nextKnownIsDanger) {
      if (has("Den Signal") && !riskMeta.ctx.denSignalActive) {
        lines.push("OPS tip: volgende kaart is gevaarlijk → **Den Signal** kan jou (en je Den-kleur) beschermen tegen track-catch.");
      }

      if (has("Molting Mask") && riskMeta.pMyDen >= 0.1) {
        lines.push("OPS tip: bij Den-gevaar is **Molting Mask** sterk (kleur-escape).");
      }

      if (!trackLocked && has("Pack Tinker")) {
        lines.push("OPS tip: volgende kaart is gevaarlijk → overweeg **Pack Tinker** om het gevaar naar achter te schuiven.");
      }

      if (!trackLocked && has("Kick Up Dust")) {
        lines.push("OPS tip: als je geen nette swap hebt: **Kick Up Dust** kan de toekomst opschudden (alleen als track niet gelocked is).");
      }
    }

    // bekende nadelige events
    if (id === "PAINT_BOMB_NEST" && (riskMeta.ctx.sackCount ?? 0) > 0) {
      if (!trackLocked && has("Pack Tinker")) lines.push("Let op: er komt een **sack-reset event** → **Pack Tinker** is hier sterk om dit event te verschuiven.");
      if (!trackLocked && has("Kick Up Dust")) lines.push("OPS tip: **Kick Up Dust** kan ook helpen om een sack-reset te vermijden (als track niet gelocked is).");
    }

    if (id === "HIDDEN_NEST") {
      lines.push("Let op: er komt een **DASH-bonus event** → vaak beter om die later te zetten (SHIFT / Pack Tinker), zodat je niet te vroeg uit de Yard vertrekt.");
    }

    if (id === "ROOSTER_CROW") {
      if ((view?.game?.roosterSeen || 0) >= 2) {
        lines.push("Alarm: een **3e rooster-event** is gevaarlijk (raid eindigt). Probeer dit naar achteren te schuiven (Pack Tinker / SHIFT).");
      } else {
        lines.push("Strategie: rooster-events zijn vaak beter later in de track (meer rondes om loot te pakken).");
      }
    }
  } else {
    // 3) Onbekend: alleen kans-based guidance (geen kaart-knowledge)
    if (riskMeta.probNextDanger >= 0.35) {
      if (!trackLocked && has("Pack Tinker")) lines.push("Strategie: kans op gevaar is vrij hoog → bewaar **Pack Tinker** om straks een dreiging te verplaatsen.");
      if (has("Den Signal") && !riskMeta.ctx.denSignalActive) lines.push("Strategie: bij hoge dreiging kan **Den Signal** vaak een veilige default zijn.");
    }
  }

  // 4) Als OPS al gelocked is: reminder
  if (opsLocked) {
    lines.push("Let op: **Hold Still** is actief → er mogen geen nieuwe Action Cards meer gespeeld worden (alleen PASS).");
  }

  return lines.map(sanitizeTextNoEventNames);
}

// ------------------------------
// DECISION: tactische guidance (Den Signal + scout-known next)
// (geen “cheat”: next-id specifieke adviezen alleen als nextKnown=true)
// ------------------------------
function decisionTacticalAdvice({ view, riskMeta, effectiveFlags }) {
  const lines = [];
  const g = view?.game || {};
  const myColor = riskMeta.ctx.myColor || "";
  const flags = effectiveFlags || g.flagsRound || view?.flags || {};

  const denSignalActiveForMe = myColor ? isDenImmuneForColor(flags, myColor) : false;

  if (denSignalActiveForMe) {
    lines.push("Den Signal actief voor jouw kleur → **kies LURK** (dus niet BURROW/DASH) tenzij je bewust ‘cash out’ wilt.");
  }

  // Alleen als volgende kaart bekend is (SCOUT)
  if (riskMeta.nextKnown && riskMeta.nextKnownId) {
    const id = riskMeta.nextKnownId;

    if (id === "HIDDEN_NEST") {
      const dashSoFar = view?.roundState?.decisionCounts?.DASH ?? 0;
      lines.push("Aggressief: **DASH** kan hier extra loot opleveren (alleen als 1–3 spelers DASH kiezen: 3/2/1).");
      if (dashSoFar >= 3) lines.push("Waarschuwing: er zijn al veel DASH-keuzes → bonus wordt snel 0.");
      else lines.push("Check: mik op totaal 1–3 dashers voor maximale bonus.");
      lines.push("Strategie: meestal is het beter om dit bonus-event later te zetten (Pack Tinker / SHIFT), zodat je niet te vroeg uit de Yard vertrekt.");
    }

    if (id === "SHEEPDOG_PATROL") {
      lines.push("Let op: volgende kaart straft **DASH** → kies liever LURK/BURROW.");
    }

    if (id === "ROOSTER_CROW" && (g.roosterSeen || 0) >= 2) {
      lines.push("3e rooster-event is gevaarlijk (raid eindigt). Defensief: voorkom paniek-dash; liever de track fixen (Pack Tinker / SHIFT).");
    }

    if (id === "MAGPIE_SNITCH" && riskMeta.ctx.isLead) {
      lines.push("Let op: Lead-risico is hoog → BURROW kan nodig zijn om niet gepakt te worden.");
    }
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

  // upcoming peek (intern, voor scoring) — we laten dit staan (bestaande functionaliteit)
  const upcomingPeek = getUpcomingEvents(view, 2) || [];

  // hand normaliseren
  const handMeta = summarizeHandRecognition(view.me || me || {});
  if (view?.me) {
    view.me.handNames = handMeta.names;
    view.me.handKnown = handMeta.known;
    view.me.handUnknown = handMeta.unknown;
    view.me.hand = handMeta.names.map((n) => ({ id: n, name: n }));
  }

  // scout intel (per speler)
  const scoutIntel = buildPlayerScoutIntel({ view, me: view.me || me || {}, roundState });
  view.intel = { scout: scoutIntel };

  // risk meta (nu mét “bekend 100%”)
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
    `Kans: Den-event van jouw kleur: ${pct(riskMeta.pMyDen)} • Charges: ${pct(riskMeta.pCharges)} • 3e rooster: ${pct(riskMeta.pThirdRooster)}`,
    riskMeta.ctx.denSignalActive ? "Den Signal actief: je bent veilig tegen charges + jouw Den-event." : null,
    scoutIntel?.nextKnown ? "Scout-info: jij kent de volgende kaart (100% zekerheid)." : null,
  ].filter(Boolean);

  // =======================
  // MOVE
  // =======================
  if (phase === "MOVE") {
    const rankedDef0 = scoreMoveMoves({ view, upcoming: upcomingPeek, profile: profileDef }) || [];
    const rankedAgg0 = scoreMoveMoves({ view, upcoming: upcomingPeek, profile: profileAgg }) || [];

    const rankedDef = postRankByStyle(rankedDef0, "DEFENSIVE");
    const rankedAgg = postRankByStyle(rankedAgg0, "AGGRESSIVE");

    const bestDef0 = safeBest(rankedDef, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });
    const bestAgg0 = safeBest(rankedAgg, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });

    const bestDef = addFlavorBulletsForPick(bestDef0, "MOVE", "DEFENSIVE");
    const bestAgg = addFlavorBulletsForPick(bestAgg0, "MOVE", "AGGRESSIVE");

    const strat = [];
    if (riskMeta.probNextDanger >= 0.35) strat.push("Strategie: kans op gevaar is vrij hoog → overweeg **SHIFT** (MOVE) om gevaar naar achter te duwen.");
    if (scoutIntel?.peek && !effectiveFlags.lockEvents) strat.push("Strategie: jij hebt SCOUT-info → probeer die info-voorsprong vast te houden (ops lock / track lock).");

    const commonBullets = [
      ...headerLinesCompact(view, riskMeta),
      ...riskBullets,
      ...sanitizeBullets(strat),
    ].filter(Boolean);

    return buildOverlayHint({
      phase,
      title: `MOVE advies • Def: ${labelMove(bestDef)} • Agg: ${labelMove(bestAgg)}`,
      risk: riskMeta.nextKnown && riskMeta.nextKnownIsDanger ? "HIGH" : "MIX",
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
        roundState: {
          decisionCounts: view.roundState?.decisionCounts || null,
          flags: view.roundState?.flags || null,
          trackOps: view.roundState?.trackOps || null,
          scout: view.roundState?.intel?.scout || null,
        },
        intel: { scout: scoutIntel },
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          nextKnown: !!riskMeta.nextKnown,
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

    const defRanked0 = postRankByStyle(def0, "DEFENSIVE");
    const aggRanked0 = postRankByStyle(agg0, "AGGRESSIVE");

    const bestDef0 = safeBest(defRanked0, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });
    const bestAgg0 = safeBest(aggRanked0, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });

    const bestDef = addFlavorBulletsForPick(bestDef0, "OPS", "DEFENSIVE");
    const bestAgg = addFlavorBulletsForPick(bestAgg0, "OPS", "AGGRESSIVE");

    const labelDef = labelPlay(bestDef);
    const labelAgg = labelPlay(bestAgg);

    const tactical = pickOpsTacticalAdvice({
      view,
      handNames: handMeta.names,
      riskMeta,
      scoutIntel,
      effectiveFlags,
    });

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
      risk: riskMeta.nextKnown && riskMeta.nextKnownIsDanger ? "HIGH" : "MIX",
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
          pick: defRanked0[1]
            ? defRanked0[1].play === "PASS"
              ? "PASS"
              : defRanked0[1].cardId || defRanked0[1].cardName || defRanked0[1].name
            : null,
        },
        {
          mode: "AGG alt",
          pick: aggRanked0[1]
            ? aggRanked0[1].play === "PASS"
              ? "PASS"
              : aggRanked0[1].cardId || aggRanked0[1].cardName || aggRanked0[1].name
            : null,
        },
      ].filter((x) => x.pick),
      debug: {
        version: VERSION,
        phase: view.phase,
        hand: handMeta,
        roundState: { flags: view.roundState?.flags || null, trackOps: view.roundState?.trackOps || null },
        intel: { scout: scoutIntel },
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          nextKnown: !!riskMeta.nextKnown,
          probNextDanger: riskMeta.probNextDanger,
          probNextHarmful: riskMeta.probNextHarmful,
          denSignalActive: !!riskMeta.ctx.denSignalActive,
          trackLocked: !!effectiveFlags.lockEvents,
          opsLocked: !!effectiveFlags.opsLocked,
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

    const bestDef0 = safeBest(rankedDef, { decision: "—", riskLabel: "MED", confidence: 0.65, bullets: [] });
    const bestAgg0 = safeBest(rankedAgg, { decision: "—", riskLabel: "MED", confidence: 0.65, bullets: [] });

    const bestDef = addFlavorBulletsForPick(bestDef0, "DECISION", "DEFENSIVE");
    const bestAgg = addFlavorBulletsForPick(bestAgg0, "DECISION", "AGGRESSIVE");

    const tactical = decisionTacticalAdvice({ view, riskMeta, effectiveFlags });

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
      risk: riskMeta.nextKnown && riskMeta.nextKnownIsDanger ? "HIGH" : "MIX",
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
        roundState: {
          decisionCounts: view.roundState?.decisionCounts || null,
          flags: view.roundState?.flags || null,
          trackOps: view.roundState?.trackOps || null,
        },
        intel: { scout: scoutIntel },
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          nextKnown: !!riskMeta.nextKnown,
          probNextDanger: riskMeta.probNextDanger,
          probNextHarmful: riskMeta.probNextHarmful,
          denSignalActive: !!riskMeta.ctx.denSignalActive,
        },
      },
    });
  }

  // fallback
  const commonBullets = [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    handMeta.lineHand,
    "Geen fase herkend.",
  ].filter(Boolean);

  return buildOverlayHint({
    phase: phase || "UNKNOWN",
    title: "Hint",
    risk: "MED",
    confidence: 0.6,
    commonBullets,
    defObj: { pick: "—", confidence: 0.6, riskLabel: "—", bullets: [] },
    aggObj: { pick: "—", confidence: 0.6, riskLabel: "—", bullets: [] },
    alternatives: [],
    debug: { version: VERSION, phase: view.phase, hand: handMeta, roundState: view.roundState || null },
  });
}
