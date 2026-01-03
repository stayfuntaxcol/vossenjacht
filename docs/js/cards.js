// cards.js
// Centrale definities van alle kaarten in Vossenjacht:
// - EVENT_DEFS: Event-kaarten (incl. meta-informatie voor de engine)
// - ACTION_DEFS: Actiekaarten (type, timing, tags)
// - LOOT_DEFS: buit-kaarten met waarde
// - PLAYER_PROFILE_DEFS: rol-/profielkaarten per speler
// - ACTIVITY_DEFS: speciale activiteiten tussen raids
// Bevat GEEN DOM-code, alleen data + helpers.

// Achterkant voor alle kaarten
const CARD_BACK = "./assets/card_vossenjacht.png";

// ======================
// EVENT CARDS
// ======================
//
// EXTRA VELDEN:
// - category: "DEN" | "DOG" | "ROOSTER" | "VARIABLE" | "CONDITION" | "SPECIAL"
// - denColor: "RED" | "BLUE" | "GREEN" | "YELLOW" (alleen bij DEN-events)
// - crowIncrement: aantal Rooster-tikken (alleen bij ROOSTER_CROW)
// - tags: vrije lijst met labels voor engine-logica

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
    tags: ["den_check", "catch_by_color"],
  },
  DEN_BLUE: {
    id: "DEN_BLUE",
    title: "Feed Run (Blauwe Den)",
    text: "Alle vossen met een blauwe Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_feed_run_blue.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "BLUE",
    tags: ["den_check", "catch_by_color"],
  },
  DEN_GREEN: {
    id: "DEN_GREEN",
    title: "Fence Patrol (Groene Den)",
    text: "Alle vossen met een groene Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_fence_patrol_green.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "GREEN",
    tags: ["den_check", "catch_by_color"],
  },
  DEN_YELLOW: {
    id: "DEN_YELLOW",
    title: "Barn Sweep (Gele Den)",
    text: "Alle vossen met een gele Den worden gepakt, tenzij ze BURROW of DASH hebben, of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_barn_sweep_yellow.png",
    imageBack: CARD_BACK,
    category: "DEN",
    denColor: "YELLOW",
    tags: ["den_check", "catch_by_color"],
  },

  // ---- Honden / drukte ----
  DOG_CHARGE: {
    id: "DOG_CHARGE",
    title: "Sheepdog Charge",
    text: "De herdershond rent door de Yard. Iedereen wordt geraakt, behalve vossen die BURROW hebben gespeeld of beschermd zijn door Den Signal.",
    imageFront: "./assets/card_event_sheepdog_charge.png",
    imageBack: CARD_BACK,
    category: "DOG",
    tags: ["dog_attack", "burrow_protects"],
  },
  SHEEPDOG_PATROL: {
    id: "SHEEPDOG_PATROL",
    title: "Sheepdog Patrol",
    text: "Dashers worden gepakt; BURROW helpt niet. (Digitale effecten volgen Egg Run-regels; nog niet volledig geïmplementeerd).",
    imageFront: "./assets/card_event_sheepdog_patrol.png",
    imageBack: CARD_BACK,
    category: "DOG",
    tags: ["dog_attack", "targets_dashers", "ignores_burrow", "ignores_yard"],
  },
  SECOND_CHARGE: {
    id: "SECOND_CHARGE",
    title: "Second Charge",
    text: "Gedraagt zich als een tweede Sheepdog Charge. (Regels volgen Egg Run; effect kan later verder worden verfijnd.)",
    imageFront: "./assets/card_event_second_charge.png",
    imageBack: CARD_BACK,
    category: "DOG",
    tags: ["dog_attack", "second_strike"],
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
    tags: ["crow_tick", "raid_end_trigger"],
  },

  // ---- Speciale variabele events ----
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
    text: "Als 1 vos DASH kiest krijgt hij 3 buitkaarten; bij 2 dashers krijgen beide 2 buitkaarten; bij 3 dashers krijgen alle drie 1 buitkaart. Bij 4 of meer dashers krijgt niemand extra buit.",
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
    text: "Verwissel dit event met een willekeurig ongebruikt variabel event. (Digitale variant kan later worden uitgewerkt.)",
    imageFront: "./assets/card_event_bad_map.png",
    imageBack: CARD_BACK,
    category: "VARIABLE",
    tags: ["swap_event", "randomize"],
  },

  // ---- Nieuwe condition events ----
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

