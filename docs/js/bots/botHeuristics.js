// docs/js/bots/botHeuristics.js
// Heuristiek basis (zonder Firebase):
// - riskScore, lootScore, infoScore, controlScore
// - mapping tags → scores
// - helpers: scoreEventFacts, scoreActionFacts

import { getEventFacts, getActionFacts } from "./rulesIndex.js";

// =============================
// Basis weights (later tunable)
// =============================
export const BOT_WEIGHTS = {
  risk: 1.0,
  loot: 1.0,
  info: 0.8,
  control: 0.7,
  tempo: 0.6,
};

// =============================
// Tag → score mapping (simpel)
// =============================
const EVENT_TAG_SCORES = {
  CATCH_DASHERS:      { risk: 8, tempo: 1 },
  CATCH_ALL_YARD:     { risk: 7, tempo: 1 },
  CATCH_BY_DEN_COLOR: { risk: 4, tempo: 0 },
  ROOSTER_TICK:       { tempo: 6 },
  raid_end_trigger:   { tempo: 6 },

  dash_reward:        { loot: 6 },
  multi_dasher_bonus: { loot: 3 },

  pay_loot_or_caught: { risk: 4, loot: -3 },
  lose_loot:          { risk: 5, loot: -6 },
  reset_sack:         { loot: -4, control: 1 },
};

const ACTION_TAG_SCORES = {
  // info
  INFO:               { info: 6 },
  PEEK_DECISION:      { info: 5 },
  PREDICT_EVENT:      { info: 4 },

  // control / track
  TRACK_MANIP:        { control: 6 },
  SWAP_MANUAL:        { control: 7 },
  SWAP_RANDOM:        { control: 4 },
  LOCK_EVENTS:        { control: 4 },

  // deny info
  BLOCK_SCOUT:        { control: 5 },
  BLOCK_SCOUT_POS:    { control: 4 },

  // defense
  DEN_IMMUNITY:       { risk: -6, control: 2 },
  LOCK_OPS:           { control: 5, tempo: 2 },

  // utility
  COPY_DECISION_LATER:{ info: 2, control: 2 },
  SET_LEAD:           { control: 4 },
};

// =============================
// Scoring helpers
// =============================
function sumTagScores(tags, map) {
  const out = { risk: 0, loot: 0, info: 0, control: 0, tempo: 0 };
  for (const t of tags || []) {
    const s = map[t];
    if (!s) continue;
    out.risk += s.risk || 0;
    out.loot += s.loot || 0;
    out.info += s.info || 0;
    out.control += s.control || 0;
    out.tempo += s.tempo || 0;
  }
  return out;
}

// Event scoring: combineer afgeleide danger + tag-scores
export function scoreEventFacts(eventId) {
  const f = getEventFacts(eventId);
  if (!f) return null;

  const tagScore = sumTagScores(f.tags, EVENT_TAG_SCORES);

  // danger naar “risk” vertalen: we nemen de hoogste danger als “event gevaar”
  const dangerPeak = Math.max(f.dangerDash || 0, f.dangerLurk || 0, f.dangerBurrow || 0);

  return {
    eventId: f.id,
    implemented: !!f.engineImplemented,
    riskScore: (dangerPeak * BOT_WEIGHTS.risk) + (tagScore.risk * BOT_WEIGHTS.risk),
    lootScore: (tagScore.loot * BOT_WEIGHTS.loot),
    infoScore: (tagScore.info * BOT_WEIGHTS.info),
    controlScore: (tagScore.control * BOT_WEIGHTS.control),
    tempoScore: (tagScore.tempo * BOT_WEIGHTS.tempo),
    notes: [...(f.dangerNotes || []), ...(f.lootImpact?.notes || [])],
  };
}

// Action scoring: tag-scores + role bias
export function scoreActionFacts(actionId) {
  const a = getActionFacts(actionId);
  if (!a) return null;

  const tagScore = sumTagScores(a.tags, ACTION_TAG_SCORES);

  // kleine role-bonus (maakt “feel” beter)
  const roleBonus = {
    defense: { risk: -2, control: 1 },
    info:    { info: 2 },
    control: { control: 2 },
    chaos:   { control: 1, tempo: 1 },
    tempo:   { tempo: 2, control: 1 },
    utility: { control: 1, info: 1 },
  }[a.role] || {};

  return {
    actionId: a.id,
    name: a.name,
    implemented: !!a.engineImplemented,
    affectsFlags: a.affectsFlags || [],
    affectsTrack: !!a.affectsTrack,

    riskScore: ((tagScore.risk || 0) + (roleBonus.risk || 0)) * BOT_WEIGHTS.risk,
    lootScore: ((tagScore.loot || 0) + (roleBonus.loot || 0)) * BOT_WEIGHTS.loot,
    infoScore: ((tagScore.info || 0) + (roleBonus.info || 0)) * BOT_WEIGHTS.info,
    controlScore: ((tagScore.control || 0) + (roleBonus.control || 0)) * BOT_WEIGHTS.control,
    tempoScore: ((tagScore.tempo || 0) + (roleBonus.tempo || 0)) * BOT_WEIGHTS.tempo,
  };
}

// Handig: quick-rank van acties in hand (hoogste totaal eerst)
export function rankActions(actionIds = []) {
  return [...actionIds]
    .map((id) => ({ id, s: scoreActionFacts(id) }))
    .filter((x) => x.s)
    .sort((a, b) => {
      const ta = a.s.controlScore + a.s.infoScore + a.s.lootScore - a.s.riskScore + a.s.tempoScore;
      const tb = b.s.controlScore + b.s.infoScore + b.s.lootScore - b.s.riskScore + b.s.tempoScore;
      return tb - ta;
    });
}
