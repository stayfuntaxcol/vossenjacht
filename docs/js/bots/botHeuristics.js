// docs/js/bots/botHeuristics.js
// Heuristics for VOSSENJACHT bots
// - Backwards compatible exports: BOT_WEIGHTS, BOT_PRESETS, presetFromDenColor,
//   scoreEventFacts, scoreActionFacts, rankActions
// - Added exports: pickActionOrPass, recommendDecision
//
// Key upgrades:
// - Action economy: budget per round + reserve hand size
// - Diminishing returns on intel actions when bot already has "nextKnown"
// - Pack Tinker / Kick Up Dust: only good in specific conditions
// - Defense gets extra value when dangerNext is high
// - Optional decision recommendation (DASH/BURROW/LURK) based on carry + danger

import { RULES_INDEX, getEventFacts, getActionFacts } from "./rulesIndex.js";
import { evaluateCorePolicy, DEFAULT_CORE_CONFIG } from "./botPolicyCore.js";
import { applyActionStrategies } from "./strategies/actionStrategies.js";
import { buildComboInfoFromHand } from "./actionComboMatrix.js";

/* ============================================================
   1) Presets (koppel aan Den-kleur)
============================================================ */
export const BOT_PRESETS = {
  RED: {
    weights: { risk: 0.75, loot: 1.05, info: 0.8, control: 0.85, tempo: 1.25 },
    unimplementedMult: 0.9,
    tagBias: {
      ROOSTER_TICK: 1.2,
      raid_end_trigger: 1.2,
      dash_reward: 1.1,

      maxActionsPerRound: 1,
      actionReserveEarly: 1,
      actionReserveLate: 1,
      actionPlayMinTotal: 2.6,
      emergencyActionTotal: 7.5,

      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },

  GREEN: {
    weights: { risk: 1.35, loot: 0.95, info: 0.9, control: 1.1, tempo: 0.75 },
    unimplementedMult: 0.9,
    tagBias: {
      CATCH_DASHERS: 1.25,
      CATCH_ALL_YARD: 1.2,
      CATCH_BY_DEN_COLOR: 1.15,
      DEN_IMMUNITY: 1.25,
      LOCK_EVENTS: 1.1,
      LOCK_OPS: 1.1,

      maxActionsPerRound: 1,
      actionReserveEarly: 1,
      actionReserveLate: 1,
      actionPlayMinTotal: 3.2,
      emergencyActionTotal: 7.8,

      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },

  YELLOW: {
    weights: { risk: 1.0, loot: 1.35, info: 0.85, control: 0.85, tempo: 0.9 },
    unimplementedMult: 0.9,
    tagBias: {
      dash_reward: 1.25,
      multi_dasher_bonus: 1.2,
      reset_sack: 1.35,

      maxActionsPerRound: 1,
      actionReserveEarly: 1,
      actionReserveLate: 1,
      actionPlayMinTotal: 3.6,
      emergencyActionTotal: 7.8,

      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },

  BLUE: {
    weights: { risk: 1.05, loot: 0.95, info: 1.25, control: 1.25, tempo: 0.85 },
    unimplementedMult: 0.9,
    tagBias: {
      INFO: 1.2,
      PEEK_DECISION: 1.15,
      PREDICT_EVENT: 1.2,
      TRACK_MANIP: 1.2,
      SWAP_MANUAL: 1.1,
      BLOCK_SCOUT: 1.2,
      BLOCK_SCOUT_POS: 1.15,

      maxActionsPerRound: 1,
      actionReserveEarly: 1,
      actionReserveLate: 1,
      actionPlayMinTotal: 3.0,
      emergencyActionTotal: 7.6,

      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },
};

// Backwards compat default
export const BOT_WEIGHTS = BOT_PRESETS.BLUE.weights;

export function presetFromDenColor(denColor) {
  const c = String(denColor || "").trim().toUpperCase();
  if (!c) return "BLUE";
  if (c === "ROOD" || c === "RED") return "RED";
  if (c === "GROEN" || c === "GREEN") return "GREEN";
  if (c === "GEEL" || c === "YELLOW") return "YELLOW";
  if (c === "BLAUW" || c === "BLUE") return "BLUE";
  return "BLUE";
}

function myDenEventAlreadyRevealed(game, denColor) {
  const c = String(denColor || "").trim().toUpperCase();
  if (!c) return null;

  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];

  if (!track.length) return null;

  const denId = `DEN_${c}`;

  if (rev.length) {
    const n = Math.min(track.length, rev.length);
    for (let i = 0; i < n; i++) {
      if (rev[i] === true && String(track[i] || "") === denId) return true;
    }
    if (track.some((x) => String(x || "") === denId)) return false;
    return null;
  }

  return null;
}

function getPreset(presetKey, denColor) {
  const key = String(presetKey || "").trim().toUpperCase() || presetFromDenColor(denColor);
  return BOT_PRESETS[key] || BOT_PRESETS.BLUE;
}

/* ============================================================
   2) Base tag scores
============================================================ */
const EVENT_TAG_SCORES = {
  CATCH_DASHERS: { risk: 8, tempo: 1 },
  CATCH_ALL_YARD: { risk: 7, tempo: 1 },
  CATCH_BY_DEN_COLOR: { risk: 4, tempo: 0 },

  ROOSTER_TICK: { tempo: 6 },
  raid_end_trigger: { tempo: 6 },

  dash_reward: { loot: 6 },
  multi_dasher_bonus: { loot: 3 },

  pay_loot_or_caught: { risk: 4, loot: -3 },
  lose_loot: { risk: 5, loot: -6 },

  reset_sack: { loot: -4, control: 1 },
  fair_split: { loot: -1, control: -1 },
  redistribute_sack: { loot: -2, control: -2 },
};

const ACTION_TAG_SCORES = {
  // info
  INFO: { info: 6 },
  PEEK_DECISION: { info: 5 },
  PREDICT_EVENT: { info: 4 },

  // control / track
  TRACK_MANIP: { control: 6 },
  SWAP_MANUAL: { control: 7 },
  SWAP_RANDOM: { control: 4 },
  LOCK_EVENTS: { control: 4 },

  // deny info
  BLOCK_SCOUT: { control: 2 },
  BLOCK_SCOUT_POS: { control: 2 },

  // defense
  DEN_IMMUNITY: { risk: -6, control: 2 },
  LOCK_OPS: { control: 2, tempo: 0 },

  // utility
  COPY_DECISION_LATER: { info: 2, control: 2, risk: 2 },
  SET_LEAD: { control: 4 },

  DISCARD_SWAP: { control: 3, info: 2, tempo: 1 },
};

const DIM_KEYS = ["risk", "loot", "info", "control", "tempo"];

function normColor(c) {
  return String(c || "").trim().toUpperCase();
}
function safeTags(x) {
  return Array.isArray(x) ? x : [];
}

function normTag(t) {
  return String(t || "").trim().toUpperCase();
}
function hasTag(tags, want) {
  const w = normTag(want);
  for (const t of safeTags(tags)) {
    if (normTag(t) === w) return true;
  }
  return false;
}
function findKeyInsensitive(obj, key) {
  if (!obj || !key) return null;
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(obj, k)) return k;
  const up = k.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(obj, up)) return up;
  const lo = k.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(obj, lo)) return lo;
  const nk = normTag(k);
  for (const kk of Object.keys(obj)) {
    if (normTag(kk) === nk) return kk;
  }
  return null;
}
function blankScores() {
  return { risk: 0, loot: 0, info: 0, control: 0, tempo: 0 };
}
function addInto(out, add, scale = 1) {
  if (!out || !add) return out;
  for (const k of DIM_KEYS) out[k] += (add[k] || 0) * scale;
  return out;
}
function sumTagScores(tags, map, preset) {
  const out = blankScores();
  const bias = preset?.tagBias || {};

  for (const rawTag of safeTags(tags)) {
    const mapKey = findKeyInsensitive(map, rawTag);
    if (!mapKey) continue;
    const s = map[mapKey];
    if (!s) continue;

    const biasKey = findKeyInsensitive(bias, rawTag) || findKeyInsensitive(bias, mapKey);
    const scale = biasKey && Number.isFinite(bias[biasKey]) ? bias[biasKey] : 1;
    addInto(out, s, scale);
  }

  return out;
}
function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
function totalScore(s) {
  if (!s) return -999999;
  return (s.controlScore || 0) + (s.infoScore || 0) + (s.lootScore || 0) + (s.tempoScore || 0) - (s.riskScore || 0);
}
function normForMatch(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

/* ============================================================
   3) Resolve keys
============================================================ */
function resolveEventKey(input, opts = {}) {
  const raw = String(input || "").trim();
  if (!raw) return { id: null, f: null };

  const fDirect = getEventFactsScoped(raw, opts);
  if (fDirect) return { id: fDirect.id, f: fDirect };

  const n = normForMatch(raw);
  for (const [id, f0] of Object.entries(RULES_INDEX?.events || {})) {
    if (!f0) continue;
    if (normForMatch(f0.title) === n) {
      const f = getEventFactsScoped(id, opts) || f0;
      return { id, f };
    }
  }
  return { id: null, f: null };
}

function resolveActionKey(input) {
  const raw = String(input || "").trim();
  if (!raw) return { id: null, a: null };
  const aDirect = getActionFacts(raw);
  if (aDirect) return { id: aDirect.id, a: aDirect };

  const n = normForMatch(raw);
  for (const [id, a] of Object.entries(RULES_INDEX?.actions || {})) {
    if (!a) continue;
    if (normForMatch(a.name) === n) return { id, a };
  }
  const stripped = raw.replace(/^ACTION_/, "");
  if (stripped !== raw) return resolveActionKey(stripped);

  return { id: null, a: null };
}

/* ============================================================
   4) Context helpers
============================================================ */
function getCtx(opts = {}) {
  const ctx = opts?.ctx && typeof opts.ctx === "object" ? opts.ctx : {};
  const game = opts?.game || ctx?.game || null;
  const me = opts?.me || ctx?.me || null;
  return { ctx, game, me };
}

function computeIsLead(game, me, ctx) {
  if (ctx && typeof ctx.isLead === "boolean") return ctx.isLead;
  const leadId = game?.leadFoxId || game?.leadId || game?.leadFox || game?.leadPlayerId || game?.lead || null;
  if (!leadId || !me?.id) return false;
  return String(leadId) === String(me.id);
}

function getScopedDenColor(opts = {}) {
  const { ctx, me } = getCtx(opts);
  return normColor(opts?.denColor || ctx?.denColor || me?.denColor || me?.den || me?.color || "");
}

function getEventFactsScoped(eventKey, opts = {}) {
  const raw = String(eventKey || "").trim();
  if (!raw) return null;

  const base = getEventFacts(raw) || null;
  if (!base) return null;

  const { ctx, game, me } = getCtx(opts);
  const denColor = getScopedDenColor(opts);
  const isLead = computeIsLead(game, me, ctx);

  // Den Signal immunity (engine flag): denImmune[DEN] => DEN_* + DOG_CHARGE/SECOND_CHARGE are neutralized for that den
  const denImmune =
    (ctx?.flagsRound && typeof ctx.flagsRound === "object" ? ctx.flagsRound.denImmune : null) ||
    (game?.flagsRound && typeof game.flagsRound === "object" ? game.flagsRound.denImmune : null) ||
    null;

  const myImmune = !!(denImmune && denColor && denImmune[denColor]);
  const f = {
    ...base,
    tags: Array.isArray(base.tags) ? [...base.tags] : [],
    dangerNotes: Array.isArray(base.dangerNotes) ? [...base.dangerNotes] : [],
    lootImpact: base.lootImpact ? { ...base.lootImpact, notes: Array.isArray(base.lootImpact.notes) ? [...base.lootImpact.notes] : [] } : base.lootImpact,
  };

  const id = String(f.id || raw).trim();
  const cat = String(f.category || "").trim().toUpperCase();

  // --- DEN events are only dangerous for matching denColor ---
  if (cat === "DEN" || id.startsWith("DEN_")) {
    const color = id.split("_")[1] ? id.split("_")[1].toUpperCase() : "";
    const match = !!(denColor && color && denColor === color);
    if (!match) {
      f.dangerDash = 0;
      f.dangerLurk = 0;
      f.dangerBurrow = 0;
      f.tags = f.tags.filter((t) => normTag(t) !== "CATCH_BY_DEN_COLOR");
      f.dangerNotes.push("DEN event not matching your color: treated as safe.");
    } else if (myImmune) {
      // ✅ Den Signal active for your den => DEN_* is neutralized (no need to DASH/BURROW)
      f.dangerDash = 0;
      f.dangerLurk = 0;
      f.dangerBurrow = 0;
      f.dangerNotes.push("DEN_SIGNAL: denImmune actief -> DEN-event geneutraliseerd (stay veilig).");
    }
  }

  // --- Lead-only events should not scare non-leads into mass DASH ---
  const appliesTo = String(f.lootImpact?.appliesTo || "").trim().toUpperCase();
  const leadOnly = appliesTo === "LEAD" || hasTag(f.tags, "LEAD_ONLY") || id === "MAGPIE_SNITCH" || id === "SILENT_ALARM";
  if (leadOnly && !isLead) {
    f.dangerDash = 0;
    f.dangerLurk = 0;
    f.dangerBurrow = 0;
    const drop = new Set(["LOSE_LOOT", "PAY_LOOT_OR_CAUGHT", "PAY_LOOT", "LEAD_ONLY"]);
    f.tags = f.tags.filter((t) => !drop.has(normTag(t)));
    f.dangerNotes.push("Lead-only event: non-lead treated as low immediate risk.");
  }

  // ✅ Den Signal active for your den => DOG_CHARGE / SECOND_CHARGE is neutralized
  if (myImmune && (id === "DOG_CHARGE" || id === "SECOND_CHARGE")) {
    f.dangerDash = 0;
    f.dangerLurk = 0;
    f.dangerBurrow = 0;
    f.dangerNotes.push("DEN_SIGNAL: denImmune actief -> DOG charge geneutraliseerd (stay veilig).");
  }

  // --- ROOSTER_CROW: only treat as dangerous on 3rd occurrence (raid-end trigger) ---
if (id === "ROOSTER_CROW") {
  // Determine which Rooster Crow this is (1st/2nd/3rd) WITHOUT extra Firestore state.
  // We infer it from eventTrack + eventIndex, with an off-by-one fallback.
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idxRaw = Number(game?.eventIndex);
  const idx = Number.isFinite(idxRaw) ? idxRaw : 0;

  // If caller knows the position (optional), use it.
  let pos = Number.isFinite(Number(ctx?.nextEventPos)) ? Number(ctx.nextEventPos) : null;

  if (pos == null) {
    // Try: current index is this event
    if (track[idx] === "ROOSTER_CROW") pos = idx;
    // Try: previous index is this event (common off-by-one depending on when eventIndex increments)
    else if (idx > 0 && track[idx - 1] === "ROOSTER_CROW") pos = idx - 1;
    else {
      // Find the nearest Rooster at/after idx-1 (prefer upcoming)
      const start = Math.max(0, idx - 1);
      let found = -1;
      for (let j = start; j < track.length; j++) {
        if (track[j] === "ROOSTER_CROW") { found = j; break; }
      }
      if (found >= 0) pos = found;
      else {
        const any = track.findIndex((x) => String(x) === "ROOSTER_CROW");
        pos = any >= 0 ? any : null;
      }
    }
  }

  const roostersBefore =
    pos != null && pos >= 0
      ? track.slice(0, pos).filter((x) => String(x) === "ROOSTER_CROW").length
      : 0;

  // Occurrence number for THIS Rooster Crow
  const occ = roostersBefore + 1;


    if (occ <= 2) {
      // First two Rooster Crow cards are mostly "noise/tempo" — not a capture spike.
      // Encourage LURK over BURROW (and don't waste BURROW early).
      f.dangerDash = Math.min(Number(f.dangerDash || 0), 1.0);
      f.dangerLurk = Math.min(Number(f.dangerLurk || 0), 0.5);
      f.dangerBurrow = Math.min(Number(f.dangerBurrow || 0), 1.0);

      // Remove endgame tags (if present) for early roosters
      const drop = new Set(["ROOSTER_TICK", "RAID_END_TRIGGER", "RAID_END", "END_TRIGGER"]);
      f.tags = (Array.isArray(f.tags) ? f.tags : []).filter((t) => !drop.has(normTag(t)));

      f.dangerNotes.push(`Rooster Crow #${occ}: treated as low capture risk (only the 3rd should feel like endgame).`);
    }
  }

  return f;
}

function guessRound(game) {
  const r = Number(game?.round);
  if (Number.isFinite(r) && r > 0) return r;
  return 1;
}

function isLateGame(game) {
  const round = guessRound(game);
  const idx = Number(game?.eventIndex);
  const trackLen = Array.isArray(game?.eventTrack) ? game.eventTrack.length : 0;
  const byRound = round >= 6;
  const byTrack = Number.isFinite(idx) && trackLen ? idx >= Math.max(0, trackLen - 4) : false;
  return byRound || byTrack;
}

function isEarlyGame(game) {
  const round = guessRound(game);
  const idx = Number(game?.eventIndex);
  const byRound = round <= 2;
  const byTrack = Number.isFinite(idx) ? idx <= 2 : false;
  return byRound || byTrack;
}

function getNextEventKey(game, ctx) {
  // noPeek: do not infer next unrevealed card from eventTrack
  if (game?.flagsRound?.noPeek === true) return null;

  const idx = Number(game?.eventIndex);
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  if (!track.length) return null;
  if (!Number.isFinite(idx) || idx < 0 || idx >= track.length) return track[0] || null;
  return track[idx] || null;
}

function getDangerPeakFromFacts(f) {
  if (!f) return 0;
  return Math.max(f.dangerDash || 0, f.dangerLurk || 0, f.dangerBurrow || 0);
}

function getDangerStayFromFacts(f) {
  if (!f) return 0;
  const lurk = Number(f.dangerLurk || 0);
  const burrow = Number(f.dangerBurrow || 0);

  // If both defensive options are 0, treat as safe for cashout purposes.
  if (lurk <= 0 && burrow <= 0) return 0;

  // Staying means you can pick the safer of LURK/BURROW.
  return Math.min(lurk, burrow);
}


function getNextEventFactsFromOpts(opts = {}) {
  const { ctx, game } = getCtx(opts);
  if (ctx?.nextEventFacts) return ctx.nextEventFacts;
  if (ctx?.nextEventKey) return getEventFactsScoped(ctx.nextEventKey, opts) || null;
  const k = getNextEventKey(game, ctx);
  return k ? getEventFactsScoped(k, opts) || null : null;
}

function getDangerNext(opts = {}) {
  const f = getNextEventFactsFromOpts(opts);
  return getDangerPeakFromFacts(f);
}

function getActionsPlayedThisRound(opts = {}) {
  const { ctx } = getCtx(opts);
  const v = ctx?.actionsPlayedThisRound ?? ctx?.playsThisRound ?? ctx?.playedThisRound ?? ctx?.actionsThisRound ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getHandCount(me, actionKeys) {
  const candidates = [me?.hand, me?.actionHand, me?.actionCards, me?.actions, me?.cards];
  for (const c of candidates) if (Array.isArray(c)) return c.length;
  return Array.isArray(actionKeys) ? actionKeys.length : 0;
}

function getScoreRankHints(opts = {}) {
  const { ctx } = getCtx(opts);
  const isLast = !!(ctx?.isLast || ctx?.rank === "LAST" || ctx?.rankFromEnd === 1);
  const behind = Number(ctx?.scoreBehind ?? ctx?.deltaScore ?? 0);
  return { isLast, scoreBehind: Number.isFinite(behind) ? behind : 0 };
}

function computeHandMeta(actionKeys = []) {
  const meta = { ids: [], resolved: [], countByActionId: {}, hasDefense: false, hasIntel: false, hasTrack: false };
  const list = Array.isArray(actionKeys) ? actionKeys : [];
  meta.ids = [...list];

  for (const key of list) {
    const { a } = resolveActionKey(key);
    if (!a) continue;

    meta.resolved.push(a);
    meta.countByActionId[a.id] = (meta.countByActionId[a.id] || 0) + 1;

    const tags = safeTags(a.tags);
    if (a.role === "defense" || hasTag(tags, "DEN_IMMUNITY")) meta.hasDefense = true;
    if (a.role === "info" || hasTag(tags, "INFO") || hasTag(tags, "PEEK_DECISION") || hasTag(tags, "PREDICT_EVENT")) meta.hasIntel = true;
    if (a.role === "control" || hasTag(tags, "TRACK_MANIP") || hasTag(tags, "SWAP_MANUAL") || hasTag(tags, "LOCK_EVENTS")) meta.hasTrack = true;
  }

  return meta;
}

function getKnownUpcomingEvents(opts = {}) {
  const { ctx, game } = getCtx(opts);

  const list =
    (Array.isArray(ctx?.knownUpcomingEvents) && ctx.knownUpcomingEvents) ||
    (Array.isArray(ctx?.nextKnownEvents) && ctx.nextKnownEvents) ||
    (Array.isArray(ctx?.visibleUpcomingEvents) && ctx.visibleUpcomingEvents) ||
    null;

  if (list && list.length) return list.map((x) => String(x || "").trim()).filter(Boolean);

  // fallback: use global revealed positions (not player-specific)
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];
  const idx = Number.isFinite(game?.eventIndex) ? game.eventIndex : 0;

  const out = [];
  for (let i = idx; i < Math.min(track.length, idx + 5); i++) {
    if (rev[i] === true) out.push(String(track[i] || "").trim());
  }
  return out;
}

function actionHasAnyTag(a, wanted = []) {
  if (!a) return false;
  const tags = safeTags(a.tags);
  return wanted.some((t) => hasTag(tags, t));
}
function isIntelAction(a) {
  return a?.role === "info" || actionHasAnyTag(a, ["INFO", "PEEK_DECISION", "PREDICT_EVENT"]);
}
function isDefenseAction(a) {
  return a?.role === "defense" || actionHasAnyTag(a, ["DEN_IMMUNITY"]);
}
function isTrackManipAction(a) {
  return a?.role === "control" || actionHasAnyTag(a, ["TRACK_MANIP", "SWAP_MANUAL", "LOCK_EVENTS", "SWAP_RANDOM"]);
}

function isDangerousEventByFacts(f, threshold = 7) {
  if (!f) return false;
  const peak = getDangerPeakFromFacts(f);
  if (peak >= threshold) return true;
  const tags = safeTags(f.tags);
  if (hasTag(tags, "CATCH_DASHERS") || hasTag(tags, "CATCH_ALL_YARD")) return true;
  return false;
}

function estimateCarryValue(me) {
  if (!me) return 0;

  const eggs = Number(me?.eggs);
  const hens = Number(me?.hens);
  const prize = Number(me?.prize);
  if (Number.isFinite(eggs) || Number.isFinite(hens) || Number.isFinite(prize)) {
    return (Number.isFinite(eggs) ? eggs * 1 : 0) + (Number.isFinite(hens) ? hens * 2 : 0) + (Number.isFinite(prize) ? prize * 3 : 0);
  }

  const lootArr = me?.loot || me?.sack || me?.bag || null;
  if (!Array.isArray(lootArr)) return 0;

  let v = 0;
  for (const it of lootArr) {
    const s = typeof it === "string" ? it : it?.type || it?.id || it?.key || "";
    const t = String(s || "").toUpperCase();
    if (!t) continue;
    if (t.includes("PRIZE")) v += 3;
    else if (t.includes("HEN")) v += 2;
    else if (t.includes("EGG")) v += 1;
    else v += 1;
  }
  return v;
}

/* ============================================================
   5) Public scoring API
============================================================ */
export function scoreEventFacts(eventKey, opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const w = preset.weights || BOT_WEIGHTS;

  const { f } = resolveEventKey(eventKey, opts);
  if (!f) return null;

  const tagScore = sumTagScores(f.tags, EVENT_TAG_SCORES, preset);
  const dangerPeak = getDangerPeakFromFacts(f);

  const implemented = !!f.engineImplemented;
  const reliability = implemented ? 1.0 : (preset.unimplementedMult ?? 0.9);

  return {
    eventId: f.id,
    title: f.title,
    implemented,
    dangerPeak,
    riskScore: ((dangerPeak + tagScore.risk) * w.risk) / reliability,
    lootScore: (tagScore.loot * w.loot) * reliability,
    infoScore: (tagScore.info * w.info) * reliability,
    controlScore: (tagScore.control * w.control) * reliability,
    tempoScore: (tagScore.tempo * w.tempo) * reliability,
    notes: [...(f.dangerNotes || []), ...((f.lootImpact && f.lootImpact.notes) || [])],
    tags: f.tags || [],
  };
}

export function scoreActionFacts(actionKey, opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const w = preset.weights || BOT_WEIGHTS;

  const { ctx, game, me } = getCtx(opts);
  const { a } = resolveActionKey(actionKey);
  if (!a) return null;

  const tagScore = sumTagScores(a.tags, ACTION_TAG_SCORES, preset);

  const roleBonus =
    {
      defense: { risk: -2, control: 1 },
      info: { info: 2 },
      control: { control: 2 },
      chaos: { control: 1, tempo: 1 },
      tempo: { tempo: 2, control: 1 },
      utility: { control: 1, info: 1 },
    }[a.role] || {};

  // Soft signal when tags incomplete
  const affectsFlags = Array.isArray(a.affectsFlags) ? a.affectsFlags : [];
  const affectsTrack = !!a.affectsTrack;

  const soft = blankScores();
  if (affectsTrack) soft.control += 1;
  if (affectsFlags.includes("lockEvents")) soft.control += 1;
  if (affectsFlags.includes("denImmune")) soft.risk -= 1;
  if (affectsFlags.includes("noPeek")) soft.control += 0.5;

  // --- Context-aware heuristics ---
  const dangerNext = Number.isFinite(Number(ctx?.dangerNext))
    ? Number(ctx.dangerNext)
    : getDangerNext(opts);
  const emergency = dangerNext >= 8 || ctx?.emergency === true;

  const playedThisRound = getActionsPlayedThisRound(opts);
  const handCount = getHandCount(me, ctx?._handKeys);
  const early = isEarlyGame(game);
  const late = isLateGame(game);

  const maxPerRound = Number(preset?.tagBias?.maxActionsPerRound ?? 1) || 1;
  const reserveEarly = Number(preset?.tagBias?.actionReserveEarly ?? 2);
  const reserveLate = Number(preset?.tagBias?.actionReserveLate ?? 1);
  const reserve = Math.max(1, late ? reserveLate : reserveEarly);

  const projectedHandAfterPlay = Math.max(0, handCount - 1);

  // A) budget (soft cap, not a hard rule)
  const comboAllowed = !!(ctx?.comboAllowed || ctx?.comboFollowUp || ctx?.comboPrimed);
  const allowOverBudget = emergency || comboAllowed;

  // How far beyond the soft cap are we?
  const over = Math.max(0, (playedThisRound - maxPerRound) + 1);

  if (over > 0 && !allowOverBudget) {
    // Strong discouragement, but still beatable by truly high-value actions
    soft.risk += 3.5 * over;
    soft.tempo -= 1.6 * over;
    soft.control -= 0.9 * over;
    soft.info -= 0.5 * over;
  } else if (over > 0 && allowOverBudget) {
    // Combos/emergency may justify spending more cards
    soft.risk += 1.1 * over;
    soft.tempo -= 0.4 * over;
  }

  // B) reserve
  if (!emergency && projectedHandAfterPlay < reserve) {
    soft.risk += 5.0;
    soft.tempo -= 1.5;
    soft.control -= 0.75;
  }

  // C) diminishing returns for intel
  const nextKnown = !!(ctx?.nextKnown || ctx?.scoutIntel?.nextKnown || ctx?.intel?.nextKnown || ctx?.knownNext);
  const knownUpcoming = getKnownUpcomingEvents(opts);
  const knownCount = Array.isArray(knownUpcoming) ? knownUpcoming.length : 0;

  if (!emergency && isIntelAction(a) && (nextKnown || knownCount >= 2)) {
    soft.info -= 4.0;
    soft.tempo -= 1.0;
    soft.risk += 0.75;
  }

  // D) Pack Tinker strict conditions
  const isPackTinker = a.id === "PACK_TINKER";
  if (isPackTinker) {
    const lookN = Number(preset?.tagBias?.packTinkerLookahead ?? 4);
    const list = knownUpcoming.slice(0, clamp(lookN, 2, 6));
    const facts = list.map((k) => getEventFactsScoped(k, opts) || null).filter(Boolean);

    const hasBad = facts.some((f) => isDangerousEventByFacts(f, 7));
    const hasGood = facts.some((f) => getDangerPeakFromFacts(f) <= 3);

    const { isLast, scoreBehind } = getScoreRankHints(opts);
    const hailMary = isLast || scoreBehind >= 6;

    if (hasBad && hasGood) {
      soft.control += 3.5;
      soft.tempo += 1.0;
      soft.risk -= 1.0;
    } else if (hasBad && !hasGood) {
      soft.control += 1.2;
      soft.risk += 0.5;
    } else if (hailMary) {
      soft.control += 0.75;
      soft.tempo += 0.25;
      soft.risk += 1.0;
    } else {
      soft.risk += 6.0;
      soft.control -= 2.0;
      soft.tempo -= 1.0;
      soft.info -= 0.5;
    }
  }

  // E) Kick Up Dust rare
  const isKickUpDust = a.id === "KICK_UP_DUST";
  if (isKickUpDust) {
    const { isLast, scoreBehind } = getScoreRankHints(opts);
    const hailMary = isLast || scoreBehind >= 6;

    if (emergency && !ctx?._handMeta?.hasDefense) {
      soft.tempo += 1.5;
      soft.control += 1.0;
      soft.risk -= 0.5;
    } else if (hailMary) {
      soft.tempo += 0.75;
      soft.risk += 0.75;
    } else {
      soft.risk += 7.0;
      soft.control -= 2.0;
      soft.tempo -= 2.0;
    }
  }

  // F) defense more valuable at high danger
  if (dangerNext >= 7 && isDefenseAction(a)) {
    soft.risk -= 2.0;
    soft.control += 0.75;
  }

  // G) track-manip more valuable at medium-high danger
  if (!emergency && isTrackManipAction(a) && dangerNext >= 6) {
    soft.control += 1.25;
    soft.tempo += 0.25;
  }
// H) Hold Still (LOCK_OPS) is usually a trap:
// it blocks the OPS phase (including your own Den Signal / track-manip defense).
const isHoldStill =
  a.id === "HOLD_STILL" || hasTag(a.tags, "LOCK_OPS") || affectsFlags.includes("opsLocked");

if (isHoldStill) {
  // baseline: low utility unless very niche
  soft.control -= 2.5;
  soft.tempo -= 1.0;
  soft.risk += 2.0;

  // if danger is rising, this is actively bad (you remove your best counterplays)
  if (dangerNext >= 5) {
    soft.risk += 6.0;
    soft.control -= 2.0;
    soft.tempo -= 1.5;
  }

  // if you already played this round, even more wasteful
  if (playedThisRound >= 1) {
    soft.risk += 2.0;
    soft.tempo -= 0.75;
  }

  // tiny niche: if you're last/behind and danger is low, denial can be acceptable
  const { isLast, scoreBehind } = getScoreRankHints(opts);
  const hailMary = isLast || scoreBehind >= 6;
  if (hailMary && dangerNext <= 2) {
    soft.control += 1.0;
    soft.risk += 0.5;
  }
}

// I) Scatter (BLOCK_SCOUT) is also situational: only worth it as denial play.
const isScatter = a.id === "SCATTER" || hasTag(a.tags, "BLOCK_SCOUT");
if (isScatter) {
  // baseline: denial is a tempo loss
  soft.tempo -= 1.0;
  soft.control -= 1.0;
  soft.risk += 1.0;

  // if the game already has noPeek, Scatter is redundant
  if (game?.flagsRound?.noPeek === true || ctx?.noPeek === true) {
    soft.risk += 4.0;
    soft.control -= 3.0;
    soft.tempo -= 1.0;
  }

  // if danger is medium-high, you need defense, not denial
  if (dangerNext >= 6) {
    soft.risk += 4.0;
    soft.control -= 2.0;
  }

  // behind => allow as deny/hail-mary
  const { isLast, scoreBehind } = getScoreRankHints(opts);
  const hailMary = isLast || scoreBehind >= 6;
  if (hailMary) {
    soft.control += 1.75;
    soft.risk += 0.5;
  } else {
    soft.risk += 2.0;
    soft.control -= 1.5;
  }
}

  const implemented = !!a.engineImplemented;
  const reliability = implemented ? 1.0 : (preset.unimplementedMult ?? 0.9);

  return {
    actionId: a.id,
    name: a.name,
    implemented,
    affectsFlags,
    affectsTrack,
    riskScore: (((tagScore.risk || 0) + (roleBonus.risk || 0) + soft.risk) * w.risk) / reliability,
    lootScore: (((tagScore.loot || 0) + (roleBonus.loot || 0) + soft.loot) * w.loot) * reliability,
    infoScore: (((tagScore.info || 0) + (roleBonus.info || 0) + soft.info) * w.info) * reliability,
    controlScore: (((tagScore.control || 0) + (roleBonus.control || 0) + soft.control) * w.control) * reliability,
    tempoScore: (((tagScore.tempo || 0) + (roleBonus.tempo || 0) + soft.tempo) * w.tempo) * reliability,
    tags: a.tags || [],
    role: a.role || "unknown",
    __meta: ctx?.includeMeta
      ? { dangerNext, emergency, playedThisRound, handCount, reserve, early, late }
      : undefined,
  };
}

// Quick-rank of actions in hand (highest total first)
// Backwards compat: rankActions(actionIds) still works.
// New: rankActions(actionIds, { presetKey, denColor, game, me, ctx, coreConfig, comboInfo })
export function rankActions(actionKeys = [], opts = {}) {
  const keys = Array.isArray(actionKeys) ? actionKeys : [];

  // ---- canonical actionId mapping (accept id OR human name) ----
  if (!globalThis.__BOT_ACTION_NAME_TO_ID) {
    const map = new Map();
    const actions = (RULES_INDEX && RULES_INDEX.actions) ? RULES_INDEX.actions : {};
    for (const [id, a] of Object.entries(actions)) {
      const nm = String(a?.name || "").trim();
      if (nm) map.set(nm.toLowerCase(), id);
    }
    globalThis.__BOT_ACTION_NAME_TO_ID = map;
  }
  const nameToId = globalThis.__BOT_ACTION_NAME_TO_ID;

  function toActionId(keyOrName) {
    const k = String(keyOrName || "").trim();
    if (!k) return null;
    // already an id?
    if (RULES_INDEX?.actions?.[k]) return k;
    // try lookup by human name
    return nameToId.get(k.toLowerCase()) || null;
  }

  const actionIds = keys.map(toActionId).filter(Boolean);
  if (!actionIds.length) return [];

  // ---- derive ctx for CORE (if caller didn't supply ctx) ----
  const presetKey =
    opts?.presetKey ||
    (typeof presetFromDenColor === "function" ? presetFromDenColor(opts?.denColor) : "BLUE");

  const preset = (BOT_PRESETS && BOT_PRESETS[presetKey]) ? BOT_PRESETS[presetKey] : (BOT_PRESETS?.BLUE || {});
  const cfg = { ...DEFAULT_CORE_CONFIG, ...(preset?.coreOverride || {}), ...(opts?.coreConfig || {}) };

  const game = opts?.game || null;
  const me = opts?.me || null;

  const ctx = opts?.ctx || (() => {
    const round = Number.isFinite(Number(game?.round)) ? Number(game.round) : 0;
    const phase = String(game?.phase || "");

    const disc = Array.isArray(game?.actionDiscard) ? game.actionDiscard : [];

    const discardThisRoundActionIds = disc
      .filter((x) => Number(x?.round || 0) === round)
      .map((x) => toActionId(x?.name || x?.id || x?.actionId))
      .filter(Boolean);

    const discardRecentActionIds = [...disc]
      .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0))
      .slice(-10)
      .map((x) => toActionId(x?.name || x?.id || x?.actionId))
      .filter(Boolean);

    const discardActionIds = [
      ...disc.map((x) => toActionId(x?.name || x?.id || x?.actionId)),
      ...(Array.isArray(game?.actionDiscardPile)
        ? game.actionDiscardPile.map((x) => toActionId(x))
        : []),
    ].filter(Boolean);

    const actionsPlayedThisRound =
      me?.id
        ? disc.filter((x) => x?.by === me.id && Number(x?.round || 0) === round).length
        : 0;
    const knownUpcomingEvents = Array.isArray(me?.knownUpcomingEvents) ? me.knownUpcomingEvents : [];
    const knownUpcomingCount = knownUpcomingEvents.length;
    const scoutTier = knownUpcomingCount >= 2 ? "HARD_SCOUT" : knownUpcomingCount >= 1 ? "SOFT_SCOUT" : "NO_SCOUT";

    // --- den + lead context ---
    const denColor = String(opts?.denColor || me?.denColor || me?.den || me?.color || "");
    const isLead = computeIsLead(game, me, {});

    // --- next event (scoped; respects noPeek) ---
    const nextEventKey = getNextEventKey(game, {});
    const nextEventFacts = nextEventKey
      ? getEventFactsScoped(nextEventKey, { ...opts, game, me, denColor, ctx: { isLead, denColor } })
      : null;

    // bot knows next card only if its own intel list contains the immediate next key
    const _knownSet = new Set(
      (Array.isArray(knownUpcomingEvents) ? knownUpcomingEvents : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    );
    const nextKnown = !!(nextEventKey && _knownSet.has(String(nextEventKey)));

    // dangerNext for CORE cashout should reflect "stay risk" (best defensive option)
    const dangerNext = getDangerStayFromFacts(nextEventFacts);

    const roosterSeen = Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : 0;

    // carryValue should reflect carried loot, not total score
    const carryValue =
  Number.isFinite(Number(opts?.carryValue)) ? Number(opts.carryValue)
  : (Number.isFinite(Number(me?.carryValue)) ? Number(me.carryValue)
  : estimateCarryValue(me));

    return {
      phase,
      round,
      botId: me?.id || null,
      denColor,
      isLead,
      carryValue,
      isLast: !!opts?.isLast,
      scoreBehind: Number(opts?.scoreBehind || 0),

      handActionIds: actionIds,
      handSize: actionIds.length,
      actionsPlayedThisRound,

      discardActionIds,
      discardThisRoundActionIds,
      discardRecentActionIds,

      nextKnown,
      knownUpcomingEvents,
      knownUpcomingCount,
      scoutTier,
      nextEventKey,
      nextEventFacts,
      dangerNext,

      roosterSeen,
      rooster2JustRevealed: false,
      postRooster2Window: roosterSeen >= 2,

      lockEventsActive: !!game?.flagsRound?.lockEvents,
      opsLockedActive: !!game?.flagsRound?.opsLocked,

      revealedDenEventsByColor: {},
    };
  })();

   // ---- comboInfo: build from hand unless caller passed one ----
  const comboInfo = opts?.comboInfo || buildComboInfoFromHand(actionIds, ctx);

  const core = evaluateCorePolicy(ctx, comboInfo, cfg);

  // ---- derive combo eligibility + expose to heuristics/scoring ----
  const isLast = !!ctx?.isLast;
  const scoreBehind = Number(ctx?.scoreBehind || 0);
  const hailMary = isLast || scoreBehind >= Number(cfg?.HAILMARY_BEHIND ?? 6);

  const comboThreshold = hailMary ? Number(cfg.COMBO_THRESHOLD_HAILMARY ?? 6.5) : Number(cfg.COMBO_THRESHOLD ?? 7.5);
  const bestPair = comboInfo?.bestPair || { a: null, b: null, score: 0 };
  const comboEligible =
    !!bestPair.a && !!bestPair.b && Number(bestPair.score || 0) >= comboThreshold;

  // Flag combo possibility for budget logic inside scoreActionFacts()
  if (comboEligible) ctx.comboAllowed = true;

  // If we've already played once this round, only allow "real follow-up"
  const discThis = Array.isArray(ctx?.discardThisRoundActionIds) ? ctx.discardThisRoundActionIds : [];
  const lastPlayed = discThis.length ? discThis[discThis.length - 1] : null;

  let comboTarget = null;
  if (comboEligible && Number(ctx?.actionsPlayedThisRound || 0) >= 1) {
    if (lastPlayed === bestPair.a) comboTarget = bestPair.b;
    else if (lastPlayed === bestPair.b) comboTarget = bestPair.a;
  }

  if (comboTarget) {
    ctx.comboPrimed = true;
    ctx.comboFollowUp = true;
    ctx.comboTarget = comboTarget;
  } else if (comboEligible && Number(ctx?.actionsPlayedThisRound || 0) < 1) {
    ctx.comboPrimed = true;
  }

  const strat = applyActionStrategies(ctx, comboInfo);

// deny merge (core + strategies)
const denySet = new Set([
  ...(Array.isArray(core?.denyActionIds) ? core.denyActionIds : []),
  ...(Array.isArray(strat?.denyActionIds) ? strat.denyActionIds : []),
]);
   
    const out = actionIds
    .map((id) => {
      if (denySet.has(id)) return null;

      const s = scoreActionFacts(id, { ...opts, presetKey, ctx });
      if (!s) return null;

      const base = totalScore(s);
      const coreDelta = Number(core?.addToActionTotal?.[id] || 0);
      const stratDelta = Number(strat?.addToActionTotal?.[id] || 0);
      const total = base + coreDelta + stratDelta;

      return {
        id,
        s: {
          ...s,
          coreDelta,
          stratDelta,
          coreDangerEffective: core?.dangerEffective,
          coreCashoutBias: core?.cashoutBias,
        },
        total,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.total - a.total));

  // attach meta for pickActionOrPass (array is an object too)
  out._meta = { core, comboInfo, ctx, cfg, comboThreshold };

  return out;
}
/* ============================================================
   6) Action gate: play vs PASS (bot economy)
============================================================ */
export function pickActionOrPass(actionKeys = [], opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);

  // Base thresholds (per preset)
  const baseMin = Number(preset?.tagBias?.actionPlayMinTotal ?? 3.0);
  const emergencyTotal = Number(preset?.tagBias?.emergencyActionTotal ?? 7.5);

  const ranked = rankActions(actionKeys, opts);
  if (!ranked.length) return { play: null, ranked, reason: "no_actions" };

  const best = ranked[0];
  const bestTotal = Number(best?.total);

  if (!Number.isFinite(bestTotal)) return { play: null, ranked, reason: "invalid_score" };

  const { game, me, ctx } = getCtx(opts);

  // Danger context (already Rooster-adjusted via scoped facts)
  const dangerNext = getDangerNext({ ...opts, game, me, ctx });
  const emergency = dangerNext >= 8 || ctx?.emergency === true;

  // ---- Action economy (NO hard caps) ----
  const playedThisRound = getActionsPlayedThisRound({ ...opts, game, me, ctx });

  const early = isEarlyGame(game);
  const late = isLateGame(game);

  const reserveEarly = Number(preset?.tagBias?.actionReserveEarly ?? 2);
  const reserveLate = Number(preset?.tagBias?.actionReserveLate ?? 1);

  // Always keep at least 1 card in hand unless it's a real emergency
  const reserve = Math.max(1, late ? reserveLate : reserveEarly);

  const handCount = getHandCount(me, Array.isArray(actionKeys) ? actionKeys : ctx?._handKeys);
  const projectedAfter = Math.max(0, handCount - 1);

  // If playing would break reserve, PASS unless emergency and action is strong enough
  if (!emergency && projectedAfter < reserve) {
    return { play: null, ranked, reason: "reserve_hold" };
  }

  // Soft increasing threshold per extra play this round.
  // When danger is low -> be more conservative (save cards).
  // When danger is high -> allow spending cards to survive/control.
  const dangerFactor = Math.max(0, Math.min(10, dangerNext));
  let step = 0.75 - (dangerFactor * 0.06); // 0.75 .. 0.15 roughly
  step = Math.max(0.15, Math.min(0.75, step));

  // ---- combo gating (real follow-up only) ----
  const meta = ranked?._meta || {};
  const core = meta.core || null;
  const comboInfo = meta.comboInfo || null;
  const ctxUse = meta.ctx || ctx || {};
  const comboThreshold = Number(
    meta.comboThreshold ?? (DEFAULT_CORE_CONFIG?.COMBO_THRESHOLD ?? 7.5)
  );

  // If this would be a 2nd play and CORE says "no", then PASS (unless emergency)
  if (!emergency && playedThisRound >= 1 && core?.denySecondAction) {
    return { play: null, ranked, reason: "deny_second_action" };
  }

  const bestPair = comboInfo?.bestPair || { a: null, b: null, score: 0 };
  const comboEligible =
    !!bestPair.a &&
    !!bestPair.b &&
    Number(bestPair.score || 0) >= comboThreshold;

  // Determine if we're actually in a follow-up situation
  const discThis = Array.isArray(ctxUse?.discardThisRoundActionIds)
    ? ctxUse.discardThisRoundActionIds
    : [];
  const lastPlayed = discThis.length ? discThis[discThis.length - 1] : null;

  let comboTarget = null;
  if (comboEligible && playedThisRound >= 1) {
    if (lastPlayed === bestPair.a) comboTarget = bestPair.b;
    else if (lastPlayed === bestPair.b) comboTarget = bestPair.a;
  }

  // HARD RULE: 2e action alleen als partner (behalve emergency)
  if (!emergency && playedThisRound >= 1 && !comboTarget) {
    return { play: null, ranked, reason: "no_combo_followup" };
  }

  // Candidate = best, tenzij echte follow-up partner bestaat
  let candidate = best;
  if (comboTarget) {
    const follow = ranked.find((x) => x?.id === comboTarget);
    if (follow) candidate = follow;
    else if (!emergency && playedThisRound >= 1) {
      // partner niet in hand -> geen 2e play
      return { play: null, ranked, reason: "combo_partner_missing" };
    }
  }

  const comboDiscount = (playedThisRound >= 1 && comboTarget) ? 0.85 : 0;
  const dynamicMin = baseMin + (playedThisRound * step) - comboDiscount;

  const candidateTotal = Number(candidate?.total ?? -Infinity);

  // Emergency override: best card only
  if (emergency) {
    if (bestTotal >= emergencyTotal) return { play: best.id, ranked, reason: "emergency_play" };
    return { play: null, ranked, reason: "emergency_but_no_good_action" };
  }

  if (candidateTotal >= dynamicMin) {
    return {
      play: candidate.id,
      ranked,
      reason: comboTarget ? "combo_followup" : "above_dynamic_threshold",
    };
  }

  return { play: null, ranked, reason: "below_dynamic_threshold" };
}

