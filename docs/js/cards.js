// cards.js
// Centrale definities van alle kaarten in Vossenjacht (1 bron van waarheid).
// Bevat GEEN DOM-code, alleen data + helpers.
//
// Exports:
// - CARD_BACK
// - EVENT_DEFS, getEventById, getEventsByCategory
// - ACTION_DEFS, ACTION_CARD_INFO, getActionDefByName, getActionInfoByName, getActionIdByName, getActionsByType
// - LOOT_DEFS, LOOT_IMAGES, getLootDef, getLootImageForType
// - PLAYER_PROFILE_DEFS, getPlayerProfileById
// - ACTIVITY_DEFS, getActivityById

// ======================
// BACK (alle kaarten)
// ======================
export const CARD_BACK = "./assets/card_vossenjacht.png";

// ======================
// EVENT CARDS
// ======================
// Tags: gebruik ook UPPERCASE tags voor de advisor/scoring (bv CATCH_DASHERS / CATCH_ALL_YARD).
export const EVENT_DEFS = {
  // ---- Den events (kleur-checks) ----
  DEN_RED: {
    id: "DEN_RED",
    title: "Coop Check (Rode Den)",
    text: "Alle vossen met een rode Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_coop_check_red.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "RED",
    tags: ["den_check", "catch_by_color", "CATCH_BY_DEN_COLOR"],
  },
  DEN_BLUE: {
    id: "DEN_BLUE",
    title: "Feed Run (Blauwe Den)",
    text: "Alle vossen met een blauwe Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_feed_run_blue.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "BLUE",
    tags: ["den_check", "catch_by_color", "CATCH_BY_DEN_COLOR"],
  },
  DEN_GREEN: {
    id: "DEN_GREEN",
    title: "Fence Patrol (Groene Den)",
    text: "Alle vossen met een groene Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_fence_patrol_green.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "GREEN",
    tags: ["den_check", "catch_by_color", "CATCH_BY_DEN_COLOR"],
  },
  DEN_YELLOW: {
    id: "DEN_YELLOW",
    title: "Barn Sweep (Gele Den)",
    text: "Alle vossen met een gele Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_barn_sweep_yellow.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "YELLOW",
    tags: ["den_check", "catch_by_color", "CATCH_BY_DEN_COLOR"],
  },

  // ---- Honden ----
  DOG_CHARGE: {
    id: "DOG_CHARGE",
    title: "Sheepdog Charge",
    text: "De herdershond rent door de Yard. Iedereen wordt geraakt, behalve vossen die BURROW hebben gespeeld of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_sheepdog_charge.png",
    imageBack: CARD_BACK,
    category: "DOG",
    tags: ["dog_attack", "burrow_protects", "CATCH_ALL_YARD"],
  },
  SHEEPDOG_PATROL: {
    id: "SHEEPDOG_PATROL",
    title: "Sheepdog Patrol",
    text: "Alle vossen die DASH kiezen deze ronde worden gepakt.",
    imageFront: "./assets/card_event_sheepdog_patrol.png",
    imageBack: CARD_BACK,
    category: "DOG",
    tags: ["dog_attack", "targets_dashers", "ignores_burrow", "CATCH_DASHERS"],
  },
  SECOND_CHARGE: {
    id: "SECOND_CHARGE",
    title: "Second Charge",
    text: "Gedraagt zich als een tweede Sheepdog Charge.",
    imageFront: "./assets/card_event_second_charge.png",
    imageBack: CARD_BACK,
    category: "DOG",
    tags: ["dog_attack", "second_strike", "CATCH_ALL_YARD"],
  },

  // ---- Rooster ----
  ROOSTER_CROW: {
    id: "ROOSTER_CROW",
    title: "Rooster Crow",
    text: "De haan kraait. Bij de derde Rooster Crow eindigt de raid; alleen Dashers scoren en verdelen de Sack.",
    imageFront: "./assets/card_event_rooster_crow.png",
    imageBack: CARD_BACK,
    category: "ROOSTER",
    crowIncrement: 1,
    tags: ["crow_tick", "raid_end_trigger", "ROOSTER_TICK"],
  },

  // ---- Variabel / Special ----
  MAGPIE_SNITCH: {
    id: "MAGPIE_SNITCH",
    title: "Magpie Snitch",
    text: "De ekster verraadt de Lead Fox. Tenzij hij BURROW heeft, wordt hij gepakt en verliest alle buit.",
    imageFront: "./assets/card_event_magpie_snitch.png",
    imageBack: CARD_BACK,
    category: "VARIABLE",
    tags: ["target_lead_fox", "lose_loot", "burrow_protects"],
  },
  PAINT_BOMB_NEST: {
    id: "PAINT_BOMB_NEST",
    title: "Paint-Bomb Nest",
    text: "Alle buit in de Sack gaat terug naar de Loot Deck en wordt geschud.",
    imageFront: "./assets/card_event_paint_bomb_nest.png",
    imageBack: CARD_BACK,
    category: "VARIABLE",
    tags: ["reset_sack", "shuffle_loot"],
  },
  HIDDEN_NEST: {
    id: "HIDDEN_NEST",
    title: "Hidden Nest",
    text: "Dash bonus afhankelijk van het aantal Dashers: 1 dasher→3 loot, 2 dashers→2 loot elk, 3 dashers→1 loot elk, 4+→niemand bonus.",
    imageFront: "./assets/card_event_hidden_nest.png",
    imageBack: CARD_BACK,
    category: "VARIABLE",
    tags: ["dash_reward", "multi_dasher_bonus"],
  },
  GATE_TOLL: {
    id: "GATE_TOLL",
    title: "Gate Toll",
    text: "Vossen in de Yard moeten 1 buit afgeven of worden gepakt bij het hek.",
    imageFront: "./assets/card_event_gate_toll.png",
    imageBack: CARD_BACK,
    category: "VARIABLE",
    tags: ["pay_loot_or_caught", "yard_only"],
  },
  BAD_MAP: {
    id: "BAD_MAP",
    title: "Bad Map",
    text: "Verwissel dit event met een willekeurig ongebruikt variabel event (huisregel / later digitaal).",
    imageFront: "./assets/card_event_bad_map.png",
    imageBack: CARD_BACK,
    category: "VARIABLE",
    tags: ["swap_event", "randomize"],
  },

  // ---- Conditions / Specials ----
  STORMY_NIGHT: {
    id: "STORMY_NIGHT",
    title: "Stormy Night",
    text: "Het waait en het is donker. De eerstvolgende Rooster Crow telt niet, maar Dog-events zijn extra gevaarlijk.",
    imageFront: "./assets/card_event_stormy_night.png",
    imageBack: CARD_BACK,
    category: "CONDITION",
    tags: ["ignore_first_crow", "boost_dogs"],
  },
  SILENT_ALARM: {
    id: "SILENT_ALARM",
    title: "Silent Alarm",
    text: "De boer merkt iets. De Lead Fox moet 2 buit afleggen of verliest zijn Lead-status.",
    imageFront: "./assets/card_event_silent_alarm.png",
    imageBack: CARD_BACK,
    category: "SPECIAL",
    tags: ["target_lead_fox", "lose_lead_or_loot"],
  },
  BARN_FIRE_DRILL: {
    id: "BARN_FIRE_DRILL",
    title: "Barn Fire Drill",
    text: "Paniek in de stal. De buit in de Sack wordt eerlijk verdeeld: iedereen krijgt 1 kaart tot de Sack leeg is.",
    imageFront: "./assets/card_event_barn_fire_drill.png",
    imageBack: CARD_BACK,
    category: "SPECIAL",
    tags: ["redistribute_sack", "fair_split"],
  },
};

