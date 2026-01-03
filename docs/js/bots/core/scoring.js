// /bots/core/scoring.js
import { hasTag } from "./eventIntel.js";

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function riskLabel(r) {
  if (r < 0.35) return "LOW";
  if (r < 0.65) return "MED";
  return "HIGH";
}

// --------------------
// DECISION scoring
// --------------------
function baseLoot(decision) {
  if (decision === "DASH") return 1.0;
  if (decision === "BURROW") return 0.6;
  return 0.3; // LURK
}

function baseRisk(decision, view, upcoming) {
  let risk = 0.15;
  if (decision === "DASH") risk += 0.35;
  if (decision === "BURROW") risk += 0.10;
  if (decision === "LURK") risk += 0.05;

  if (decision === "DASH" && hasTag(upcoming, "CATCH_DASHERS")) risk += 0.45;

  if (hasTag(upcoming, "CATCH_ALL_YARD")) {
    if (decision === "DASH") risk += 0.25;
    if (decision === "LURK") risk += 0.15;
  }

  if (view.flags?.lockEvents && decision === "DASH") risk += 0.10;

  return clamp01(risk);
}

function flexibility(decision) {
  if (decision === "BURROW") return 0.8;
  if (decision === "LURK") return 0.6;
  return 0.3;
}

function conservePenalty(decision, view) {
  if (decision !== "BURROW") return 0;
  const rem = view?.me?.burrowRemaining ?? 1;
  if (rem <= 0) return 999;
  if (rem === 1) return 0.55;
  return 0.25;
}

export function scoreDecisions({ view, upcoming, profile }) {
  const w = profile?.weights || {};
  const options = ["LURK", "BURROW", "DASH"]
    .filter(d => d !== "BURROW" || (view?.me?.burrowRemaining ?? 1) > 0)
    .map((decision) => {
      const loot = baseLoot(decision);
      const risk = baseRisk(decision, view, upcoming);
      const flex = flexibility(decision);
      const conserve = conservePenalty(decision, view);

      const score =
        (w.loot ?? 1) * loot -
        (w.risk ?? 1) * risk +
        (w.flexibility ?? 0) * flex -
        (w.conserve ?? 0) * conserve;

      return { type: "DECISION", decision, score, riskLabel: riskLabel(risk) };
    });

  options.sort((a, b) => b.score - a.score);
  return options;
}

// --------------------
// OPS scoring (SNATCH / FORRAGE / SCOUT / SHIFT)
// --------------------
// Regels (jij):
// - SNATCH: pak 1 loot card (Egg=1, Hen=2, Prize Hen=3). Meeste loot aan einde Raid wint.
// - FORRAGE: pak 2 Action Cards (strategisch voordeel in OPS).
// - SCOUT: bekijk 1 Event Card naar keuze.
// - SHIFT: verplaats 2 verborgen Event Cards naar keuze (geen extra info), verboden bij lockEvents.

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function riskLabel(r) {
  if (r < 0.35) return "LOW";
  if (r < 0.65) return "MED";
  return "HIGH";
}

// Verwachte punten van 1 loot card.
// Zonder deck-distributie nemen we een veilige default (gemiddeld ~2).
// Als jij later deck counts toevoegt aan game/view, kunnen we dit exact maken.
function expectedLootCardPoints(view) {
  const ev = Number(view?.lootModel?.ev);
  if (Number.isFinite(ev)) return ev;
  return 2.0;
}

// Hoeveel “intel” heb jij al? (optioneel; werkt ook als het niet bestaat)
function intelCount(view) {
  const known = view?.me?.knownEvents;
  const knownPos = view?.me?.knownEventPositions;
  const a = Array.isArray(known) ? known.length : 0;
  const b = Array.isArray(knownPos) ? knownPos.length : 0;
  return a + b;
}

// Doelwit voor SNATCH (als SNATCH een target heeft in jouw regels, kun je dit gebruiken)
// Jouw uitleg zegt alleen "pak 1 loot kaart", dus target = null.
function bestSnatchTarget(view) {
  return null;
}

