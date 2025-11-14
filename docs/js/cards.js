// cards.js
// Alle Event Cards voor Vossenjacht, gebaseerd op EggRun.
// We hebben 10 unieke events. De Event Track gebruikt sommige meerdere keren
// (bijv. 3x Rooster Crow). De type-velden gebruiken we later in de engine.

export const EVENTS = [
  // 4x Den events (kleur-afhankelijke checks)
  {
    id: "DEN_RED",
    type: "DEN",
    denColor: "RED",
    title: "Rode Den-controle",
    text: "De boer controleert de rode kant van het erf. Vossen met een rode Den liggen extra onder vuur.",
  },
  {
    id: "DEN_BLUE",
    type: "DEN",
    denColor: "BLUE",
    title: "Blauwe Den-controle",
    text: "De boer struint langs de blauwe afrastering. Vossen uit de blauwe Den moeten oppassen.",
  },
  {
    id: "DEN_GREEN",
    type: "DEN",
    denColor: "GREEN",
    title: "Groene Den-controle",
    text: "De boer loopt langs de groene heg. Vossen uit de groene Den houden hun adem in.",
  },
  {
    id: "DEN_YELLOW",
    type: "DEN",
    denColor: "YELLOW",
    title: "Gele Den-controle",
    text: "De boer kijkt rond bij de gele opslag en schuur. Vossen uit de gele Den zitten in de gevarenzone.",
  },

  // Sheepdog Charge
  {
    id: "DOG_CHARGE",
    type: "DOG",
    title: "Herderhond-aanval",
    text: "De herderhond ruikt onraad en stormt het erf op. Wie niet op tijd wegduikt, wordt omver gelopen.",
  },

  // Rooster Crow (3 kopieën in de track, 1 beschrijving)
  {
    id: "ROOSTER_CROW",
    type: "ROOSTER",
    title: "Rooster Crow",
    text: "De haan kraait luid. De nacht loopt op zijn einde en de tijd voor een laatste raid is bijna voorbij.",
  },

  // Hidden Nest
  {
    id: "HIDDEN_NEST",
    type: "HIDDEN",
    title: "Verborgen Nest",
    text: "Diep onder de struiken ligt een verborgen nest. Alleen de dapperste vos vindt het op tijd.",
  },

  // Gate Toll
  {
    id: "GATE_TOLL",
    type: "TOLL",
    title: "Tol bij het Hek",
    text: "De poort kraakt open en dicht. Wie blijft hangen, moet een prijs betalen of wordt gesnapt.",
  },

  // Magpie Snitch
  {
    id: "MAGPIE_SNITCH",
    type: "SNITCH",
    title: "Ekster Verklikker",
    text: "Een nieuwsgierige ekster kraait het uit. Vooral de LEAD FOX loopt gevaar om verraden te worden.",
  },

  // Paint-Bomb Nest
  {
    id: "PAINT_BOMB_NEST",
    type: "PAINT",
    title: "Verf-bom Nest",
    text: "Een nest vol verf-eieren spat uit elkaar. Alle sporen en buit raken door elkaar.",
  },
];

// Helper: zoek event bij id (gebruikt door host.js en player.js)
export function getEventById(id) {
  return EVENTS.find((e) => e.id === id) || null;
}