// Helpers Events
export function getEventById(id) {
  return EVENT_DEFS[id] || null;
}
export function getEventsByCategory(category) {
  return Object.values(EVENT_DEFS).filter((e) => e.category === category);
}

// ======================
// ACTION CARDS
// ======================
// Keys in ACTION_DEFS zijn de “display names” (zoals in je UI/hand).
export const ACTION_DEFS = {
  "Scatter!": {
    id: "SCATTER",
    name: "Scatter!",
    imageFront: "./assets/card_action_scatter.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Tot het einde van deze ronde mag niemand de MOVE ‘SCOUT’ gebruiken.",
    tags: ["BLOCK_SCOUT", "ROUND_EFFECT"],
  },

  "Den Signal": {
    id: "DEN_SIGNAL",
    name: "Den Signal",
    imageFront: "./assets/card_action_den_signal.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "ACTIONS",
    timing: "before_event",
    description: "Kies een Den-kleur: vossen met die kleur zijn immuun voor vang-events uit de Event Track (deze ronde).",
    tags: ["DEN_IMMUNITY", "ROUND_EFFECT"],
  },

  "No-Go Zone": {
    id: "NO_GO_ZONE",
    name: "No-Go Zone",
    imageFront: "./assets/card_action_no_go_zone.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Kies 1 positie op de Event Track: die positie mag deze ronde niet gescout worden.",
    tags: ["BLOCK_SCOUT_POS", "ROUND_EFFECT"],
  },

  "Kick Up Dust": {
    id: "KICK_UP_DUST",
    name: "Kick Up Dust",
    imageFront: "./assets/card_action_kick_up_dust.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Twee (toekomstige) Event Cards wisselen willekeurig van plek. Werkt niet als events gelocked zijn.",
    tags: ["TRACK_MANIP", "SWAP_RANDOM", "BLOCKED_BY_LOCK"],
  },

  "Burrow Beacon": {
    id: "BURROW_BEACON",
    name: "Burrow Beacon",
    imageFront: "./assets/card_action_burrow_beacon.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Lock de Event Track: deze ronde kan de volgorde van Events niet meer veranderen.",
    tags: ["LOCK_EVENTS", "ROUND_EFFECT"],
  },

  "Molting Mask": {
    id: "MOLTING_MASK",
    name: "Molting Mask",
    imageFront: "./assets/card_action_molting_mask.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Je Den-kleur verandert naar een andere willekeurige kleur (niet je huidige).",
    tags: ["DEN_SWAP", "SELF_EFFECT"],
  },

  "Hold Still": {
    id: "HOLD_STILL",
    name: "Hold Still",
    imageFront: "./assets/card_action_hold_still.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Vanaf nu mogen deze ronde geen nieuwe Action Cards meer worden gespeeld; alleen PASS.",
    tags: ["LOCK_OPS", "ROUND_EFFECT"],
  },

  "Nose for Trouble": {
    id: "NOSE_FOR_TROUBLE",
    name: "Nose for Trouble",
    imageFront: "./assets/card_action_nose_for_trouble.png",
    imageBack: CARD_BACK,
    type: "INFO",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Je voorspelt welk Event als volgende wordt onthuld (wordt gelogd).",
    tags: ["PREDICT_EVENT", "INFO"],
  },

  "Scent Check": {
    id: "SCENT_CHECK",
    name: "Scent Check",
    imageFront: "./assets/card_action_scent_check.png",
    imageBack: CARD_BACK,
    type: "INFO",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Bekijk de actuele DECISION van 1 andere vos; later krijg je die info opnieuw als jij beslist.",
    tags: ["PEEK_DECISION", "INFO"],
  },

  "Follow the Tail": {
    id: "FOLLOW_THE_TAIL",
    name: "Follow the Tail",
    imageFront: "./assets/card_action_follow_tail.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Aan het einde van DECISION wordt jouw definitieve DECISION gelijk aan die van de gekozen vos.",
    tags: ["COPY_DECISION_LATER", "UTILITY"],
  },

  "Alpha Call": {
    id: "ALPHA_CALL",
    name: "Alpha Call",
    imageFront: "./assets/card_action_alpha_call.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Kies 1 vos als nieuwe Lead Fox.",
    tags: ["SET_LEAD", "UTILITY"],
  },

  "Pack Tinker": {
    id: "PACK_TINKER",
    name: "Pack Tinker",
    imageFront: "./assets/card_action_pack_tinker.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Kies 2 toekomstige posities op de Event Track en wissel die om (werkt niet bij lock).",
    tags: ["TRACK_MANIP", "SWAP_MANUAL", "BLOCKED_BY_LOCK"],
  },

  "Mask Swap": {
    id: "MASK_SWAP",
    name: "Mask Swap",
    imageFront: "./assets/card_action_mask_swap.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "ACTIONS",
    timing: "anytime",
    description: "Alle Den-kleuren van vossen in de Yard worden gehusseld en opnieuw uitgedeeld.",
    tags: ["SHUFFLE_DEN_COLORS", "ROUND_EFFECT"],
  },
};

