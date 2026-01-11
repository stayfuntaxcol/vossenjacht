// docs/js/bots/rulesIndex.js
// Facts Index: 100% statisch uit cards.js + engine.js
// - events: category/tags/implemented + afgeleide danger/lootImpact
// - actions: type/tags/role/implemented + affectsFlags (+ affectsTrack)

import { EVENT_DEFS, ACTION_DEFS } from "../cards.js";

// =============================
// Engine-implementatie status
// =============================

// Engine doet alle DEN_* via startsWith("DEN_") afhandelen. :contentReference[oaicite:1]{index=1}
const ENGINE_EVENT_IDS = new Set([
  "DOG_CHARGE",
  "SHEEPDOG_PATROL",
  "SECOND_CHARGE",
  "HIDDEN_NEST",
  "GATE_TOLL",
  "MAGPIE_SNITCH",
  "PAINT_BOMB_NEST",
  "ROOSTER_CROW",
  // SILENT_ALARM komt later (als jij ‘m implementeert)
]);

function isEngineEventImplemented(eventId) {
  if (!eventId) return false;
  if (eventId.startsWith("DEN_")) return true;
  return ENGINE_EVENT_IDS.has(eventId);
}

// Action-effects die engine/hulpfuncties echt ondersteunen. :contentReference[oaicite:2]{index=2}
const ENGINE_ACTION_IDS = new Set([
  "DEN_SIGNAL",        // denImmune wordt gebruikt
  "NOSE_FOR_TROUBLE",  // predictions worden beloond
  "FOLLOW_THE_TAIL",   // followTail wordt toegepast
  "PACK_TINKER",       // applyPackTinker export
  "KICK_UP_DUST",      // applyKickUpDust export
  "BURROW_BEACON",     // lockEvents blokkeert track-manip
  // HOLD_STILL: jij wil dit als “ops lock”, niet als DECISION-effect (engine-blok ga je weghalen)
]);

function isEngineActionImplemented(actionId) {
  return ENGINE_ACTION_IDS.has(actionId);
}

// =============================
// Action → flags / track impact
// =============================

const ACTION_AFFECTS = {
  SCATTER:        { affectsFlags: ["scatter"], affectsTrack: false },
  DEN_SIGNAL:     { affectsFlags: ["denImmune"], affectsTrack: false },
  NO_GO_ZONE:     { affectsFlags: ["noPeek"], affectsTrack: false },
  KICK_UP_DUST:   { affectsFlags: [], affectsTrack: true },
  BURROW_BEACON:  { affectsFlags: ["lockEvents"], affectsTrack: false },
  MOLTING_MASK:   { affectsFlags: [], affectsTrack: false },
  HOLD_STILL:     { affectsFlags: ["opsLocked"], affectsTrack: false }, // jouw bedoeling
  NOSE_FOR_TROUBLE:{ affectsFlags: ["predictions"], affectsTrack: false },
  SCENT_CHECK:    { affectsFlags: ["scentChecks"], affectsTrack: false },
  FOLLOW_THE_TAIL:{ affectsFlags: ["followTail"], affectsTrack: false },
  ALPHA_CALL:     { affectsFlags: [], affectsTrack: false },
  PACK_TINKER:    { affectsFlags: [], affectsTrack: true },
  MASK_SWAP:      { affectsFlags: [], affectsTrack: false },
};

function getActionFactsById(actionId) {
  const def = Object.values(ACTION_DEFS).find((a) => a?.id === actionId) || null;
  if (!def) return null;

  const affects = ACTION_AFFECTS[actionId] || { affectsFlags: [], affectsTrack: false };
  return {
    id: def.id,
    name: def.name,
    type: def.type || "UNKNOWN",
    phase: def.phase || null,
    timing: def.timing || null,
    tags: Array.isArray(def.tags) ? def.tags : [],
    role: def?.meta?.role || "unknown",
    engineImplemented: isEngineActionImplemented(def.id),
    affectsFlags: affects.affectsFlags,
    affectsTrack: affects.affectsTrack,
  };
}

// =============================
// Event → danger/lootImpact
// =============================

function tagSet(tags) {
  return new Set((tags || []).map(String));
}