/* ============================================================
   7) Optional decision recommendation (DASH/BURROW/LURK)
============================================================ */

export function recommendDecision(opts = {}) {
  const { ctx, game, me } = getCtx(opts);
  const denColor = getScopedDenColor(opts);

  // Prefer probabilistic risks from botRunner metrics (works in noPeek)
  const ctxDangerVec = (ctx && typeof ctx.dangerVec === "object") ? ctx.dangerVec : null;

  const dDash = Number(ctxDangerVec?.dash ?? ctxDangerVec?.DASH ?? ctxDangerVec?.dashRisk ?? ctxDangerVec?.dangerDash ?? NaN);
  const dLurk = Number(ctxDangerVec?.lurk ?? ctxDangerVec?.LURK ?? ctxDangerVec?.lurkRisk ?? ctxDangerVec?.dangerLurk ?? NaN);
  const dBurrow = Number(ctxDangerVec?.burrow ?? ctxDangerVec?.BURROW ?? ctxDangerVec?.burrowRisk ?? ctxDangerVec?.dangerBurrow ?? NaN);

  // Fallback (only when peeking is allowed and botRunner didn't pass risks)
  const nextEventFacts =
    (Number.isFinite(dDash) || Number.isFinite(dLurk) || Number.isFinite(dBurrow))
      ? null
      : getNextEventFactsFromOpts(opts);

  const lurkRisk = Number.isFinite(dLurk) ? dLurk : Number(nextEventFacts?.dangerLurk ?? 0);
  const burrowRisk = Number.isFinite(dBurrow) ? dBurrow : Number(nextEventFacts?.dangerBurrow ?? 0);
  const dashRisk = Number.isFinite(dDash) ? dDash : Number(nextEventFacts?.dangerDash ?? 0);

  // BURROW availability (one-time per RAID)
  const burrowUsed = !!(me?.burrowUsedThisRaid ?? me?.burrowUsed);
  const canBurrow = !burrowUsed;

  // Den Signal (if your den is immune this round, staying is safe)
  const denImmune =
    (ctx?.flagsRound && typeof ctx.flagsRound === "object" ? ctx.flagsRound.denImmune : null) ||
    (game?.flagsRound && typeof game.flagsRound === "object" ? game.flagsRound.denImmune : null) ||
    null;

  const myDenKey = String(denColor || "").trim().toUpperCase();
  const safeBySignal = !!(denImmune && myDenKey && denImmune[myDenKey]);

  // Rooster timing (only matters when the bot can genuinely know it)
  const roosterSeen = Number.isFinite(Number(ctx?.roosterSeen))
    ? Number(ctx.roosterSeen)
    : (Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : 0);

  const confidence = Number(ctx?.confidence);
  const knowsNext = ctx?.nextKnown === true || (Array.isArray(me?.knownUpcomingEvents) && me.knownUpcomingEvents.length > 0);
  const canTrustNextId = (game?.flagsRound?.noPeek !== true) || knowsNext || (Number.isFinite(confidence) && confidence >= 0.99);

  const nextEventId =
    (ctx?.nextEventIdUsed != null ? String(ctx.nextEventIdUsed || "") : "") ||
    (ctx?.nextEventKey ? String(ctx.nextEventKey) : "") ||
    (ctx?.nextEventFacts?.id ? String(ctx.nextEventFacts.id) : "") ||
    (nextEventFacts?.id ? String(nextEventFacts.id) : "") ||
    getNextEventKey(game, ctx) ||
    null;

  const isRooster3 = canTrustNextId && String(nextEventId || "") === "ROOSTER_CROW" && roosterSeen >= 2;

  // === CANON: decision layer ===
  // - DASH = definitive exit (keep loot, wait for RAID end)
  // - LURK = stay for reveal (continue if not caught)
  // - BURROW = one-time emergency brake that prevents a forced DASH when staying is too risky

  // Safety threshold: under this, we treat "stay" as safe enough to LURK
  const SAFE_MAX = 3.0;

  // "Would DASH" trigger: above this, staying is too risky (unless you can BURROW)
  const DASH_TRIGGER = 7.0;

  // dashPush: rising pressure to bail out (derived from danger over time + endgame pressure),
  // but BURROW can be used to avoid an early DASH.
  const dashPush = Number.isFinite(Number(me?.dashPush)) ? Number(me.dashPush) : 0;
  const dashers = Number.isFinite(Number(ctx?.dashDecisionsSoFar)) ? Number(ctx.dashDecisionsSoFar) : 0;

  // If many dashers already, threshold drops (bag splits -> less attractive to stay forever)
  const dashPushThreshold = Math.max(4.5, 7.0 - (Math.min(3, dashers) * 0.75));

  const safeNow = safeBySignal || lurkRisk <= SAFE_MAX;

  // Update dashPush (returned for botRunner to persist if desired)
  let dashPushNext = dashPush;
  if (isRooster3) {
    dashPushNext = 10;
  } else if (safeNow) {
    dashPushNext = Math.max(0, dashPush - 1.0);
  } else {
    const gain =
      lurkRisk >= 9 ? 3.0 :
      lurkRisk >= 8 ? 2.2 :
      lurkRisk >= 7 ? 1.4 :
      lurkRisk >= 6 ? 1.0 :
      0.6;
    dashPushNext = Math.min(10, dashPush + gain);

    // mild end-pressure after Rooster #2 (not a "cashout", just urgency)
    if (roosterSeen >= 2) dashPushNext = Math.min(10, dashPushNext + 0.5);
  }

  // Decision: default is LURK. Only switch to DASH when truly necessary.
  let decision = "LURK";

  if (isRooster3) {
    // hard rule: on 3rd Rooster Crow, everyone still in the RAID gets caught -> DASH
    decision = "DASH";
  } else if (safeNow) {
    decision = "LURK";
  } else {
    // If we'd normally be forced to DASH, use BURROW instead (if available).
    const dashShould = (lurkRisk >= DASH_TRIGGER) || (dashPushNext >= dashPushThreshold);

    if (dashShould) decision = canBurrow ? "BURROW" : "DASH";
    else decision = "LURK";
  }

  if (decision === "BURROW" && !canBurrow) decision = "LURK";

  // Keep carryValue purely for logging / compatibility (NOT used in the decision)
  const carryValue =
    Number.isFinite(Number(ctx?.carryValueExact)) ? Number(ctx.carryValueExact)
    : (Number.isFinite(Number(ctx?.carryValue)) ? Number(ctx.carryValue)
    : (Number.isFinite(Number(me?.carryValue)) ? Number(me.carryValue) : 0));

  return {
    decision,
    nextEventId,
    carryValue,     // informational only
    cashoutBias: null, // removed (was non-canon)

    // risk telemetry
    dangerStay: Number.isFinite(Number(ctx?.dangerStay)) ? Number(ctx.dangerStay) : Math.min(lurkRisk, canBurrow ? burrowRisk : lurkRisk),
    dangerEffective: Number.isFinite(Number(ctx?.dangerEffective)) ? Number(ctx.dangerEffective) : lurkRisk,
    dangerVec: { dash: dashRisk, lurk: lurkRisk, burrow: burrowRisk },

    // canon pressure telemetry
    dashPushNext,
    dashPushThreshold,
    dashDecisionsSoFar: dashers,
    confidence: Number.isFinite(confidence) ? confidence : null,
    canTrustNextId,
    isRooster3,
    safeBySignal,
  };
}
