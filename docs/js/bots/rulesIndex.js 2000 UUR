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

function deriveEventDanger(ev, ctx) {
  const tags = tagSet(ev.tags);
  const cat = ev.category;

  // default: neutraal
  let dangerDash = 0;
  let dangerLurk = 0;
  let dangerBurrow = 0;
  let notes = [];

  // Den Signal immunity helper (bots/advisor)
  const ctxDen = String(
    ctx?.denColor || ctx?.me?.denColor || ctx?.me?.den || ctx?.me?.color || ""
  )
    .trim()
    .toUpperCase();

  const denImmune =
    (ctx?.flagsRound && typeof ctx.flagsRound === "object" ? ctx.flagsRound.denImmune : null) ||
    (ctx?.flags && typeof ctx.flags === "object" ? ctx.flags.denImmune : null) ||
    (ctx?.game?.flagsRound && typeof ctx.game.flagsRound === "object" ? ctx.game.flagsRound.denImmune : null) ||
    null;

  const myImmune = !!(denImmune && ctxDen && denImmune[ctxDen]);
  // DASH wordt vaak “veilig” bij catch-events (behalve Patrol). :contentReference[oaicite:3]{index=3}
  if (tags.has("CATCH_DASHERS")) {
    dangerDash = 9;
    dangerLurk = 0;
    dangerBurrow = 0;
    notes.push("CATCH_DASHERS: DASH is gevaarlijk.");
  }
  
 // ROOSTER_CROW: 1e/2e is alleen tempo; pas 3e crow = raid eindigt
if (ev.id === "ROOSTER_CROW") {
  const r =
    Number.isFinite(Number(ctx?.roosterSeen)) ? Number(ctx.roosterSeen)
    : Number.isFinite(Number(ctx?.game?.roosterSeen)) ? Number(ctx.game.roosterSeen)
    : 0;

  if (r >= 2) {
    dangerDash = Math.min(dangerDash, 1);
    dangerLurk = Math.max(dangerLurk, 10);
    dangerBurrow = Math.max(dangerBurrow, 10);
    notes.push("ROOSTER_CROW: 3e crow → raid eindigt; DASH is prioriteit.");
  } else {
    dangerDash = 0; dangerLurk = 0; dangerBurrow = 0;
    notes.push("ROOSTER_CROW: tick-only tot na 2e crow (geen catch).");
  }
}

  // Sheepdog Patrol is NOT a "general danger" event: it's SAFE for everyone except DASH.
  // Bots should not "panic dash" here; they should prefer staying (LURK) unless other reasons push DASH.
  if (ev.id === "SHEEPDOG_PATROL") {
    dangerDash = 9;
    dangerLurk = 0;
    dangerBurrow = 5;
    notes.push("SHEEPDOG_PATROL: alleen DASH is gevaarlijk; LURK is veilig.");
  }
  
  if (tags.has("CATCH_ALL_YARD")) {
    // Engine: DOG_CHARGE/SECOND_CHARGE pakken niet-DASH en niet-BURROW (en niet denImmune). :contentReference[oaicite:4]{index=4}
    dangerDash = Math.max(dangerDash, 0);
    dangerBurrow = Math.max(dangerBurrow, 0);
    dangerLurk = Math.max(dangerLurk, 9);
    notes.push("CATCH_ALL_YARD: LURK is gevaarlijk (BURROW en DASH veilig).");

    // ✅ DEN_SIGNAL: als jouw denImmune actief is, neutraliseert dit DOG_CHARGE/SECOND_CHARGE
    if (myImmune && (ev.id === "DOG_CHARGE" || ev.id === "SECOND_CHARGE")) {
      dangerDash = 0;
      dangerLurk = 0;
      dangerBurrow = 0;
      notes.push("DEN_SIGNAL: jouw den is immune -> charge geneutraliseerd (stay veilig).");
    }
  }

  if (cat === "DEN") {
    // Alleen gevaarlijk als jouw denColor matcht.
    const myDen = String(ctx?.denColor || "").trim().toUpperCase();
    const evDen = String(ev.id.split("_")[1] || "").trim().toUpperCase();

    dangerDash = 0;
    dangerBurrow = 0;

    if (myDen && evDen) {
      if (myDen === evDen) {
        const immuneToDen = !!(denImmune && evDen && denImmune[evDen]);

        if (immuneToDen) {
          dangerDash = 0;
          dangerLurk = 0;
          dangerBurrow = 0;
          notes.push("DEN_SIGNAL: jouw den is immune -> DEN-event geneutraliseerd (stay veilig).");
        } else {
          dangerLurk = Math.max(dangerLurk, 9);
          notes.push("DEN: jouw kleur → LURK gevaarlijk (DASH/BURROW veilig).");
        }
      } else {
        // Niet jouw kleur: praktisch geen reden om te dashen puur om dit event.
        dangerLurk = Math.max(dangerLurk, 0);
        notes.push("DEN: niet jouw kleur → laag risico.");
      }
    } else {
      // Als ctx ontbreekt, geef neutrale baseline.
      dangerLurk = Math.max(dangerLurk, 4);
      notes.push("DEN: risico hangt af van jouw Den-kleur.");
    }
  }

  if (ev.id === "GATE_TOLL") {
    // Engine: iedereen in yard en niet-DASH: betaal 1 loot, anders caught.
    // Belangrijk voor bots: dit is meestal een TAX (mild) als je >=1 loot hebt,
    // maar is LETHAL als je 0 loot hebt (je kunt niet betalen).
    dangerDash = 0;

    // ctx may provide exact loot length / carry points (bots know their own).
    // If unknown, keep it mild to avoid overreacting.
    const lootLenRaw =
      (typeof ctx?.lootLen === "number" ? ctx.lootLen : NaN) ||
      (typeof ctx?.lootCount === "number" ? ctx.lootCount : NaN) ||
      (Array.isArray(ctx?.me?.loot) ? ctx.me.loot.length : NaN);

    const lootLen = Number.isFinite(Number(lootLenRaw)) ? Number(lootLenRaw) : NaN;

    const carryRaw =
      (typeof ctx?.carryExact === "number" ? ctx.carryExact : NaN) ||
      (typeof ctx?.carryValueExact === "number" ? ctx.carryValueExact : NaN) ||
      (typeof ctx?.carryValue === "number" ? ctx.carryValue : NaN);

    const carry = Number.isFinite(Number(carryRaw)) ? Number(carryRaw) : NaN;

    const hasInfo = Number.isFinite(lootLen) || Number.isFinite(carry);
    const canPay =
      (Number.isFinite(lootLen) ? lootLen > 0 : false) ||
      (Number.isFinite(carry) ? carry > 0 : false);

    if (!hasInfo) {
      dangerLurk = Math.max(dangerLurk, 2);
      dangerBurrow = Math.max(dangerBurrow, 2);
      notes.push("GATE_TOLL: mild (tax) als je loot hebt; lethal alleen als je 0 loot hebt.");
    } else if (canPay) {
      dangerLurk = Math.max(dangerLurk, 1);
      dangerBurrow = Math.max(dangerBurrow, 1);
      notes.push("GATE_TOLL: je kunt betalen -> laag danger (wel loot penalty).");
    } else {
      dangerLurk = Math.max(dangerLurk, 9);
      dangerBurrow = Math.max(dangerBurrow, 9);
      notes.push("GATE_TOLL: 0 loot -> stay is lethal (caught).");
    }
  }

  // ---- Targeted events (Lead Fox only) ----
  // Als een event alleen de Lead raakt: niet-Lead spelers moeten GEEN extra 'danger' krijgen
  // (anders gaan bots onterecht DASH-bias krijgen).
  const targetsLead = tags.has("TARGET_LEAD_FOX") || tags.has("target_lead_fox");
  if (targetsLead) {
    if (ctx && typeof ctx.isLead === "boolean") {
      if (!ctx.isLead) {
        dangerDash = 0;
        dangerLurk = 0;
        dangerBurrow = 0;
        notes.push("TARGET_LEAD_FOX: raakt jou niet (niet-Lead) → danger=0.");
      } else {
        notes.push("TARGET_LEAD_FOX: raakt jou (Lead).");
      }
    } else if (!ctx) {
      notes.push("TARGET_LEAD_FOX: context ontbreekt (Lead-check nodig).");
    } else {
      notes.push("TARGET_LEAD_FOX: ctx.isLead ontbreekt; baseline danger blijft staan.");
    }
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

  if (ev.id === "SILENT_ALARM") {
    out.kind = "PENALTY";
    out.appliesTo = "LEAD";
    out.amount = 2;
    out.notes.push("Silent Alarm: Lead moet 2 loot afleggen (anders verliest hij lead-status)." );
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

  const danger = deriveEventDanger(ev, null);
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

export function getEventFacts(eventId, ctx) {
  const base = RULES_INDEX.events[eventId] || null;
  if (!base) return null;

  // context-aware overlay (voor bots/advisor)
  if (!ctx) return base;

  // Clone, zodat RULES_INDEX statisch blijft
  const out = { ...base };
  const ev = EVENT_DEFS[eventId] || null;
  if (!ev) return out;

  const danger = deriveEventDanger(ev, ctx);
  out.dangerDash = danger.dangerDash;
  out.dangerLurk = danger.dangerLurk;
  out.dangerBurrow = danger.dangerBurrow;
  out.dangerNotes = danger.notes;
  return out;
}
export function getActionFacts(actionId) {
  return RULES_INDEX.actions[actionId] || null;
}

