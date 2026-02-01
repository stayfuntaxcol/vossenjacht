// docs/js/bots/botPresets.js  (CANON clean runtime JS)
// NOTE: This file replaces a TypeScript .d.ts-style stub that would crash in the browser.
// CANON rules:
// - No preset may push DASH/BURROW based on carry/loot.
// - Presets may only tune "style" weights for action scoring (risk/info/control/tempo/loot),
//   but final DECISION (LURK/BURROW/DASH) stays governed by strategy_no_restrictions.js CANON.

const DEN = (x) => String(x || "").trim().toUpperCase();

// Simple weights used by botHeuristics/rankActions (if you use them).
// Keep these about play-style; do NOT encode cashout/carry/rooster behaviour here.
export const BOT_PRESETS = {
  RED: {
    key: "RED",
    weights:   { risk: 0.9, loot: 1.0, info: 0.8, control: 0.9, tempo: 1.0 },
    coreOverride: {},
    tagBias: {},
  },
  BLUE: {
    key: "BLUE",
    weights:   { risk: 1.1, loot: 0.9, info: 1.0, control: 1.0, tempo: 0.9 },
    coreOverride: {},
    tagBias: {},
  },
  GREEN: {
    key: "GREEN",
    weights:   { risk: 1.2, loot: 0.9, info: 0.9, control: 1.0, tempo: 0.8 },
    coreOverride: {},
    tagBias: {},
  },
  YELLOW: {
    key: "YELLOW",
    weights:   { risk: 1.0, loot: 1.0, info: 1.1, control: 0.9, tempo: 1.0 },
    coreOverride: {},
    tagBias: {},
  },
};

const BLOCK_CORE_KEYS = [
  // Anything that would reintroduce cashout/carry/rooster/panic behaviour:
  "cashout", "carry", "rooster", "panic", "dash", "burrow", "sack", "lootSack",
  // also block dashPush tuning from presets (decision engine owns this):
  "dashpush",
];

// Remove keys that could contradict CANON if someone passes coreOverride.
function sanitizeCoreOverride(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const kk = String(k || "").toLowerCase();
    if (BLOCK_CORE_KEYS.some((w) => kk.includes(w))) continue;
    out[k] = v;
  }
  return out;
}

export function presetFromDenColor(denColor) {
  const c = DEN(denColor);
  if (c === "RED") return "RED";
  if (c === "BLUE") return "BLUE";
  if (c === "GREEN") return "GREEN";
  if (c === "YELLOW") return "YELLOW";
  // default
  return "BLUE";
}

export function getPreset(presetKey) {
  const k = DEN(presetKey);
  const base = BOT_PRESETS[k] || BOT_PRESETS.BLUE;

  // return a defensive clone + sanitized overrides
  return {
    key: base.key,
    weights: { ...(base.weights || {}) },
    coreOverride: sanitizeCoreOverride(base.coreOverride || {}),
    tagBias: { ...(base.tagBias || {}) },
  };
}

