// Eenvoudige Vossenjacht-events (later kun je dit uitbreiden / fine-tunen)
export const EVENTS = [
  {
    id: "SCOUT_COOP",
    title: "Verken het kippenhok",
    text: "De vossen kruipen langs de afrastering. Ze tellen de kippen en zoeken de zwakke plek in het hok.",
  },
  {
    id: "GUARD_DOG",
    title: "Waakhond slaat aan",
    text: "De boer zijn hond ruikt onraad. Hij blaft en rent richting het kippenhok.",
  },
  {
    id: "DARK_NIGHT",
    title: "Pikdonkere nacht",
    text: "Er is geen maanlicht. De vossen kunnen zich perfect verstoppen, maar zien zelf ook minder.",
  },
  {
    id: "FARMER_LANTERN",
    title: "Boer met lantaarn",
    text: "De boer loopt zijn ronde met een lantaarn. Eén foute stap en hij betrapt je.",
  },
  {
    id: "OPEN_GATE",
    title: "Openstaand hek",
    text: "Iemand is het hek vergeten te sluiten. De toegang tot het erf is ineens een stuk makkelijker.",
  },
  {
    id: "PANIC_INSIDE",
    title: "Paniek in het kippenhok",
    text: "De kippen kakelen wild. Niemand weet precies waardoor, maar de chaos werkt in jouw voordeel.",
  },
  {
    id: "CAR_LIGHTS",
    title: "Koplampen in de verte",
    text: "Een auto nadert de boerderij. Is het een buurman, of de boer die eerder terugkomt?",
  },
  {
    id: "RAINSTORM",
    title: "Onweersbui",
    text: "Een harde regenbui barst los. Sporen verdwijnen, maar het terrein wordt glad en gladjes.",
  },
];

// Bepaal event op basis van rondenummer (1 → eerste event, 2 → tweede, etc.)
export function getEventForRound(roundNumber) {
  if (!roundNumber || roundNumber <= 0) return null;
  const index = (roundNumber - 1) % EVENTS.length;
  return EVENTS[index];
}

export function getEventById(id) {
  return EVENTS.find((e) => e.id === id) || null;
}
