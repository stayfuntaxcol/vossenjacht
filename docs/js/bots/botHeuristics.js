// docs/js/bots/botHeuristics.js
// Heuristiek basis (zonder Firebase) + 4 kleur-presets (RED/GREEN/YELLOW/BLUE)
//
// Doel:
// - Zelfde API als je huidige file, maar met presets die je per bot (via denColor) kunt kiezen.
// - Stateless: je geeft presetKey mee in de call (geen globale "current preset").
//
// Backwards compatible:
// - BOT_WEIGHTS blijft bestaan (default = BLUE preset)
// - scoreEventFacts(id) / scoreActionFacts(id) werken nog steeds zonder opts
// - rankActions(actionIds) werkt nog steeds zonder opts
//
// Nieuw (extra, optioneel):
// - presetFromDenColor(denColor)
// - rankActions(actionIds, { presetKey, denColor, ctx })
// - scoreEventFacts(eventKey, { presetKey, denColor, ctx })
// - scoreActionFacts(actionKey, { presetKey, denColor, ctx })
// - pickActionOrPass(actionIds, { ... })  // 1 plek voor action-economie + thresholds
//
// Kern-upgrades (heuristiek):
// - Action budget: max 0–1 action per ronde, 2 alleen bij nood/combo.
// - Bewaar-reserve: early 2 kaarten, late 1–2 (preset).
// - Diminishing returns op intel.
// - Pack Tinker / Kick Up Dust alleen als voorwaarden kloppen.
// - Context-aware “emergency” bij hoge dreiging (rooster/charge).

import { RULES_INDEX, getEventFacts, getActionFacts } from "./rulesIndex.js";

// ============================================================
// 1) Presets (koppel dit aan Den-kleur)
// ============================================================
export const BOT_PRESETS = {
  // ROOD = tempo/agro (accept more risk for pressure)
  RED: {
    weights: { risk: 0.75, loot: 1.05, info: 0.8, control: 0.85, tempo: 1.25 },
    unimplementedMult: 0.9,
    tagBias: {
      ROOSTER_TICK: 1.2,
      raid_end_trigger: 1.2,
      dash_reward: 1.1,
      // --- action economy ---
      maxActionsPerRound: 1,
      actionReserveEarly: 2,
      actionReserveLate: 1,
      actionPlayMinTotal: 2.6,
      emergencyActionTotal: 7.5,
      // --- per-card clamps ---
      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },

  // GROEN = defensief/stable (protect loot, reduce variance)
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
      // --- action economy ---
      maxActionsPerRound: 1,
      actionReserveEarly: 2,
      actionReserveLate: 1,
      actionPlayMinTotal: 3.2,
      emergencyActionTotal: 7.8,
      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },

  // GEEL = greedy/opportunist (max loot value, hates sack reset)
  YELLOW: {
    weights: { risk: 1.0, loot: 1.35, info: 0.85, control: 0.85, tempo: 0.9 },
    unimplementedMult: 0.9,
    tagBias: {
      dash_reward: 1.25,
      multi_dasher_bonus: 1.2,
      reset_sack: 1.35, // makes negative loot impact matter more
      // --- action economy ---
      maxActionsPerRound: 1,
      actionReserveEarly: 2,
      actionReserveLate: 2,
      actionPlayMinTotal: 3.6,
      emergencyActionTotal: 7.8,
      packTinkerLookahead: 4,
      kickUpDustLookahead: 3,
    },
  },

  // BLAUW = info/control (setups, track manipulation, deny scout)
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
      // --- action economy ---
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

// Backwards-compat default weights
export const BOT_WEIGHTS = BOT_PRESETS.BLUE.weights;

// ============================================================
// 2) Kleur → preset key (tolerant voor NL/EN)
// ============================================================
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
  const key =
    String(presetKey || "").trim().toUpperCase() || presetFromDenColor(denColor);
  return BOT_PRESETS[key] || BOT_PRESETS.BLUE;
}