export function scoreOpsMoves({ view, upcoming, profile }) {
  const w = profile?.weights || {};
  const lock = !!view.flags?.lockEvents;

  const evLoot = expectedLootCardPoints(view);
  const intel = intelCount(view);

  const candidates = ["SNATCH", "FORRAGE", "SCOUT", "SHIFT"].map((move) => {
    let lootPts = 0;     // directe punten
    let future = 0;      // toekomstige waarde (actions/control)
    let info = 0;        // kenniswaarde
    let control = 0;     // event-manipulatie waarde
    let risk = 0.05;     // OPS acties zijn meestal low-risk
    const bullets = [];

    if (move === "SNATCH") {
      lootPts = evLoot; // 1 loot kaart = EV punten
      bullets.push(`SNATCH geeft direct punten (+~${evLoot.toFixed(1)} verwacht).`);
      bullets.push("Omdat meeste loot wint, is dit vaak de veiligste value-pick.");
    }

    if (move === "FORRAGE") {
      // 2 action cards: geen directe punten, wel future voordeel.
      // Als hand al groot is, kan waarde iets lager (optioneel).
      const handSize = Array.isArray(view?.me?.hand) ? view.me.hand.length : 0;
      future = 1.1 - Math.min(0.4, handSize * 0.08);
      bullets.push("FORRAGE geeft 2 Action Cards (sterk voor tactische opties).");
      if (handSize < 2) bullets.push("Extra nuttig: je hand is nog klein.");
    }

    if (move === "SCOUT") {
      // Kennis is heel waardevol vóór Decision. Vooral als je nog weinig intel hebt.
      info = 1.0 + (intel === 0 ? 0.35 : 0.0);
      bullets.push("SCOUT laat je 1 Event Card naar keuze zien (heel waardevol).");
      if (intel === 0) bullets.push("Extra waarde: je hebt nog geen intel opgebouwd.");
    }

    if (move === "SHIFT") {
      if (lock) {
        control = 0;
        bullets.push("SHIFT kan nu niet: Events zijn gelocked.");
        risk = 0.01;
      } else {
        // SHIFT is pas echt sterk als je weet waar iets ligt (via SCOUT).
        control = 0.35 + Math.min(0.65, intel * 0.18);
        bullets.push("SHIFT verplaatst 2 verborgen Events (controle zonder extra info).");
        if (intel === 0) bullets.push("Let op: zonder intel is SHIFT vaak gokken.");
        else bullets.push("Met jouw intel kun je events strategisch herpositioneren.");
      }
    }

    // Score: direct punten zwaar laten wegen (win-conditie).
    // future/info/control wegen ook mee, maar minder dan lootPts.
    const score =
      (w.loot ?? 1.2) * (lootPts / 3) +     // normaliseer naar 0..1 (max 3)
      0.8 * future +
      0.9 * info +
      0.9 * control -
      (w.risk ?? 1.0) * risk;

    return {
      type: "OPS",
      move,
      score,
      riskLabel: riskLabel(clamp01(risk)),
      confidence: 0.7,
      bullets: bullets.slice(0, 4),
      target: move === "SNATCH" ? bestSnatchTarget(view) : null,
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// --------------------
// Action Card scoring (welke nú spelen)
// --------------------
// MVP: tag-based. Jij breidt uit met echte kaart-IDs.
// moment filtering doe je later; nu adviseren we “beste NU”.

const ACTION_TAGS = {
  MOLTING_MASK: ["DEN_SWAP"],
  SCENT_CHECK: ["INFO_DECISION"],
  FOLLOW_THE_TAIL: ["COPY_DECISION_LATER"],
  PACK_TINKER: ["TRACK_MANIP"],
  KICK_UP_DUST: ["CHAOS", "ANTI_DOG"], // voorbeeld
};

export function scoreActionCardsNow({ view, upcoming, profile }) {
  const hand = view?.me?.hand || [];
  const lock = !!view.flags?.lockEvents;

  const scored = hand.map((cardId) => {
    const tags = ACTION_TAGS[cardId] || [];
    let value = 0.2;
    const bullets = [];

    if (tags.includes("INFO_DECISION")) {
      value += 0.7;
      bullets.push("Info kaart: sterker als je onzeker bent wat anderen doen.");
      if (hasTag(upcoming, "CATCH_DASHERS")) value += 0.2;
    }

    if (tags.includes("TRACK_MANIP")) {
      if (lock) {
        value -= 0.6;
        bullets.push("Track-manip werkt slecht/ niet: events zijn gelocked.");
      } else {
        value += 0.6;
        bullets.push("Track-manip: sterk als er gevaarlijke events aankomen.");
        if (hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD")) value += 0.3;
      }
    }

    if (tags.includes("DEN_SWAP")) {
      value += 0.35;
      bullets.push("Den-swap: goed als jouw huidige den je nu benadeelt.");
    }

    if (tags.includes("COPY_DECISION_LATER")) {
      value += 0.25;
      bullets.push("Copy-decision: handig als je 1 speler vertrouwt als 'leading indicator'.");
    }

    return {
      type: "ACTION",
      cardId,
      score: value,
      bullets: bullets.slice(0, 3),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