function deriveEventDanger(ev) {
  const tags = tagSet(ev.tags);
  const cat = ev.category;

  // default: neutraal
  let dangerDash = 0;
  let dangerLurk = 0;
  let dangerBurrow = 0;
  let notes = [];

  // DASH wordt vaak “veilig” bij catch-events (behalve Patrol). :contentReference[oaicite:3]{index=3}
  if (tags.has("CATCH_DASHERS")) {
    dangerDash = 9;
    dangerLurk = 1;
    dangerBurrow = 0;
    notes.push("CATCH_DASHERS: DASH is gevaarlijk.");
  }

  if (tags.has("CATCH_ALL_YARD")) {
    // Engine: DOG_CHARGE/SECOND_CHARGE pakken niet-DASH en niet-BURROW (en niet denImmune). :contentReference[oaicite:4]{index=4}
    dangerDash = Math.max(dangerDash, 0);
    dangerBurrow = Math.max(dangerBurrow, 0);
    dangerLurk = Math.max(dangerLurk, 9);
    notes.push("CATCH_ALL_YARD: LURK is gevaarlijk (BURROW en DASH veilig).");
  }

  if (cat === "DEN") {
    // Alleen gevaarlijk als jouw denColor matcht + niet immune + niet BURROW/DASH. 
    dangerDash = 0;
    dangerBurrow = 0;
    dangerLurk = Math.max(dangerLurk, 4); // baseline: conditioneel
    notes.push("DEN: gevaar is conditioneel op jouw Den-kleur.");
  }

  if (ev.id === "GATE_TOLL") {
    // Engine: iedereen in yard en niet-DASH: betaal 1 loot, anders caught. :contentReference[oaicite:6]{index=6}
    dangerDash = 0;
    dangerLurk = Math.max(dangerLurk, 4);
    dangerBurrow = Math.max(dangerBurrow, 4);
    notes.push("GATE_TOLL: niet-DASH moet 1 loot betalen of wordt gepakt.");
  }

  if (ev.id === "MAGPIE_SNITCH") {
    notes.push("MAGPIE_SNITCH: target Lead Fox (niet-BURROW, niet-DASH).");
  }

  return { dangerDash, dangerLurk, dangerBurrow, notes };
}

function deriveLootImpact(ev) {
  const tags = tagSet(ev.tags);
  const out = {
    kind: "NONE",     // NONE | BONUS | PENALTY | RESET | TEMPO | REDISTRIBUTE
    appliesTo: "ALL", // ALL | DASH | LEAD | NON_DASH | YARD
    amount: null,
    notes: [],
  };

  if (ev.id === "HIDDEN_NEST") {
    out.kind = "BONUS";
    out.appliesTo = "DASH";
    out.notes.push("Hidden Nest: dashers krijgen bonus loot afhankelijk van aantal dashers.");
  }

  if (ev.id === "GATE_TOLL") {
    out.kind = "PENALTY";
    out.appliesTo = "NON_DASH";
    out.amount = 1;
    out.notes.push("Gate Toll: betaal 1 loot of caught.");
  }

  if (ev.id === "MAGPIE_SNITCH") {
    out.kind = "PENALTY";
    out.appliesTo = "LEAD";
    out.amount = "ALL";
    out.notes.push("Magpie Snitch: Lead Fox kan alle buit verliezen.");
  }

  if (ev.id === "PAINT_BOMB_NEST") {
    out.kind = "RESET";
    out.appliesTo = "SACK";
    out.notes.push("Paint-Bomb Nest: sack terug in lootDeck + shuffle.");
  }

  if (tags.has("ROOSTER_TICK") || tags.has("raid_end_trigger")) {
    out.kind = "TEMPO";
    out.appliesTo = "ALL";
    out.notes.push("Rooster Crow: tempo/raid-einde druk (3e crow eindigt raid).");
  }

  return out;
}

function getEventFactsById(eventId) {
  const ev = EVENT_DEFS[eventId] || null;
  if (!ev) return null;

  const danger = deriveEventDanger(ev);
  const lootImpact = deriveLootImpact(ev);

  return {
    id: ev.id,
    title: ev.title,
    category: ev.category || "UNKNOWN",
    tags: Array.isArray(ev.tags) ? ev.tags : [],
    engineImplemented: isEngineEventImplemented(ev.id),
    dangerDash: danger.dangerDash,
    dangerLurk: danger.dangerLurk,
    dangerBurrow: danger.dangerBurrow,
    dangerNotes: danger.notes,
    lootImpact,
  };
}

// =============================
// Build full index
// =============================

export function buildRulesIndex() {
  const events = {};
  for (const id of Object.keys(EVENT_DEFS)) {
    events[id] = getEventFactsById(id);
  }

  const actions = {};
  for (const a of Object.values(ACTION_DEFS)) {
    if (!a?.id) continue;
    actions[a.id] = getActionFactsById(a.id);
  }

  return { events, actions };
}

export const RULES_INDEX = buildRulesIndex();

export function getEventFacts(eventId) {
  return RULES_INDEX.events[eventId] || null;
}
export function getActionFacts(actionId) {
  return RULES_INDEX.actions[actionId] || null;
}