// ============================================================
// 3) Tag → score mapping (basis)
// ============================================================
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
  COPY_DECISION_LATER: { info: 2, control: 2, risk: 2 }, // copying others can be dangerous
  SET_LEAD: { control: 4 },

  // future-proof
  DISCARD_SWAP: { control: 3, info: 2, tempo: 1 },
};

// ============================================================
// 4) Helpers
// ============================================================
const DIM_KEYS = ["risk", "loot", "info", "control", "tempo"];

function blankScores() {
  return { risk: 0, loot: 0, info: 0, control: 0, tempo: 0 };
}

function addInto(out, add, scale = 1) {
  if (!out || !add) return out;
  for (const k of DIM_KEYS) out[k] += (add[k] || 0) * scale;
  return out;
}

function normForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function safeTags(x) {
  return Array.isArray(x) ? x : [];
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

function getCtx(opts = {}) {
  // callers mogen { ctx } geven of game/me direct meegeven
  const ctx = opts?.ctx && typeof opts.ctx === "object" ? opts.ctx : {};
  const game = opts?.game || ctx?.game || null;
  const me = opts?.me || ctx?.me || null;
  return { ctx, game, me };
}

function getHandCount(me, actionKeys) {
  // tolerant: verschillende namen (hand/actionHand/actionCards)
  const candidates = [
    me?.hand,
    me?.actionHand,
    me?.actionCards,
    me?.actions,
    me?.cards,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.length;
  }
  // fallback: wat rankActions binnenkrijgt (kan filtered zijn, maar beter dan niks)
  return Array.isArray(actionKeys) ? actionKeys.length : 0;
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
  const byTrack =
    Number.isFinite(idx) && trackLen ? idx >= Math.max(0, trackLen - 4) : false;
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
  // 1) explicit facts
  if (ctx?.nextEventFacts) return ctx.nextEventFacts;
  // 2) explicit key
  if (ctx?.nextEventKey) return getEventFacts(ctx.nextEventKey) || null;
  // 3) derive from game track
  const k = getNextEventKey(game);
  return k ? getEventFacts(k) || null : null;
}

function getDangerNext(opts = {}) {
  const f = getNextEventFactsFromOpts(opts);
  return getDangerPeakFromFacts(f);
}

function getActionsPlayedThisRound(opts = {}) {
  const { ctx } = getCtx(opts);
  const v =
    ctx?.actionsPlayedThisRound ??
    ctx?.playsThisRound ??
    ctx?.playedThisRound ??
    ctx?.actionsThisRound ??
    0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getScoreRankHints(opts = {}) {
  // optioneel: botRunner kan dit meegeven als meta
  const { ctx } = getCtx(opts);
  const isLast = !!(ctx?.isLast || ctx?.rank === "LAST" || ctx?.rankFromEnd === 1);
  const behind = Number(ctx?.scoreBehind ?? ctx?.deltaScore ?? 0);
  return { isLast, scoreBehind: Number.isFinite(behind) ? behind : 0 };
}

// zeer ruwe carry value (alleen voor “dash instinct”/hail-mary)
// - werkt met arrays of simpele counters.
function estimateCarryValue(me) {
  if (!me) return 0;

  // 1) expliciete score fields
  const eggs = Number(me?.eggs);
  const hens = Number(me?.hens);
  const prize = Number(me?.prize);
  if (Number.isFinite(eggs) || Number.isFinite(hens) || Number.isFinite(prize)) {
    return (Number.isFinite(eggs) ? eggs * 1 : 0) + (Number.isFinite(hens) ? hens * 2 : 0) + (Number.isFinite(prize) ? prize * 3 : 0);
  }

  // 2) loot array (strings of objects)
  const lootArr = me?.loot || me?.sack || me?.bag || null;
  if (!Array.isArray(lootArr)) return 0;

  let v = 0;
  for (const it of lootArr) {
    const s = typeof it === "string" ? it : (it?.type || it?.id || it?.key || "");
    const t = String(s || "").toUpperCase();
    if (!t) continue;
    if (t.includes("PRIZE")) v += 3;
    else if (t.includes("HEN")) v += 2;
    else if (t.includes("EGG")) v += 1;
    else v += 1; // fallback: iets is beter dan niets
  }
  return v;
}

function myDenEventAlreadyRevealed(ctx = {}) {
  const game = ctx.game || null;
  const me = ctx.me || null;

  // gebruik jouw bestaande normColor() als die er al is
  const denColor = (typeof normColor === "function"
    ? normColor(ctx.denColor || me?.denColor || me?.den || me?.color)
    : String(ctx.denColor || me?.denColor || me?.den || me?.color || "")
        .trim()
        .toUpperCase()
  );

  if (!denColor) return false;

  const denId = `DEN_${denColor}`;
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  if (!track.length) return false;

  const idx = track.findIndex(
    (e) => String(e || "").trim().toUpperCase() === denId
  );
  if (idx < 0) return false;

  const cur = Number.isFinite(game?.eventIndex) ? game.eventIndex : -1;
  if (cur > idx) return true;

  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : null;
  if (rev && rev[idx] === true) return true;

  return false;
}

// resolve by id OR by display title/name
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
  // try stripping ACTION_ prefix
  const stripped = raw.replace(/^ACTION_/, "");
  if (stripped !== raw) return resolveActionKey(stripped);

  return { id: null, a: null };
}

// total: higher is better
function totalScore(s) {
  if (!s) return -999999;
  return (
    (s.controlScore || 0) +
    (s.infoScore || 0) +
    (s.lootScore || 0) +
    (s.tempoScore || 0) -
    (s.riskScore || 0)
  );
}

function computeHandMeta(actionKeys = []) {
  const meta = {
    ids: [],
    resolved: [],
    countByActionId: {},
    hasDefense: false,
    hasIntel: false,
    hasTrack: false,
  };

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

function isDangerousEventByFacts(f, threshold = 7) {
  if (!f) return false;
  const peak = getDangerPeakFromFacts(f);
  if (peak >= threshold) return true;
  const tags = safeTags(f.tags);
  // rooster/charge style tags vallen vaak hieronder
  if (tags.includes("CATCH_DASHERS") || tags.includes("CATCH_ALL_YARD")) return true;
  return false;
}

function getKnownUpcomingEvents(opts = {}) {
  const { ctx, game } = getCtx(opts);

  // beste: botRunner geeft expliciet mee wat bot "zeker weet"
  const list =
    (Array.isArray(ctx?.knownUpcomingEvents) && ctx.knownUpcomingEvents) ||
    (Array.isArray(ctx?.nextKnownEvents) && ctx.nextKnownEvents) ||
    (Array.isArray(ctx?.visibleUpcomingEvents) && ctx.visibleUpcomingEvents) ||
    null;

  if (list && list.length) return list.map((x) => String(x || "").trim()).filter(Boolean);

  // fallback: als er revealed positions zijn, pak die (globaal, niet per speler)
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
  return (
    a?.role === "info" ||
    actionHasAnyTag(a, ["INFO", "PEEK_DECISION", "PREDICT_EVENT"])
  );
}

function isDefenseAction(a) {
  return a?.role === "defense" || actionHasAnyTag(a, ["DEN_IMMUNITY"]);
}

function isTrackManipAction(a) {
  return a?.role === "control" || actionHasAnyTag(a, ["TRACK_MANIP", "SWAP_MANUAL", "LOCK_EVENTS", "SWAP_RANDOM"]);
}

// ============================================================
// 5) Public scoring API
// ============================================================

// Event scoring: dangerPeak + tag-scores
export function scoreEventFacts(eventKey, opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const w = preset.weights || BOT_WEIGHTS;

  const { f } = resolveEventKey(eventKey);
  if (!f) return null;

  const tagScore = sumTagScores(f.tags, EVENT_TAG_SCORES, preset);

  // danger → risk (peak)
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

    notes: [...(f.dangerNotes || []), ...(f.lootImpact?.notes || [])],
    tags: f.tags || [],
  };
}

// Action scoring: tag-scores + role bonus + affectsFlags/Track hinting + heuristics (ctx)
export function scoreActionFacts(actionKey, opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const w = preset.weights || BOT_WEIGHTS;

  const { ctx, game, me } = getCtx(opts);

  const { a } = resolveActionKey(actionKey);
  if (!a) return null;

  const tagScore = sumTagScores(a.tags, ACTION_TAG_SCORES, preset);

  // small role bonus (feel better)
  const roleBonus =
    {
      defense: { risk: -2, control: 1 },
      info: { info: 2 },
      control: { control: 2 },
      chaos: { control: 1, tempo: 1 },
      tempo: { tempo: 2, control: 1 },
      utility: { control: 1, info: 1 },
    }[a.role] || {};

  // Extra soft signal if tags are missing but action impacts flags/track
  // (keeps it stable if definitions aren't complete)
  const affectsFlags = Array.isArray(a.affectsFlags) ? a.affectsFlags : [];
  const affectsTrack = !!a.affectsTrack;

  const soft = blankScores();
  if (affectsTrack) soft.control += 1;
  if (affectsFlags.includes("lockEvents")) soft.control += 1;
  if (affectsFlags.includes("denImmune")) soft.risk -= 1;
  if (affectsFlags.includes("noPeek")) soft.control += 0.5;

  // -------------------------
  // Context-aware heuristics
  // -------------------------
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

  // A) Action budget: als je al aan je max zit → hard dempen (tenzij emergency / combo)
  const comboAllowed = !!(ctx?.comboAllowed || ctx?.comboFollowUp || ctx?.comboPrimed);
  const allowOverBudget = emergency || comboAllowed;

  if (playedThisRound >= maxPerRound && !allowOverBudget) {
    // Niet blokkeren (want ranker), maar maak het zo onaantrekkelijk dat PASS/logica wint.
    soft.risk += 9;
    soft.tempo -= 4;
    soft.control -= 2;
    soft.info -= 1;
  } else if (playedThisRound >= maxPerRound && allowOverBudget) {
    // Over budget maar wél toegestaan: kleine frictie zodat het niet standaard wordt
    soft.risk += 2.5;
    soft.tempo -= 0.5;
  }

  // B) Reserve: vroeg 2 bewaren, laat 1–2
  if (!emergency && projectedHandAfterPlay < reserve) {
    soft.risk += 5.0;      // “spaar” bias
    soft.tempo -= 1.5;
    soft.control -= 0.75;
  }

  // C) Diminishing returns op intel: als je al nextKnown hebt → intel kaarten omlaag
  const nextKnown =
    !!(ctx?.nextKnown || ctx?.scoutIntel?.nextKnown || ctx?.intel?.nextKnown || ctx?.knownNext);
  const knownUpcoming = getKnownUpcomingEvents(opts);
  const knownCount = Array.isArray(knownUpcoming) ? knownUpcoming.length : 0;

  if (!emergency && isIntelAction(a) && (nextKnown || knownCount >= 2)) {
    // Als je al info hebt, is extra peek vaak “waste”
    soft.info -= 4.0;
    soft.tempo -= 1.0;
    soft.risk += 0.75;
  }

  // D) Harde voorwaarden voor Pack Tinker (alleen als er echt iets te fixen valt)
  //    - voorkeur: botRunner geeft knownUpcomingEvents mee (wat bot weet)
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
      // duidelijk waarde: je kan een slechte binnenkort vervangen
      soft.control += 3.5;
      soft.tempo += 1.0;
      soft.risk -= 1.0;
    } else if (hasBad && !hasGood) {
      // waarschijnlijk nog steeds oké (chaos), maar minder zeker
      soft.control += 1.2;
      soft.risk += 0.5;
    } else if (hailMary) {
      // achter staan → variance is soms goed
      soft.control += 0.75;
      soft.tempo += 0.25;
      soft.risk += 1.0;
    } else {
      // geen bewijs dat dit nodig is → save it
      soft.risk += 6.0;
      soft.control -= 2.0;
      soft.tempo -= 1.0;
      soft.info -= 0.5;
    }
  }

  // E) Kick Up Dust: zeldzaam, vooral nood/hail-mary
  const isKickUpDust = a.id === "KICK_UP_DUST";
  if (isKickUpDust) {
    const { isLast, scoreBehind } = getScoreRankHints(opts);
    const hailMary = isLast || scoreBehind >= 6;

    if (emergency && !ctx?._handMeta?.hasDefense) {
      // je hebt gevaar + geen defense: noodknop wordt aantrekkelijk
      soft.tempo += 1.5;
      soft.control += 1.0;
      soft.risk -= 0.5;
    } else if (hailMary) {
      // als je achter ligt, variance mag
      soft.tempo += 0.75;
      soft.risk += 0.75;
    } else {
      // standaard: zwaar ontmoedigen
      soft.risk += 7.0;
      soft.control -= 2.0;
      soft.tempo -= 2.0;
    }
  }

  // F) Defense prioriteit bij hoge dreiging: defense actions iets omhoog bij dangerNext
  if (dangerNext >= 7 && isDefenseAction(a)) {
    soft.risk -= 2.0;
    soft.control += 0.75;
  }

  // G) Track-manip is nuttiger als er (bekend) gevaar aankomt
  if (!emergency && isTrackManipAction(a) && dangerNext >= 6) {
    soft.control += 1.25;
    soft.tempo += 0.25;
  }

  // Follow the Tail — bewaren tot jouw Den-event voorbij/revealed is
  const isFollowTail = a.id === "FOLLOW_THE_TAIL";
  if (isFollowTail) {
    const ctxRevealed =
      typeof ctx?.myDenEventRevealed === "boolean" ? ctx.myDenEventRevealed : null;

    const trackRevealed =
      ctxRevealed != null
        ? ctxRevealed
        : myDenEventAlreadyRevealed({
            game,
            me,
            denColor: opts?.denColor || me?.denColor,
          });

    if (trackRevealed === false) {
      // te vroeg: verhoog risico + verlies controle (save it)
      soft.risk += 2.5;
      soft.control -= 1.0;
      soft.tempo -= 0.5;
    } else if (trackRevealed === true) {
      // later: nuttiger als uncertainty tool
      soft.risk -= 1.0;
      soft.info += 0.5;
      soft.control += 0.5;
    } else {
      // onbekend: kleine “save bias”
      soft.risk += 0.75;
    }
  }

  // Reliability (unimplemented) — beware of “paper actions”
  const implemented = !!a.engineImplemented;
  const reliability = implemented ? 1.0 : (preset.unimplementedMult ?? 0.9);

  const s = {
    actionId: a.id,
    name: a.name,
    implemented,
    affectsFlags,
    affectsTrack,

    riskScore:
      (((tagScore.risk || 0) + (roleBonus.risk || 0) + soft.risk) * w.risk) /
      reliability,
    lootScore:
      (((tagScore.loot || 0) + (roleBonus.loot || 0) + soft.loot) * w.loot) *
      reliability,
    infoScore:
      (((tagScore.info || 0) + (roleBonus.info || 0) + soft.info) * w.info) *
      reliability,
    controlScore:
      (((tagScore.control || 0) + (roleBonus.control || 0) + soft.control) *
        w.control) *
      reliability,
    tempoScore:
      (((tagScore.tempo || 0) + (roleBonus.tempo || 0) + soft.tempo) * w.tempo) *
      reliability,

    tags: a.tags || [],
    role: a.role || "unknown",

    // debug helpers (optioneel; safe om te negeren)
    __meta: ctx?.includeMeta
      ? {
          dangerNext,
          emergency,
          playedThisRound,
          handCount,
          reserve,
          early,
          late,
        }
      : undefined,
  };

  return s;
}