// 1 bron voor “uitleg in hand modal”
export const ACTION_CARD_INFO = {
  "Scatter!": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: null,
    effect: "Tot het einde van deze ronde mag geen enkele vos de MOVE ‘SCOUT’ gebruiken.",
    note: "Sterk vóórdat anderen hun MOVE willen kiezen.",
  },
  "Den Signal": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies één Den-kleur: RED, BLUE, GREEN of YELLOW.",
    effect: "Alle vossen met die Den-kleur zijn deze ronde immuun voor vang-events vanuit de Event Track (bijv. Dog Charge).",
    note: "Geldt alleen deze ronde en alleen tegen Event-gedreven vangacties.",
  },
  "No-Go Zone": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies één positie op de Event Track (bijv. 3 voor het 3e event).",
    effect: "Die positie wordt een No-Go Zone: niemand mag daar deze ronde op SCOUTen.",
    note: "Het event blijft liggen; alleen SCOUT-moves naar die positie zijn verboden.",
  },
  "Kick Up Dust": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Geen keuze nodig; het spel kiest willekeurig twee toekomstige Event-posities.",
    effect: "Twee (toekomstige) Event Cards op de Event Track wisselen willekeurig van plek.",
    note: "Werkt niet als Burrow Beacon (Event Track gelocked) al actief is.",
  },
  "Burrow Beacon": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: null,
    effect: "De Event Track wordt gelocked: deze ronde kan de volgorde van Events niet meer veranderen.",
    note: "Blokkeert o.a. SHIFT, Kick Up Dust en Pack Tinker voor de rest van de ronde.",
  },
  "Molting Mask": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: null,
    effect: "Verander jouw Den-kleur in een andere willekeurige kleur (RED / BLUE / GREEN / YELLOW), anders dan je huidige.",
    note: "Vanaf nu val je onder de Den-events en Dog-/Sheepdog-effects van je nieuwe kleur.",
  },
  "Hold Still": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: null,
    effect: "Vanaf nu mogen deze ronde geen nieuwe Action Cards meer worden gespeeld; spelers mogen alleen nog PASS kiezen in de ACTIONS-fase.",
    note: "Gebruik dit om de OPS-chaos te stoppen en te ‘freezen’.",
  },
  "Nose for Trouble": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies één Event uit de lijst waarvan jij denkt dat het als volgende wordt onthuld.",
    effect: "Je voorspelt welk Event als volgende uitkomt. De voorspelling wordt gelogd in deze ronde.",
    note: "Beloning/straffen horen bij jullie (huis)regels.",
  },
  "Scent Check": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies één andere vos die nog in de Yard zit.",
    effect: "Je ziet direct de huidige DECISION van die vos. Later, zodra jij jouw DECISION kiest, krijg je opnieuw een pop-up met hun actuele keuze.",
    note: "Je kopieert hun keuze niet; je krijgt alleen info.",
  },
  "Follow the Tail": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies één andere vos die nog in de Yard zit.",
    effect: "Aan het einde van de DECISION-fase wordt jouw definitieve DECISION automatisch gelijk aan die van de gekozen vos.",
    note: "Jij mag nog kiezen, maar bij reveal telt uiteindelijk de keuze van je ‘staart-leider’.",
  },
  "Alpha Call": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies één vos als nieuwe Lead Fox.",
    effect: "De gekozen vos wordt de nieuwe Lead Fox.",
    note: "De speciale rechten van de Lead Fox staan in de spelregels.",
  },
  "Pack Tinker": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Kies twee toekomstige posities op de Event Track om te wisselen.",
    effect: "De Event Cards op die twee posities wisselen van plek.",
    note: "Werkt niet als Burrow Beacon al actief is (Event Track gelocked).",
  },
  "Mask Swap": {
    moment: "ACTIONS-fase (jouw beurt).",
    choice: "Geen keuze nodig; alle vossen die nog in de Yard zitten doen automatisch mee.",
    effect: "Alle Den-kleuren van vossen in de Yard worden gehusseld en opnieuw uitgedeeld.",
    note: "Je weet niet welke kleur je terugkrijgt. Vang-events kunnen hierdoor plots anders uitpakken.",
  },
};

