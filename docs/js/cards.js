// cards.js – centrale definities voor Events, Actions en Loot
// Alle kaarten hebben een imageFront + imageBack (fallback naar card_vossenjacht.png)

const CARD_BACK = "./assets/card_vossenjacht.png";

// ======================
// EVENT CARDS
// ======================

export const EVENT_DEFS = {
  // Den events (kleur-checks)
  DEN_RED: {
    id: "DEN_RED",
    title: "Coop Check (Rode Den)",
    text: "Alle vossen met een rode Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_coop_check_red.png",
    imageBack: CARD_BACK,
  },
  DEN_BLUE: {
    id: "DEN_BLUE",
    title: "Feed Run (Blauwe Den)",
    text: "Alle vossen met een blauwe Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_feed_run_blue.png",
    imageBack: CARD_BACK,
  },
  DEN_GREEN: {
    id: "DEN_GREEN",
    title: "Fence Patrol (Groene Den)",
    text: "Alle vossen met een groene Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_fence_patrol_green.png",
    imageBack: CARD_BACK,
  },
  DEN_YELLOW: {
    id: "DEN_YELLOW",
    title: "Barn Sweep (Gele Den)",
    text: "Alle vossen met een gele Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_barn_sweep_yellow.png",
    imageBack: CARD_BACK,
  },

  // Honden / drukte
  DOG_CHARGE: {
    id: "DOG_CHARGE",
    title: "Sheepdog Charge",
    text: "De herdershond rent door de Yard. Iedereen wordt geraakt, behalve vossen die BURROW hebben gespeeld of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_sheepdog_charge.png",
    imageBack: CARD_BACK,
  },
  SHEEPDOG_PATROL: {
    id: "SHEEPDOG_PATROL",
    title: "Sheepdog Patrol",
    text: "Dashers worden gepakt; BURROW helpt niet. (Digitale effecten volgen Egg Run-regels; nog niet volledig geïmplementeerd).",
    imageFront: "./assets/card_event_sheepdog_patrol.png",
    imageBack: CARD_BACK,
  },
  SECOND_CHARGE: {
    id: "SECOND_CHARGE",
    title: "Second Charge",
    text: "Gedraagt zich als een tweede Sheepdog Charge. (Regels volgen Egg Run; effect kan later verder worden verfijnd.)",
    imageFront: "./assets/card_event_second_charge.png",
    imageBack: CARD_BACK,
  },

  // Rooster
  ROOSTER_CROW: {
    id: "ROOSTER_CROW",
    title: "Rooster Crow",
    text: "De haan kraait. Bij de derde Rooster Crow eindigt de raid; alleen Dashers scoren en verdelen de Sack.",
    imageFront: "./assets/card_event_rooster_crow.png",
    imageBack: CARD_BACK,
  },

  // Speciale variabele events
  MAGPIE_SNITCH: {
    id: "MAGPIE_SNITCH",
    title: "Magpie Snitch",
    text: "De ekster verraadt de Lead Fox. Tenzij hij BURROW heeft, wordt hij gepakt en verliest alle buit.",
    imageFront: "./assets/card_event_magpie_snitch.png",
    imageBack: CARD_BACK,
  },
  PAINT_BOMB_NEST: {
    id: "PAINT_BOMB_NEST",
    title: "Paint-Bomb Nest",
    text: "Alle buit in de Sack gaat terug naar de Loot Deck en wordt geschud.",
    imageFront: "./assets/card_event_paint_bomb_nest.png",
    imageBack: CARD_BACK,
  },
  HIDDEN_NEST: {
    id: "HIDDEN_NEST",
    title: "Hidden Nest",
    text: "Als exact één vos DASH heeft gekozen, krijgt hij 4 extra buitkaarten. Bij meer Dashers profiteert niemand.",
    imageFront: "./assets/card_event_hidden_nest.png",
    imageBack: CARD_BACK,
  },
  GATE_TOLL: {
    id: "GATE_TOLL",
    title: "Gate Toll",
    text: "Vossen in de Yard moeten 1 buit afgeven of worden gepakt bij het hek.",
    imageFront: "./assets/card_event_gate_toll.png",
    imageBack: CARD_BACK,
  },
  BAD_MAP: {
    id: "BAD_MAP",
    title: "Bad Map",
    text: "Verwissel dit event met een willekeurig ongebruikt variabel event. (Digitale variant kan later worden uitgewerkt.)",
    imageFront: "./assets/card_event_bad_map.png",
    imageBack: CARD_BACK,
  },
};

