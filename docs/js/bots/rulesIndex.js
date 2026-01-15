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

function normTag(t) {
  return String(t || "").trim().toUpperCase();
}

function tagSet(tags) {
  return new Set((tags || []).map(normTag).filter(Boolean));
}

function normColor(c) {
  return String(c || "").trim().toUpperCase();
}

function deriveEventDanger(ev) {
  const tags = tagSet(ev.tags);
  const cat = ev.category;

  // default: neutraal
  let dangerDash = 0;
  let dangerLurk = 0;
  let dangerBurrow = 0;
  let notes = [];

  // Lead-only events: base facts zijn 'worst-case' (voor de Lead).
  // In getEventFacts(ctx) nul je dit uit voor non-leads.
  if (tags.has("TARGET_LEAD_FOX") || tags.has("TARGET_LEAD")) {
    dangerDash = Math.max(dangerDash, 0);
    dangerBurrow = Math.max(dangerBurrow, 0);
    dangerLurk = Math.max(dangerLurk, 8);
    notes.push("LEAD_ONLY: alleen gevaarlijk voor Lead Fox (anders 0). LURK is dan riskant.");
  }

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
    // DEN is **alleen** gevaarlijk voor spelers met dezelfde denColor.
    // Base facts zijn 'worst-case' (voor de target-kleur). In getEventFacts(ctx) nul je dit uit voor non-targets.
    dangerDash = 0;
    dangerBurrow = 0;
    dangerLurk = Math.max(dangerLurk, 9);
    notes.push("DEN: alleen gevaarlijk voor spelers met dezelfde Den-kleur (anders 0). LURK is dan riskant.");
  }

  if (ev.id === "GATE_TOLL") {
    // Engine: iedereen in yard en niet-DASH: betaal 1 loot, anders caught. :contentReference[oaicite:6]{index=6}
    dangerDash = 0;
    dangerLurk = Math.max(dangerLurk, 4);
    dangerBurrow = Math.max(dangerBurrow, 4);
    notes.push("GATE_TOLL: niet-DASH moet 1 loot betalen of wordt gepakt.");
  }

  if (ev.id === "MAGPIE_SNITCH") {
    // Lead-only punishment: base is 'worst-case for Lead'. In getEventFacts(ctx) nul je dit uit voor non-leads.
    dangerDash = Math.max(dangerDash, 0);
    dangerBurrow = Math.max(dangerBurrow, 0);
    dangerLurk = Math.max(dangerLurk, 9);
    notes.push("MAGPIE_SNITCH: alleen gevaarlijk voor Lead Fox (LURK riskant; BURROW/DASH veilig). Non-leads: 0.");
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

function applyEventContext(facts, ctx) {
  if (!facts) return facts;
  const use = ctx || {};
  const game = use.game || null;
  const me = use.me || use.bot || null;

  const isLead =
    typeof use.isLead === "boolean"
      ? use.isLead
      : !!(me?.id && (game?.leadFoxId === me.id || game?.leadFox === me.id));

  const myDen = normColor(use.denColor || me?.denColor || me?.den || me?.color);
  const targetDen = normColor(facts.denColor || facts?.meta?.denColor || (facts.id || "").split("DEN_")[1]);

  const tags = tagSet(facts.tags);
  const leadOnly = tags.has("TARGET_LEAD_FOX") || facts?.lootImpact?.appliesTo === "LEAD";
  const denOnly = facts.category === "DEN" || tags.has("CATCH_BY_DEN_COLOR") || (facts.id || "").startsWith("DEN_");

  let dangerDash = facts.dangerDash;
  let dangerLurk = facts.dangerLurk;
  let dangerBurrow = facts.dangerBurrow;
  const dangerNotes = Array.isArray(facts.dangerNotes) ? [...facts.dangerNotes] : [];

  if (leadOnly && !isLead) {
    dangerDash = 0;
    dangerLurk = 0;
    dangerBurrow = 0;
    dangerNotes.push("Context: jij bent niet de Lead → dit event is voor jou veilig.");
  }

  if (denOnly && targetDen && myDen && myDen !== targetDen) {
    dangerDash = 0;
    dangerLurk = 0;
    dangerBurrow = 0;
    dangerNotes.push("Context: jouw Den-kleur matcht niet → dit DEN event is voor jou veilig.");
  }

  return {
    ...facts,
    dangerDash,
    dangerLurk,
    dangerBurrow,
    dangerNotes,
    // Handig voor UI/debug
    _ctx: { isLead, myDen, targetDen, leadOnly, denOnly },
  };
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
    denColor: ev.denColor || null,
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

// getEventFacts(eventId, ctx?)
// - zonder ctx: base facts
// - met ctx: gevaar/impact wordt gefilterd op Lead-only en Den-only events
// - als ctx ontbreekt maar globalThis.__AI_CTX bestaat, gebruiken we die automatisch
export function getEventFacts(eventId, ctx) {
  const base = RULES_INDEX.events[eventId] || null;
  const autoCtx = ctx || globalThis.__AI_CTX || null;
  return autoCtx ? applyEventContext(base, autoCtx) : base;
}
export function getActionFacts(actionId) {
  return RULES_INDEX.actions[actionId] || null;
}