// ======================
// ACTION LOOKUP (alias-proof)
// ======================

// Aliassen zodat hand-waarden als "SCENT_CHECK" of "ACTION_SCENT_CHECK" ook werken.
const ACTION_ALIASES = {
  // id -> name
  SCATTER: "Scatter!",
  ACTION_SCATTER: "Scatter!",
  DEN_SIGNAL: "Den Signal",
  ACTION_DEN_SIGNAL: "Den Signal",
  NO_GO_ZONE: "No-Go Zone",
  ACTION_NO_GO_ZONE: "No-Go Zone",
  KICK_UP_DUST: "Kick Up Dust",
  ACTION_KICK_UP_DUST: "Kick Up Dust",
  BURROW_BEACON: "Burrow Beacon",
  ACTION_BURROW_BEACON: "Burrow Beacon",
  MOLTING_MASK: "Molting Mask",
  ACTION_MOLTING_MASK: "Molting Mask",
  HOLD_STILL: "Hold Still",
  ACTION_HOLD_STILL: "Hold Still",
  NOSE_FOR_TROUBLE: "Nose for Trouble",
  ACTION_NOSE_FOR_TROUBLE: "Nose for Trouble",
  SCENT_CHECK: "Scent Check",
  ACTION_SCENT_CHECK: "Scent Check",
  FOLLOW_THE_TAIL: "Follow the Tail",
  ACTION_FOLLOW_THE_TAIL: "Follow the Tail",
  ALPHA_CALL: "Alpha Call",
  ACTION_ALPHA_CALL: "Alpha Call",
  PACK_TINKER: "Pack Tinker",
  ACTION_PACK_TINKER: "Pack Tinker",
  MASK_SWAP: "Mask Swap",
  ACTION_MASK_SWAP: "Mask Swap",
};

