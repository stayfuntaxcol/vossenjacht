// /bots/core/scoring.js
import { hasTag } from "./eventIntel.js";

// ---------- shared helpers ----------
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function riskLabel(r) {
  if (r < 0.35) return "LOW";
  if (r < 0.65) return "MED";
  return "HIGH";
}

// ---------- DECISION scoring ----------
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
  return 0.3; // DASH commit
}

function conservePenalty(decision, view) {
  if (decision !== "BURROW") return 0;

  const rem = view?.me?.burrowRemaining ?? 1;
  if (rem <= 0) return 999; // BURROW illegal / op
  if (rem === 1) return 0.55; // laatste BURROW is kostbaar
  return 0.25;
}

export function scoreDecisions({ view, upcoming, profile }) {
  const w = profile?.weights || {};

  const options = ["LURK", "BURROW", "DASH"]
    .filter((d) => d !== "BURROW" || (view?.me?.burrowRemaining ?? 1) > 0)
    .map((decision) => {
      const loot = baseLoot(decision);
      const risk = baseRisk(decision, view, upcoming);
      const flex = flexibility(decision);
      const conserve = conservePenalty(decision, view);

      const score =
        (w.loot ?? 1.0) * loot -
        (w.risk ?? 1.0) * risk +
        (w.flexibility ?? 0.0) * flex -
        (w.conserve ?? 0.0) * conserve;

      return {
        type: "DECISION",
        decision,
        score,
        riskLabel: riskLabel(risk),
        components: { loot, risk, flex, conserve },
      };
    });

  options.sort((a, b) => b.score - a.score);
  return options;
}

// ---------- OPS scoring (SNATCH / FORRAGE / SCOUT / SHIFT) ----------
function expectedLootCardPoints(view) {
  // Als je later deck-distributie toevoegt: maak dit exact.
  const ev = Number(view?.lootModel?.ev);
  if (Number.isFinite(ev)) return ev;
  return 2.0; // veilige default (Egg=1, Hen=2, Prize=3)
}

function intelCount(view) {
  const known = view?.me?.knownEvents;
  const knownPos = view?.me?.knownEventPositions;
  const a = Array.isArray(known) ? known.length : 0;
  const b = Array.isArray(knownPos) ? knownPos.length : 0;
  return a + b;
}

export function scoreOpsMoves({ view, upcoming, profile }) {
  const w = profile?.weights || {};
  const lock = !!view.flags?.lockEvents;

  const already = view?.me?.opsTakenThisRound || [];
  const evLoot = expectedLootCardPoints(view);
  const intel = intelCount(view);

  const moves = ["SNATCH", "FORRAGE", "SCOUT", "SHIFT"].filter(
    (m) => !already.includes(m)
  );

  const dangerousSoon =
    hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD");

  const candidates = moves.map((move) => {
    let lootPts = 0;
    let future = 0;
    let info = 0;
    let control = 0;
    let risk = 0.03; // OPS is meestal low-risk
    const bullets = [];

    if (move === "SNATCH") {
      lootPts = evLoot;
      bullets.push(`SNATCH: +1 loot kaart (+~${evLoot.toFixed(1)} punten verwacht).`);
      bullets.push("Omdat meeste loot wint, is dit vaak pure value.");
    }

    if (move === "FORRAGE") {
      const handSize = Array.isArray(view?.me?.hand) ? view.me.hand.length : 0;
      future = 1.1 - Math.min(0.4, handSize * 0.08);
      bullets.push("FORRAGE: trek 2 Action Cards (meer tactische opties).");
      if (handSize < 2) bullets.push("Extra sterk: je hand is nog klein.");
    }

    if (move === "SCOUT") {
      info = 1.0 + (intel === 0 ? 0.35 : 0.0) + (dangerousSoon ? 0.25 : 0.0);
      bullets.push("SCOUT: kijk 1 Event Card naar keuze (grote waarde vóór Decision).");
      if (dangerousSoon) bullets.push("Er komt mogelijk gevaar aan → intel is extra waardevol.");
    }

    if (move === "SHIFT") {
      if (lock) {
        control = 0;
        bullets.push("SHIFT kan niet: Events zijn gelocked.");
        risk = 0.01;
      } else {
        control = 0.35 + Math.min(0.65, intel * 0.18) + (dangerousSoon ? 0.15 : 0.0);
        bullets.push("SHIFT: verplaats 2 verborgen Events (geen extra info).");
        if (intel === 0) bullets.push("Zonder intel is SHIFT vaak gokken.");
        else bullets.push("Met jouw intel kun je events tactisch herpositioneren.");
      }
    }

    // Score: directe punten zwaar (winconditie), rest als strategische bonus
    const score =
      (w.loot ?? 1.2) * (lootPts / 3) + // normaliseer 0..1
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
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ---------- Action card scoring (NU spelen) ----------
const ACTION_TAGS = {
  MOLTING_MASK: ["DEN_SWAP"],
  SCENT_CHECK: ["INFO_DECISION"],
  FOLLOW_THE_TAIL: ["COPY_DECISION_LATER"],
  PACK_TINKER: ["TRACK_MANIP"],
  // vul aan met jouw echte IDs
};

export function scoreActionCardsNow({ view, upcoming }) {
  const hand = view?.me?.hand || [];
  const lock = !!view.flags?.lockEvents;
  const dangerousSoon =
    hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD");

  const scored = hand.map((cardId) => {
    const tags = ACTION_TAGS[cardId] || [];
    let value = 0.15;
    const bullets = [];

    if (tags.includes("INFO_DECISION")) {
      value += 0.75 + (dangerousSoon ? 0.15 : 0);
      bullets.push("Info kaart: helpt sterk richting Decision.");
    }

    if (tags.includes("TRACK_MANIP")) {
      if (lock) {
        value -= 0.7;
        bullets.push("Events gelocked → track-manip is nu zwak/niet mogelijk.");
      } else {
        value += 0.65 + (dangerousSoon ? 0.2 : 0);
        bullets.push("Track-manip: sterk als er gevaarlijke events aankomen.");
      }
    }

    if (tags.includes("DEN_SWAP")) {
      value += 0.35;
      bullets.push("Den-swap: nuttig als jouw den je nu benadeelt.");
    }

    if (tags.includes("COPY_DECISION_LATER")) {
      value += 0.25;
      bullets.push("Copy-decision: handig als je 1 speler als ‘indicator’ gebruikt.");
    }

    return { type: "ACTION", cardId, score: value, bullets: bullets.slice(0, 3) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