// Quick-rank of actions in hand (highest total first)
// Backwards compat: rankActions(actionIds) still works.
// New: rankActions(actionIds, { presetKey, denColor, ctx })
export function rankActions(actionKeys = [], opts = {}) {
  const list = Array.isArray(actionKeys) ? actionKeys : [];
  const handMeta = computeHandMeta(list);

  // zorg dat scoreActionFacts handmeta kan gebruiken (zonder caller-wijziging)
  const ctx = opts?.ctx && typeof opts.ctx === "object" ? opts.ctx : {};
  const ctx2 = { ...ctx, _handMeta: handMeta, _handKeys: list };

  const opts2 = { ...opts, ctx: ctx2 };

  return [...list]
    .map((key) => {
      const s = scoreActionFacts(key, opts2);
      if (!s) return null;
      return { id: key, s, total: totalScore(s) };
    })
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);
}

// ============================================================
// 6) Action play gate (optional helper)
// ============================================================
//
// Gebruik in botRunner:
//
// const pick = pickActionOrPass(handIds, { game, me, ctx:{ actionsPlayedThisRound, nextEventFacts, nextKnown, isLast, scoreBehind }})
// if (pick.play) ... else PASS
//
export function pickActionOrPass(actionKeys = [], opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const minTotal = Number(preset?.tagBias?.actionPlayMinTotal ?? 3.0);
  const emergencyTotal = Number(preset?.tagBias?.emergencyActionTotal ?? 7.5);

  const ranked = rankActions(actionKeys, opts);
  if (!ranked.length) {
    return { play: null, ranked, reason: "no_actions" };
  }

  const best = ranked[0];
  const bestTotal = Number(best?.total);
  const dangerNext = getDangerNext(opts);
  const emergency = dangerNext >= 8 || opts?.ctx?.emergency === true;

  const playedThisRound = getActionsPlayedThisRound(opts);
  const maxPerRound = Number(preset?.tagBias?.maxActionsPerRound ?? 1) || 1;

  // hard budget: als al max en niet emergency/combo -> PASS
  const comboAllowed = !!(opts?.ctx?.comboAllowed || opts?.ctx?.comboFollowUp || opts?.ctx?.comboPrimed);
  const allowOverBudget = emergency || comboAllowed;

  if (playedThisRound >= maxPerRound && !allowOverBudget) {
    return { play: null, ranked, reason: "budget_max_reached" };
  }

  // threshold: niet spelen als het “meh” is (action-economie)
  if (!Number.isFinite(bestTotal)) {
    return { play: null, ranked, reason: "invalid_score" };
  }

  if (emergency) {
    if (bestTotal >= emergencyTotal) return { play: best.id, ranked, reason: "emergency_play" };
    return { play: null, ranked, reason: "emergency_but_no_good_action" };
  }

  if (bestTotal >= minTotal) return { play: best.id, ranked, reason: "above_threshold" };
  return { play: null, ranked, reason: "below_threshold" };
}

