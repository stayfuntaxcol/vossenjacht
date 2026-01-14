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
      actionReserveEarly: 2,
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
      actionReserveEarly: 2,
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
      actionReserveEarly: 2,
      actionReserveLate: 2,
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
      actionReserveEarly: 2,
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
  BLOCK_SCOUT: { control: 5 },
  BLOCK_SCOUT_POS: { control: 4 },

  // defense
  DEN_IMMUNITY: { risk: -6, control: 2 },
  LOCK_OPS: { control: 5, tempo: 2 },

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
  for (const t of safeTags(tags)) {
    const s = map[t];
    if (!s) continue;
    const scale = Number.isFinite(bias[t]) ? bias[t] : 1;
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
function resolveEventKey(input) {
  const raw = String(input || "").trim();
  if (!raw) return { id: null, f: null };
  const fDirect = getEventFacts(raw);
  if (fDirect) return { id: fDirect.id, f: fDirect };

  const n = normForMatch(raw);
  for (const [id, f] of Object.entries(RULES_INDEX?.events || {})) {
    if (!f) continue;
    if (normForMatch(f.title) === n) return { id, f };
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

function getNextEventKey(game) {
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

function getNextEventFactsFromOpts(opts = {}) {
  const { ctx, game } = getCtx(opts);
  if (ctx?.nextEventFacts) return ctx.nextEventFacts;
  if (ctx?.nextEventKey) return getEventFacts(ctx.nextEventKey) || null;
  const k = getNextEventKey(game);
  return k ? getEventFacts(k) || null : null;
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
    if (a.role === "defense" || tags.includes("DEN_IMMUNITY")) meta.hasDefense = true;
    if (a.role === "info" || tags.includes("INFO") || tags.includes("PEEK_DECISION") || tags.includes("PREDICT_EVENT")) meta.hasIntel = true;
    if (a.role === "control" || tags.includes("TRACK_MANIP") || tags.includes("SWAP_MANUAL") || tags.includes("LOCK_EVENTS")) meta.hasTrack = true;
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
  return wanted.some((t) => tags.includes(t));
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
  if (tags.includes("CATCH_DASHERS") || tags.includes("CATCH_ALL_YARD")) return true;
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

  const { f } = resolveEventKey(eventKey);
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
  const dangerNext = getDangerNext(opts);
  const emergency = dangerNext >= 8 || ctx?.emergency === true;

  const playedThisRound = getActionsPlayedThisRound(opts);
  const handCount = getHandCount(me, ctx?._handKeys);
  const early = isEarlyGame(game);
  const late = isLateGame(game);

  const maxPerRound = Number(preset?.tagBias?.maxActionsPerRound ?? 1) || 1;
  const reserveEarly = Number(preset?.tagBias?.actionReserveEarly ?? 2);
  const reserveLate = Number(preset?.tagBias?.actionReserveLate ?? 1);
  const reserve = late ? reserveLate : reserveEarly;

  const projectedHandAfterPlay = Math.max(0, handCount - 1);

  // A) budget
  const comboAllowed = !!(ctx?.comboAllowed || ctx?.comboFollowUp || ctx?.comboPrimed);
  const allowOverBudget = emergency || comboAllowed;

  if (playedThisRound >= maxPerRound && !allowOverBudget) {
    soft.risk += 9;
    soft.tempo -= 4;
    soft.control -= 2;
    soft.info -= 1;
  } else if (playedThisRound >= maxPerRound && allowOverBudget) {
    soft.risk += 2.5;
    soft.tempo -= 0.5;
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
    const facts = list.map((k) => getEventFacts(k) || null).filter(Boolean);

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

    // dangerNext fallback (v1 = 0; later geef je ctx.dangerNext mee vanuit botRunner)
    const dangerNext = 0;

    const roosterSeen = Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : 0;

    const carryValue =
      (Number.isFinite(Number(me?.score)) ? Number(me.score) : null) ??
      (Number(me?.eggs || 0) + Number(me?.hens || 0) + (me?.prize ? 3 : 0));

    return {
      phase,
      round,
      botId: me?.id || null,
      denColor: String(opts?.denColor || me?.denColor || me?.color || ""),
      carryValue,
      isLast: !!opts?.isLast,
      scoreBehind: Number(opts?.scoreBehind || 0),

      handActionIds: actionIds,
      handSize: actionIds.length,
      actionsPlayedThisRound,

      discardActionIds,
      discardThisRoundActionIds,
      discardRecentActionIds,

      nextKnown: false,
      knownUpcomingEvents,
      knownUpcomingCount,
      scoutTier,
      nextEventFacts: null,
      dangerNext,

      roosterSeen,
      rooster2JustRevealed: false,
      postRooster2Window: roosterSeen >= 2,

      lockEventsActive: !!game?.flagsRound?.lockEvents,
      opsLockedActive: !!game?.flagsRound?.opsLocked,

      revealedDenEventsByColor: {},
    };
  })();

  // ---- comboInfo: optioneel (CORE werkt ook zonder matrix) ----
  const comboInfo = opts?.comboInfo || {
    bestPair: { a: null, b: null, score: 0 },
    bestPartnerScoreByActionId: {},
    allowsDuplicatePair: () => false,
  };

  const core = evaluateCorePolicy(ctx, comboInfo, cfg);
  const denySet = new Set(Array.isArray(core?.denyActionIds) ? core.denyActionIds : []);

  return actionIds
    .map((id) => {
      if (denySet.has(id)) return null;

      const s = scoreActionFacts(id, { ...opts, presetKey });
      if (!s) return null;

      const base = totalScore(s);
      const delta = Number(core?.addToActionTotal?.[id] || 0);
      const total = base + delta;

      return {
        id,
        s: {
          ...s,
          coreDelta: delta,
          coreDangerEffective: core?.dangerEffective,
          coreCashoutBias: core?.cashoutBias,
        },
        total,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.total - a.total));
}

/* ============================================================
   6) Action gate: play vs PASS (bot economy)
============================================================ */
export function pickActionOrPass(actionKeys = [], opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const minTotal = Number(preset?.tagBias?.actionPlayMinTotal ?? 3.0);
  const emergencyTotal = Number(preset?.tagBias?.emergencyActionTotal ?? 7.5);

  const ranked = rankActions(actionKeys, opts);
  if (!ranked.length) return { play: null, ranked, reason: "no_actions" };

  const best = ranked[0];
  const bestTotal = Number(best?.total);

  const dangerNext = getDangerNext(opts);
  const emergency = dangerNext >= 8 || opts?.ctx?.emergency === true;

  const playedThisRound = getActionsPlayedThisRound(opts);
  const maxPerRound = Number(preset?.tagBias?.maxActionsPerRound ?? 1) || 1;

  const comboAllowed = !!(opts?.ctx?.comboAllowed || opts?.ctx?.comboFollowUp || opts?.ctx?.comboPrimed);
  const allowOverBudget = emergency || comboAllowed;

  if (playedThisRound >= maxPerRound && !allowOverBudget) {
    return { play: null, ranked, reason: "budget_max_reached" };
  }

  if (!Number.isFinite(bestTotal)) return { play: null, ranked, reason: "invalid_score" };

  if (emergency) {
    if (bestTotal >= emergencyTotal) return { play: best.id, ranked, reason: "emergency_play" };
    return { play: null, ranked, reason: "emergency_but_no_good_action" };
  }

  if (bestTotal >= minTotal) return { play: best.id, ranked, reason: "above_threshold" };
  return { play: null, ranked, reason: "below_threshold" };
}

/* ============================================================
   7) Optional decision recommendation (DASH/BURROW/LURK)
============================================================ */
export function recommendDecision(opts = {}) {
  const { me } = getCtx(opts);
  const dangerNext = getDangerNext(opts);
  const carry = estimateCarryValue(me);

  const knownUpcoming = getKnownUpcomingEvents(opts);
  const facts = knownUpcoming.map((k) => getEventFacts(k) || null).filter(Boolean);
  const roostersAhead3 = facts
    .slice(0, 3)
    .filter((f) => safeTags(f.tags).includes("ROOSTER_TICK") || String(f.id || "").includes("ROOSTER"))
    .length;

  if (carry >= 7) {
    if (dangerNext >= 5 || roostersAhead3 >= 1) return { decision: "DASH", carry, dangerNext, roostersAhead3 };
    return { decision: "LURK", carry, dangerNext, roostersAhead3 };
  }

  if (carry >= 4) {
    if (dangerNext >= 7 || roostersAhead3 >= 2) return { decision: "DASH", carry, dangerNext, roostersAhead3 };
    if (dangerNext >= 7) return { decision: "BURROW", carry, dangerNext, roostersAhead3 };
    return { decision: "LURK", carry, dangerNext, roostersAhead3 };
  }

  if (dangerNext >= 7) return { decision: "BURROW", carry, dangerNext, roostersAhead3 };
  return { decision: "LURK", carry, dangerNext, roostersAhead3 };
}