// Helpers voor Events
export function getEventById(id) {
  return EVENT_DEFS[id] || null;
}

export function getEventsByCategory(category) {
  return Object.values(EVENT_DEFS).filter((e) => e.category === category);
}

// ======================
// ACTION CARDS
// ======================
//
// EXTRA VELDEN:
// - type: "INFO" | "DEFENSE" | "MOVEMENT" | "TRICK" | "UTILITY"
// - timing: "before_event" | "after_event" | "anytime"
// - description: korte uitleg voor UI
// - tags: labels voor engine-logica

export const ACTION_DEFS = {
  "Molting Mask": {
    name: "Molting Mask",
    imageFront: "./assets/card_action_molting_mask.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    timing: "before_event",
    description: "Wissel van Den-kleur met een andere vos of verberg tijdelijk je Den.",
    tags: ["swap_den", "den_trick"],
  },
  "Scent Check": {
    name: "Scent Check",
    imageFront: "./assets/card_action_scent_check.png",
    imageBack: CARD_BACK,
    type: "INFO",
    timing: "before_event",
    description: "Bekijk de decision van een speler naar keuze, voordat jij jouw decision maakt.",
    tags: ["peek", "info"],
  },
  "Follow the Tail": {
    name: "Follow the Tail",
    imageFront: "./assets/card_action_follow_tail.png",
    imageBack: CARD_BACK,
    type: "MOVEMENT",
    timing: "before_event",
    description: "Beweeg mee met een speler naar keuze en volg automatisch zijn/haar decision.",
    tags: ["move_with_lead"],
  },
  "Scatter!": {
    name: "Scatter!",
    imageFront: "./assets/card_action_scatter.png",
    fallbackFront: "./assets/card_scatter.png",
    imageBack: CARD_BACK,
    type: "MOVEMENT",
    timing: "before_event",
    description: "Event Cards mogen deze ronde niet meer verwisseld worden.",
    tags: ["escape", "events_freeze"],
  },
  "Den Signal": {
    name: "Den Signal",
    imageFront: "./assets/card_action_den_signal.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    timing: "before_event",
    description: "Geeft bescherming aan vossen in dezelfde Den tegen bepaalde events.",
    tags: ["protect_den", "group_defense"],
  },
  "Alpha Call": {
    name: "Alpha Call",
    imageFront: "./assets/card_action_alpha_call.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    timing: "before_event",
    description: "Wijs een nieuwe Lead Fox aan. Dit heeft direct invloed op het spel.",
    tags: ["lead_control", "reorder"],
  },
  "No-Go Zone": {
    name: "No-Go Zone",
    imageFront: "./assets/card_action_no_go_zone.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    timing: "before_event",
    description: "Markeer een Event Card die deze ronde niet verwisseld mag worden.",
    tags: ["event_control"],
  },
  "Countermove": {
    name: "Countermove",
    imageFront: "./assets/card_action_countermove.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    timing: "after_event",
    description: "Reageer op een Event of Action om het effect om te buigen.",
    tags: ["counter", "reaction"],
  },
  "Hold Still": {
    name: "Hold Still",
    imageFront: "./assets/card_action_hold_still.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    timing: "before_event",
    description: "Er mogen deze ronde geen Actions Cards meer gespeeld worden.",
    tags: ["block_actions", "stay_put"],
  },
  "Kick Up Dust": {
    name: "Kick Up Dust",
    imageFront: "./assets/card_action_kick_up_dust.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    timing: "before_event",
    description: "Twee verborgen Event Cards worden willekeurig omgewisseld.",
    tags: ["obscure", "confuse"],
  },
  "Pack Tinker": {
    name: "Pack Tinker",
    imageFront: "./assets/card_action_pack_tinker.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    timing: "anytime",
    description: "Verwissel twee verborgen event kaarten met elkaar.",
    tags: ["swap_events", "rearrange"],
  },
  "Mask Swap": {
    name: "Mask Swap",
    imageFront: "./assets/card_action_mask_swap.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    timing: "before_event",
    description: "Wissel identiteit met een andere vos.",
    tags: ["swap_identity"],
  },
  "Nose for Trouble": {
    name: "Nose for Trouble",
    imageFront: "./assets/card_action_nose_for_trouble.png",
    imageBack: CARD_BACK,
    type: "INFO",
    timing: "before_event",
    description: "Ruik gevaar en kijk vooruit in de Event Rack.",
    tags: ["peek_event", "warn"],
  },
  "Burrow Beacon": {
    name: "Burrow Beacon",
    // je hebt al card_beacon.png
    imageFront: "./assets/card_action_burrow_beacon.png",
    fallbackFront: "./assets/card_beacon.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    timing: "before_event",
    description: "Event Cards mogen deze ronde niet meer bekeken worden.",
    tags: ["blind_events", "dark_night"],
  },

  // ---- Nieuwe actiekaarten ----
  "Shadow Step": {
    name: "Shadow Step",
    imageFront: "./assets/card_action_shadow_step.png",
    imageBack: CARD_BACK,
    type: "MOVEMENT",
    timing: "before_event",
    description: "Verplaats jezelf van Yard naar Den zonder door honden geraakt te worden, maar je kunt deze ronde geen buit pakken.",
    tags: ["escape", "no_loot_this_round"],
  },
  "Decoy Trail": {
    name: "Decoy Trail",
    imageFront: "./assets/card_action_decoy_trail.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    timing: "before_event",
    description: "Leid de honden om: behandel een andere speler als Lead Fox voor dit Event.",
    tags: ["redirect_danger", "target_player"],
  },
  "False Alarm": {
    name: "False Alarm",
    imageFront: "./assets/card_action_false_alarm.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    timing: "after_event",
    description: "Negeer het huidige Event en trek een nieuwe (volgens de tafelregels).",
    tags: ["cancel_event", "redraw"],
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

// Optioneel: alle actions van een bepaald type
export function getActionsByType(type) {
  return Object.values(ACTION_DEFS).filter((a) => a.type === type);
}

// ======================
// LOOT CARDS
// ======================
//
// EXTRA VELDEN:
// - value: puntenwaarde
// - label: titel voor UI
// - tags: b.v. ["rare"]

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
    value: 3,
    tags: ["medium"],
  },
  "Prize Hen": {
    type: "Prize Hen",
    label: "Prize Hen",
    image: "./assets/card_loot_prizehen.png",
    value: 5,
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

// Backwards compatible mapping van type -> image
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
//
// Rol-/profielkaarten met passieve abilities over meerdere raids.

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
    text: "Krijgt +1 buit wanneer hij succesvol ontsnapt met DASH.",
    passiveAbility: "extra_loot_on_dash",
    imageFront: "./assets/card_player_muscle.png",
    imageBack: CARD_BACK,
    tags: ["extra_loot", "dash_bonus"],
  },
  TRICKSTER: {
    id: "TRICKSTER",
    title: "Trickster Fox",
    text: "Mag 1x per raid een gespeelde Action Card van iemand anders kopiëren.",
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
//
// Kaarten voor tussen de raids (meta-activiteiten).
// - phase: "pre_raid" | "post_raid" | "meta"

export const ACTIVITY_DEFS = {
  CAMPFIRE_STORY: {
    id: "CAMPFIRE_STORY",
    title: "Campfire Story",
    text: "Na de raid vertelt iedereen kort zijn verhaal. De groep stemt op de beste story; die speler krijgt +2 loot.",
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
    text: "De host mag 2 Event Cards uit de stapel bekijken en in gewenste volgorde terugleggen.",
    imageFront: "./assets/card_activity_night_recon.png",
    imageBack: CARD_BACK,
    phase: "pre_raid",
    tags: ["peek_event", "reorder_event_deck"],
  },
};

export function getActivityById(id) {
  return ACTIVITY_DEFS[id] || null;
}

// ======================
// Exports
// ======================

export { CARD_BACK };