// ============================================================
// 7) Decision helper (optional)
// ============================================================
// Dit is niet verplicht voor bestaande code, maar handig als je decision-IQ wil upgraden.
export function recommendDecision(opts = {}) {
  const { me } = getCtx(opts);
  const dangerNext = getDangerNext(opts);
  const carry = estimateCarryValue(me);

  // roosters ahead (alleen als je knownUpcomingEvents meegeeft)
  const knownUpcoming = getKnownUpcomingEvents(opts);
  const facts = knownUpcoming.map((k) => getEventFacts(k) || null).filter(Boolean);
  const roostersAhead3 = facts
    .slice(0, 3)
    .filter(
      (f) =>
        safeTags(f.tags).includes("ROOSTER_TICK") ||
        String(f.id || "").includes("ROOSTER")
    ).length;

  // simpele triggers (kan botRunner direct gebruiken)
  if (carry >= 7) {
    if (dangerNext >= 5 || roostersAhead3 >= 1) return { decision: "DASH", carry, dangerNext, roostersAhead3 };
    return { decision: "LURK", carry, dangerNext, roostersAhead3 };
  }

  if (carry >= 4) {
    if (dangerNext >= 7 || roostersAhead3 >= 2) return { decision: "DASH", carry, dangerNext, roostersAhead3 };
    if (dangerNext >= 7) return { decision: "BURROW", carry, dangerNext, roostersAhead3 };
    return { decision: "LURK", carry, dangerNext, roostersAhead3 };
  }

  // carry low
  if (dangerNext >= 7) return { decision: "BURROW", carry, dangerNext, roostersAhead3 };
  return { decision: "LURK", carry, dangerNext, roostersAhead3 };
}