// Helper om een event-def op te halen
export function getEventById(id) {
  return EVENT_DEFS[id] || null;
}

// ======================
// ACTION CARDS
// ======================

export const ACTION_DEFS = {
  "Molting Mask": {
    name: "Molting Mask",
    imageFront: "./assets/card_action_molting_mask.png",
    imageBack: CARD_BACK,
  },
  "Scent Check": {
    name: "Scent Check",
    imageFront: "./assets/card_action_scent_check.png",
    imageBack: CARD_BACK,
  },
  "Follow the Tail": {
    name: "Follow the Tail",
    imageFront: "./assets/card_action_follow_tail.png",
    imageBack: CARD_BACK,
  },
  "Scatter!": {
    name: "Scatter!",
    // je hebt al card_scatter.png – beide mogen naar hetzelfde wijzen
    imageFront: "./assets/card_action_scatter.png",
    fallbackFront: "./assets/card_scatter.png",
    imageBack: CARD_BACK,
  },
  "Den Signal": {
    name: "Den Signal",
    imageFront: "./assets/card_action_den_signal.png",
    imageBack: CARD_BACK,
  },
  "Alpha Call": {
    name: "Alpha Call",
    imageFront: "./assets/card_action_alpha_call.png",
    imageBack: CARD_BACK,
  },
  "No-Go Zone": {
    name: "No-Go Zone",
    imageFront: "./assets/card_action_no_go_zone.png",
    imageBack: CARD_BACK,
  },
  "Countermove": {
    name: "Countermove",
    imageFront: "./assets/card_action_countermove.png",
    imageBack: CARD_BACK,
  },
  "Hold Still": {
    name: "Hold Still",
    imageFront: "./assets/card_action_hold_still.png",
    imageBack: CARD_BACK,
  },
  "Kick Up Dust": {
    name: "Kick Up Dust",
    imageFront: "./assets/card_action_kick_up_dust.png",
    imageBack: CARD_BACK,
  },
  "Pack Tinker": {
    name: "Pack Tinker",
    imageFront: "./assets/card_action_pack_tinker.png",
    imageBack: CARD_BACK,
  },
  "Mask Swap": {
    name: "Mask Swap",
    imageFront: "./assets/card_action_mask_swap.png",
    imageBack: CARD_BACK,
  },
  "Nose for Trouble": {
    name: "Nose for Trouble",
    imageFront: "./assets/card_action_nose_for_trouble.png",
    imageBack: CARD_BACK,
  },
  "Burrow Beacon": {
    name: "Burrow Beacon",
    // je hebt al card_beacon.png
    imageFront: "./assets/card_action_burrow_beacon.png",
    fallbackFront: "./assets/card_beacon.png",
    imageBack: CARD_BACK,
  },
};

export function getActionDefByName(name) {
  const def = ACTION_DEFS[name];
  if (!def) return null;
  // als imageFront niet bestaat maar fallbackFront wel, gebruik die als front path
  if (!def.imageFront && def.fallbackFront) {
    return { ...def, imageFront: def.fallbackFront };
  }
  return def;
}

// ======================
// LOOT CARDS
// ======================

export const LOOT_IMAGES = {
  Egg: "./assets/card_loot_egg.png",
  Hen: "./assets/card_loot_hen.png",
  "Prize Hen": "./assets/card_loot_prizehen.png",
};

export function getLootImageForType(type) {
  return LOOT_IMAGES[type] || CARD_BACK;
}

// ======================
// Overige exports (optioneel handig)
// ======================

export { CARD_BACK };