function normalizeActionKey(x) {
  if (!x) return "";
  const s = String(x).trim();
  return ACTION_ALIASES[s] || s;
}

// Hand kan string zijn of object
function actionNameFromAny(v) {
  if (!v) return "";
  if (typeof v === "string") return normalizeActionKey(v);
  return normalizeActionKey(v.name || v.id || v.cardId || "");
}

export function getActionDefByName(nameOrId) {
  const key = actionNameFromAny(nameOrId);
  const def = ACTION_DEFS[key] || null;
  if (!def) return null;

  // Safety: als imageFront ontbreekt, nooit crashen; terugvallen naar CARD_BACK
  const imageFront = def.imageFront || def.fallbackFront || CARD_BACK;
  return { ...def, imageFront };
}

export function getActionInfoByName(nameOrId) {
  const key = actionNameFromAny(nameOrId);
  return ACTION_CARD_INFO[key] || null;
}

export function getActionIdByName(nameOrId) {
  const def = getActionDefByName(nameOrId);
  return def?.id || null;
}

export function getActionsByType(type) {
  return Object.values(ACTION_DEFS).filter((a) => a.type === type);
}

// ======================
// LOOT CARDS
// ======================
// Jouw regels: Egg=1, Hen=2, Prize Hen=3
export const LOOT_DEFS = {
  Egg: {
    type: "Egg",
    label: "Egg",
    image: "./assets/card_loot_egg.png",
    value: 1,
    tags: ["common"],
  },
  Hen: {
    type: "Hen",
    label: "Hen",
    image: "./assets/card_loot_hen.png",
    value: 2,
    tags: ["medium"],
  },
  "Prize Hen": {
    type: "Prize Hen",
    label: "Prize Hen",
    image: "./assets/card_loot_prize_hen.png",
    value: 3,
    tags: ["rare"],
  },
};

