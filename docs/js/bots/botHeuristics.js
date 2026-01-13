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
// Nieuw:
// - presetFromDenColor(denColor)
// - rankActions(actionIds, { presetKey, denColor })
// - scoreEventFacts(eventKey, { presetKey, denColor })
// - scoreActionFacts(actionKey, { presetKey, denColor })
//
// Let op: "denColor" hier is je gameplay Den-kleur. Jij wil bots hieraan koppelen,
// dus presetKey default = presetFromDenColor(denColor) als je die meegeeft.

import { RULES_INDEX, getEventFacts, getActionFacts } from "./rulesIndex.js";

// ============================================================
// 1) Presets (koppel dit aan Den-kleur)
// ============================================================
export const BOT_PRESETS = {
  // ROOD = tempo/agro (accept more risk for pressure)
  RED: {
    weights: { risk: 0.75, loot: 1.05, info: 0.8, control: 0.85, tempo: 1.25 },
    unimplementedMult: 0.90,
    tagBias: {
      ROOSTER_TICK: 1.20,
      raid_end_trigger: 1.20,
      dash_reward: 1.10,
    },
  },

  // GROEN = defensief/stable (protect loot, reduce variance)
  GREEN: {
    weights: { risk: 1.35, loot: 0.95, info: 0.9, control: 1.10, tempo: 0.75 },
    unimplementedMult: 0.90,
    tagBias: {
      CATCH_DASHERS: 1.25,
      CATCH_ALL_YARD: 1.20,
      CATCH_BY_DEN_COLOR: 1.15,
      DEN_IMMUNITY: 1.25,
      LOCK_EVENTS: 1.10,
      LOCK_OPS: 1.10,
    },
  },

  // GEEL = greedy/opportunist (max loot value, hates sack reset)
  YELLOW: {
    weights: { risk: 1.00, loot: 1.35, info: 0.85, control: 0.85, tempo: 0.90 },
    unimplementedMult: 0.90,
    tagBias: {
      dash_reward: 1.25,
      multi_dasher_bonus: 1.20,
      reset_sack: 1.35, // makes negative loot impact matter more
    },
  },

  // BLAUW = info/control (setups, track manipulation, deny scout)
  BLUE: {
    weights: { risk: 1.05, loot: 0.95, info: 1.25, control: 1.25, tempo: 0.85 },
    unimplementedMult: 0.90,
    tagBias: {
      INFO: 1.20,
      PEEK_DECISION: 1.15,
      PREDICT_EVENT: 1.20,
      TRACK_MANIP: 1.20,
      SWAP_MANUAL: 1.10,
      BLOCK_SCOUT: 1.20,
      BLOCK_SCOUT_POS: 1.15,
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
    String(presetKey || "").trim().toUpperCase() ||
    presetFromDenColor(denColor);
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
  COPY_DECISION_LATER: { info: 2, control: 2 },
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
  return (s.controlScore || 0) + (s.infoScore || 0) + (s.lootScore || 0) + (s.tempoScore || 0) - (s.riskScore || 0);
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
  const dangerPeak = Math.max(f.dangerDash || 0, f.dangerLurk || 0, f.dangerBurrow || 0);

  const implemented = !!f.engineImplemented;
  const reliability = implemented ? 1.0 : (preset.unimplementedMult ?? 0.90);

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

// Action scoring: tag-scores + role bonus + affectsFlags/Track hinting
export function scoreActionFacts(actionKey, opts = {}) {
  const preset = getPreset(opts.presetKey, opts.denColor);
  const w = preset.weights || BOT_WEIGHTS;

  const { a } = resolveActionKey(actionKey);
  if (!a) return null;

  const tagScore = sumTagScores(a.tags, ACTION_TAG_SCORES, preset);

  // small role bonus (feel better)
  const roleBonus = {
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

  const implemented = !!a.engineImplemented;
  const reliability = implemented ? 1.0 : (preset.unimplementedMult ?? 0.90);

  const s = {
    actionId: a.id,
    name: a.name,
    implemented,
    affectsFlags,
    affectsTrack,

    riskScore: ((tagScore.risk || 0) + (roleBonus.risk || 0) + soft.risk) * w.risk / reliability,
    lootScore: ((tagScore.loot || 0) + (roleBonus.loot || 0) + soft.loot) * w.loot * reliability,
    infoScore: ((tagScore.info || 0) + (roleBonus.info || 0) + soft.info) * w.info * reliability,
    controlScore: ((tagScore.control || 0) + (roleBonus.control || 0) + soft.control) * w.control * reliability,
    tempoScore: ((tagScore.tempo || 0) + (roleBonus.tempo || 0) + soft.tempo) * w.tempo * reliability,

    tags: a.tags || [],
    role: a.role || "unknown",
  };

  return s;
}

// Quick-rank of actions in hand (highest total first)
// Backwards compat: rankActions(actionIds) still works.
// New: rankActions(actionIds, { presetKey, denColor })
export function rankActions(actionKeys = [], opts = {}) {
  return [...(Array.isArray(actionKeys) ? actionKeys : [])]
    .map((key) => {
      const s = scoreActionFacts(key, opts);
      if (!s) return null;
      return { id: key, s, total: totalScore(s) };
    })
    .filter(Boolean)
    .sort((a, b) => (b.total - a.total));
}
