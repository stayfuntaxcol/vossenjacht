// Alle Event Cards voor Vossenjacht.
// Let op: extra velden (category, riskLevel, lootModifier, rulesHint)
// worden NU nog niet gebruikt in de game-logica, maar zijn al klaar
// voor later. Host- en player-scherm gebruiken nu vooral title + text.

export const EVENTS = [
  {
    id: "SCOUT_COOP",
    title: "Verken het kippenhok",
    text: "De vossen kruipen langs de afrastering. Ze tellen de kippen en zoeken de zwakke plek in het hok.",
    category: "INFO",           // verkenning / informatie
    riskLevel: "LOW",           // relatief veilig
    lootModifier: 0,            // geen directe bonus
    rulesHint:
      "Normale ronde. Spelers kunnen deze ronde vooral strategisch nadenken zonder extra risico of bonus."
  },
  {
    id: "GUARD_DOG",
    title: "Waakhond slaat aan",
    text: "De boer zijn hond ruikt onraad. Hij blaft en rent richting het kippenhok.",
    category: "RISK",           // meer risico
    riskLevel: "HIGH",
    lootModifier: 0,
    rulesHint:
      "Hoog risico om betrapt te worden. In een latere versie kun je hier een zwaardere straf aan koppelen als veel spelers buit grijpen."
  },
  {
    id: "DARK_NIGHT",
    title: "Pikdonkere nacht",
    text: "Er is geen maanlicht. De vossen kunnen zich perfect verstoppen, maar zien zelf ook minder.",
    category: "OPPORTUNITY",    // kansrijk maar riskant
    riskLevel: "MEDIUM",
    lootModifier: +1,           // potentiële bonus op buit
    rulesHint:
      "In de toekomst kun je hier bijvoorbeeld +1 extra punt geven aan spelers die buit grijpen, maar ook kans op mislukking verhogen."
  },
  {
    id: "FARMER_LANTERN",
    title: "Boer met lantaarn",
    text: "De boer loopt zijn ronde met een lantaarn. Eén foute stap en hij betrapt je.",
    category: "RISK",
    riskLevel: "HIGH",
    lootModifier: 0,
    rulesHint:
      "Dit event leent zich goed voor strenge strafregels in latere versies (bijvoorbeeld puntenverlies als teveel vossen tegelijk buit grijpen)."
  },
  {
    id: "OPEN_GATE",
    title: "Openstaand hek",
    text: "Iemand is het hek vergeten te sluiten. De toegang tot het erf is ineens een stuk makkelijker.",
    category: "OPPORTUNITY",
    riskLevel: "LOW",
    lootModifier: +1,
    rulesHint:
      "Ideale ronde om buit te grijpen. Later kun je hier een vast voordeel aan koppelen, zoals +1 punt extra voor GRAB_LOOT."
  },
  {
    id: "PANIC_INSIDE",
    title: "Paniek in het kippenhok",
    text: "De kippen kakelen wild. Niemand weet precies waardoor, maar de chaos werkt in jouw voordeel.",
    category: "CHAOS",
    riskLevel: "MEDIUM",
    lootModifier: 0,
    rulesHint:
      "Chaos-event. In toekomstige regels kun je hier random effecten, extra loot of onverwachte straf aan koppelen."
  },
  {
    id: "CAR_LIGHTS",
    title: "Koplampen in de verte",
    text: "Een auto nadert de boerderij. Is het een buurman, of de boer die eerder terugkomt?",
    category: "PRESSURE",
    riskLevel: "MEDIUM",
    lootModifier: 0,
    rulesHint:
      "Psychologische druk. Spelers twijfelen of ze nog snel buit pakken of juist op veilig spelen."
  },
  {
    id: "RAINSTORM",
    title: "Onweersbui",
    text: "Een harde regenbui barst los. Sporen verdwijnen, maar het terrein wordt glad en glibberig.",
    category: "CHAOS",
    riskLevel: "MEDIUM",
    lootModifier: 0,
    rulesHint:
      "Dit event kan later gebruikt worden om bijvoorbeeld risico op mislukking te verlagen (sporen wissen) maar kans op ongeluk te verhogen."
  },
];

// Welke Event hoort bij welke ronde?
// Momenteel: gewoon door de lijst heen lopen en daarna weer bij het begin.
// Ronde 1 → SCOUT_COOP, 2 → GUARD_DOG, 3 → DARK_NIGHT, etc.
export function getEventForRound(roundNumber) {
  if (!roundNumber || roundNumber <= 0) return null;
  const index = (roundNumber - 1) % EVENTS.length;
  return EVENTS[index];
}

// Zoek een Event op id (gebruikt door host.js en player.js)
export function getEventById(id) {
  return EVENTS.find((e) => e.id === id) || null;
}