export function getLootDef(type) {
  if (LOOT_DEFS[type]) return LOOT_DEFS[type];
  return {
    type,
    label: String(type),
    image: CARD_BACK,
    value: 0,
    tags: ["unknown"],
  };
}

export const LOOT_IMAGES = {
  Egg: LOOT_DEFS.Egg.image,
  Hen: LOOT_DEFS.Hen.image,
  "Prize Hen": LOOT_DEFS["Prize Hen"].image,
};

export function getLootImageForType(type) {
  const def = getLootDef(type);
  return def.image || CARD_BACK;
}

// ======================
// PLAYER PROFILE CARDS
// ======================
export const PLAYER_PROFILE_DEFS = {
  SCOUT: {
    id: "SCOUT",
    title: "Scout Fox",
    text: "Mag elke raid 1 Event Card vooraf bekijken.",
    passiveAbility: "peek_event_top",
    imageFront: "./assets/card_player_scout.png",
    imageBack: CARD_BACK,
    tags: ["info", "pre_view"],
  },
  MUSCLE: {
    id: "MUSCLE",
    title: "Muscle Fox",
    text: "Krijgt +1 loot wanneer hij succesvol ontsnapt met DASH (huisregel / later digitaal).",
    passiveAbility: "extra_loot_on_dash",
    imageFront: "./assets/card_player_muscle.png",
    imageBack: CARD_BACK,
    tags: ["extra_loot", "dash_bonus"],
  },
  TRICKSTER: {
    id: "TRICKSTER",
    title: "Trickster Fox",
    text: "Mag 1x per raid een gespeelde Action Card van iemand anders kopiëren (huisregel / later digitaal).",
    passiveAbility: "copy_action_once",
    imageFront: "./assets/card_player_trickster.png",
    imageBack: CARD_BACK,
    tags: ["copy_action", "once_per_raid"],
  },
};

export function getPlayerProfileById(id) {
  return PLAYER_PROFILE_DEFS[id] || null;
}

// ======================
// SPECIAL ACTIVITY CARDS
// ======================
export const ACTIVITY_DEFS = {
  CAMPFIRE_STORY: {
    id: "CAMPFIRE_STORY",
    title: "Campfire Story",
    text: "Na de raid vertelt iedereen kort zijn verhaal. Groep stemt; winnaar krijgt +2 loot (huisregel / later digitaal).",
    imageFront: "./assets/card_activity_campfire_story.png",
    imageBack: CARD_BACK,
    phase: "post_raid",
    tags: ["story", "vote", "bonus_loot"],
  },
  TRAINING_DRILL: {
    id: "TRAINING_DRILL",
    title: "Training Drill",
    text: "Voor de volgende raid krijgt elke vos 1 extra Action Card.",
    imageFront: "./assets/card_activity_training_drill.png",
    imageBack: CARD_BACK,
    phase: "pre_raid",
    tags: ["extra_action", "next_raid"],
  },
  NIGHT_RECON: {
    id: "NIGHT_RECON",
    title: "Night Recon",
    text: "De host mag 2 Event Cards bekijken en in gewenste volgorde terugleggen (huisregel / later digitaal).",
    imageFront: "./assets/card_activity_night_recon.png",
    imageBack: CARD_BACK,
    phase: "pre_raid",
    tags: ["peek_event", "reorder_event_deck"],
  },
};

export function getActivityById(id) {
  return ACTIVITY_DEFS[id] || null;
}
