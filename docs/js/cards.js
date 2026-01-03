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
// Doel:
// - 1 bron van waarheid voor UI + Advisor + Engine
// - vaste velden: id, name, type, phase, timing, tags, description, choice, effect, note
// - robuuste lookup: werkt met "Molting Mask", "MOLTING_MASK", "molting-mask", etc.
//
// EXTRA VELDEN:
// - type: "INFO" | "DEFENSE" | "MOVEMENT" | "TRICK" | "UTILITY"
// - phase: "OPS" | "MOVE" | "DECISION" | "ANY"  (wanneer speelbaar)
// - timing: "before_event" | "after_event" | "anytime"
// - tags: labels voor bot/engine logica
// - choice/effect/note: UI uitleg (komt uit jouw ACTION_CARD_INFO)

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "") // verwijder punctuatie, houdt spaties
    .replace(/\s+/g, " ")
    .trim();
}

function makeIdFromName(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// UI-uitleg (jouw object uit player.js) — NU centraal in cards.js
export const ACTION_CARD_INFO = {
  "Scatter!": {
    choice: null,
    effect:
      "Tot het einde van deze ronde mag geen enkele vos de MOVE ‘SCOUT’ gebruiken.",
    note: "Gebruik deze kaart bij voorkeur voordat andere vossen hun MOVE kiezen.",
  },
  "Den Signal": {
    choice: "Kies één Den-kleur: RED, BLUE, GREEN of YELLOW.",
    effect:
      "Alle vossen met die Den-kleur zijn deze ronde immuun voor vang-events vanuit de Event Track (bijv. Dog Charge).",
    note:
      "Geldt alleen voor deze ronde en alleen tegen Event-gedreven vangacties.",
  },
  "No-Go Zone": {
    choice: "Kies één positie op de Event Track (bijv. 3 voor het 3e event).",
    effect:
      "Die positie wordt een No-Go Zone: niemand mag daar deze ronde op SCOUTen.",
    note:
      "Het event blijft liggen; alleen SCOUT-moves naar die positie zijn verboden.",
  },
  "Kick Up Dust": {
    choice: "Geen keuze nodig; het spel kiest willekeurig twee Event-posities.",
    effect: "Twee Event Cards op de Event Track wisselen willekeurig van plek.",
    note: "Werkt niet als Burrow Beacon (Event Track gelocked) al actief is.",
  },
  "Burrow Beacon": {
    choice: null,
    effect:
      "De Event Track wordt gelocked: deze ronde kan de volgorde van Events niet meer veranderen.",
    note:
      "Blokkeert o.a. SHIFT, Kick Up Dust en Pack Tinker voor de rest van de ronde.",
  },
  "Molting Mask": {
    choice: null,
    effect:
      "Verander jouw Den-kleur in een andere willekeurige kleur (RED / BLUE / GREEN / YELLOW), anders dan je huidige.",
    note:
      "Vanaf nu val je onder de Den-events en Dog-/Sheepdog-effects van je nieuwe kleur, niet meer van je oude.",
  },
  "Hold Still": {
    choice: null,
    effect:
      "Vanaf nu mogen deze ronde geen nieuwe Action Cards meer worden gespeeld; spelers mogen alleen nog PASS kiezen in de OPS-fase.",
    note:
      "Gebruik deze kaart als je de OPS-chaos wilt stoppen en de situatie wilt bevriezen.",
  },
  "Nose for Trouble": {
    choice:
      "Kies één Event uit de lijst waarvan jij denkt dat het als volgende wordt onthuld.",
    effect:
      "Je voorspelt welk Event als volgende uitkomt. De voorspelling wordt gelogd in deze ronde.",
    note:
      "Beloning/straffen voor juiste of foute voorspellingen horen bij de uitgebreide (fysieke) spelregels of jullie huisregels.",
  },
  "Scent Check": {
    choice: "Kies één andere vos die nog in de Yard zit.",
    effect:
      "Je ziet direct de huidige DECISION van die vos (LURK/BURROW/DASH of nog geen keuze). Later, zodra jij jouw DECISION kiest, krijg je opnieuw een pop-up met hun actuele keuze.",
    note:
      "Je kopieert hun keuze niet; je krijgt alleen extra informatie over hun gedrag.",
  },
  "Follow the Tail": {
    choice: "Kies één andere vos die nog in de Yard zit.",
    effect:
      "Aan het einde van de DECISION-fase wordt jouw definitieve DECISION automatisch gelijk aan die van de gekozen vos.",
    note:
      "Je mag zelf een DECISION kiezen, maar bij de reveal telt uiteindelijk wat jouw ‘staart-leider’ gekozen heeft.",
  },
  "Alpha Call": {
    choice: "Kies één vos als nieuwe Lead Fox.",
    effect:
      "De gekozen vos wordt de nieuwe Lead Fox (neonkaart, rol in de raid volgens jullie spelvariant).",
    note:
      "De exacte speciale rechten van de Lead Fox staan verder uitgewerkt in de spelregels.",
  },
  "Pack Tinker": {
    choice:
      "Kies twee posities op de Event Track (bijv. posities 2 en 5) om te wisselen.",
    effect: "De Event Cards op die twee posities wisselen van plek.",
    note:
      "Werkt niet als Burrow Beacon al actief is (Event Track gelocked).",
  },
  "Mask Swap": {
    choice:
      "Geen keuze nodig; alle vossen die nog in de Yard zitten doen automatisch mee.",
    effect:
      "Alle Den-kleuren van vossen in de Yard worden gehusseld en opnieuw uitgedeeld.",
    note:
      "Je weet niet welke kleur je terugkrijgt. Vang-events kunnen hierdoor plots heel anders uitpakken.",
  },
};

// Centrale Action Card defs (metadata + tags)
// Let op: phase = wanneer speelbaar. Jij zei: OPS fase = action cards om de beurt.
// Dus default: phase:"OPS" (tenzij je bewust iets anders wil).
export const ACTION_DEFS = {
  "Molting Mask": {
    id: "MOLTING_MASK",
    name: "Molting Mask",
    imageFront: "./assets/card_action_molting_mask.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "before_event",
    tags: ["swap_den", "den_trick"],
    description: "Verander jouw Den-kleur (willekeurig).",
  },

  "Scent Check": {
    id: "SCENT_CHECK",
    name: "Scent Check",
    imageFront: "./assets/card_action_scent_check.png",
    imageBack: CARD_BACK,
    type: "INFO",
    phase: "OPS",
    timing: "before_event",
    tags: ["peek", "info", "peek_decision"],
    description: "Bekijk de decision van een andere speler (info voordeel).",
  },

  "Follow the Tail": {
    id: "FOLLOW_THE_TAIL",
    name: "Follow the Tail",
    imageFront: "./assets/card_action_follow_tail.png",
    imageBack: CARD_BACK,
    type: "MOVEMENT",
    phase: "OPS",
    timing: "before_event",
    tags: ["copy_decision_later"],
    description: "Jouw decision wordt later gelijk aan die van een gekozen speler.",
  },

  "Scatter!": {
    id: "SCATTER",
    name: "Scatter!",
    imageFront: "./assets/card_action_scatter.png",
    fallbackFront: "./assets/card_scatter.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "before_event",
    tags: ["block_scout_move", "events_freeze"],
    description: "Blokkeert SCOUT move voor de rest van de ronde.",
  },

  "Den Signal": {
    id: "DEN_SIGNAL",
    name: "Den Signal",
    imageFront: "./assets/card_action_den_signal.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "OPS",
    timing: "before_event",
    tags: ["protect_den", "group_defense"],
    description: "Bescherming voor vossen in een gekozen Den-kleur.",
  },

  "Alpha Call": {
    id: "ALPHA_CALL",
    name: "Alpha Call",
    imageFront: "./assets/card_action_alpha_call.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    phase: "OPS",
    timing: "before_event",
    tags: ["lead_control"],
    description: "Wijs een nieuwe Lead Fox aan.",
  },

  "No-Go Zone": {
    id: "NO_GO_ZONE",
    name: "No-Go Zone",
    imageFront: "./assets/card_action_no_go_zone.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "before_event",
    tags: ["block_scout_position", "zone_control"],
    description: "Kies een Event Track positie waar niet gescout mag worden.",
  },

  "Countermove": {
    id: "COUNTERMOVE",
    name: "Countermove",
    imageFront: "./assets/card_action_countermove.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "OPS",
    timing: "after_event",
    tags: ["counter", "reaction"],
    description: "Reageer om een effect om te buigen.",
  },

  "Hold Still": {
    id: "HOLD_STILL",
    name: "Hold Still",
    imageFront: "./assets/card_action_hold_still.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "OPS",
    timing: "before_event",
    tags: ["block_actions"],
    description: "Vanaf nu: alleen PASS in OPS deze ronde.",
  },

  "Kick Up Dust": {
    id: "KICK_UP_DUST",
    name: "Kick Up Dust",
    imageFront: "./assets/card_action_kick_up_dust.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "before_event",
    tags: ["swap_events_random", "track_manip"],
    description: "Wissel willekeurig twee Event Track posities.",
  },

  "Pack Tinker": {
    id: "PACK_TINKER",
    name: "Pack Tinker",
    imageFront: "./assets/card_action_pack_tinker.png",
    imageBack: CARD_BACK,
    type: "UTILITY",
    phase: "OPS",
    timing: "anytime",
    tags: ["swap_events_chosen", "track_manip"],
    description: "Wissel twee gekozen Event Track posities.",
  },

  "Mask Swap": {
    id: "MASK_SWAP",
    name: "Mask Swap",
    imageFront: "./assets/card_action_mask_swap.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "before_event",
    tags: ["shuffle_den_yard"],
    description: "Hussel Den-kleuren van alle vossen in de Yard.",
  },

  "Nose for Trouble": {
    id: "NOSE_FOR_TROUBLE",
    name: "Nose for Trouble",
    imageFront: "./assets/card_action_nose_for_trouble.png",
    imageBack: CARD_BACK,
    type: "INFO",
    phase: "OPS",
    timing: "before_event",
    tags: ["peek_event", "warn"],
    description: "Voorspel het volgende Event (intel/psychologische druk).",
  },

  "Burrow Beacon": {
    id: "BURROW_BEACON",
    name: "Burrow Beacon",
    imageFront: "./assets/card_action_burrow_beacon.png",
    fallbackFront: "./assets/card_beacon.png",
    imageBack: CARD_BACK,
    type: "DEFENSE",
    phase: "OPS",
    timing: "before_event",
    tags: ["lock_events"],
    description: "Lock de Event Track: geen swaps/shifts meer deze ronde.",
  },

  // ---- Nieuwe kaarten (optioneel; laat staan als je ze echt gebruikt) ----
  "Shadow Step": {
    id: "SHADOW_STEP",
    name: "Shadow Step",
    imageFront: "./assets/card_action_shadow_step.png",
    imageBack: CARD_BACK,
    type: "MOVEMENT",
    phase: "OPS",
    timing: "before_event",
    tags: ["escape", "no_loot_this_round"],
    description: "Ga veilig naar Den, maar je pakt geen loot deze ronde.",
  },

  "Decoy Trail": {
    id: "DECOY_TRAIL",
    name: "Decoy Trail",
    imageFront: "./assets/card_action_decoy_trail.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "before_event",
    tags: ["redirect_danger", "target_player"],
    description: "Leid gevaar om naar een andere speler (tijdelijk).",
  },

  "False Alarm": {
    id: "FALSE_ALARM",
    name: "False Alarm",
    imageFront: "./assets/card_action_false_alarm.png",
    imageBack: CARD_BACK,
    type: "TRICK",
    phase: "OPS",
    timing: "after_event",
    tags: ["cancel_event", "redraw"],
    description: "Negeer huidig Event en trek een nieuwe (huisregels).",
  },
};

// ------------- helpers -------------
const ACTION_INDEX = (() => {
  const map = new Map();
  for (const [key, def] of Object.entries(ACTION_DEFS)) {
    map.set(normalizeKey(key), def);
    if (def?.name) map.set(normalizeKey(def.name), def);
    if (def?.id) map.set(normalizeKey(def.id), def);
    map.set(normalizeKey(makeIdFromName(def.name)), def);
  }
  return map;
})();

export function getActionDefByName(nameOrId) {
  const key = normalizeKey(nameOrId);
  if (!key) return null;

  const def = ACTION_INDEX.get(key) || null;
  if (!def) return null;

  if (!def.imageFront && def.fallbackFront) {
    return { ...def, imageFront: def.fallbackFront };
  }
  return def;
}

export function getActionInfoByName(nameOrId) {
  const def = getActionDefByName(nameOrId);
  if (!def) return null;
  return ACTION_CARD_INFO[def.name] || null;
}

// Optioneel: alle actions van een bepaald type
export function getActionsByType(type) {
  return Object.values(ACTION_DEFS).filter((a) => a.type === type);
}

// Optioneel: alle actions die speelbaar zijn in een fase
export function getActionsByPhase(phase) {
  const p = String(phase || "").toUpperCase();
  return Object.values(ACTION_DEFS).filter((a) => (a.phase || "ANY") === "ANY" || a.phase === p);
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
