// /bots/core/scoring.js
import { hasTag } from "./eventIntel.js";

// shared
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function riskLabel(r) {
  if (r < 0.35) return "LOW";
  if (r < 0.65) return "MED";
  return "HIGH";
}

// ---------- helpers ----------
function expectedLootCardPoints(view) {
  // Zonder deck-distributie: veilige default (Egg=1, Hen=2, Prize=3 => ~2 gemiddeld)
  const ev = Number(view?.lootModel?.ev);
  if (Number.isFinite(ev)) return ev;
  return 2.0;
}

function intelCount(view) {
  const known = view?.me?.knownEvents;
  const knownPos = view?.me?.knownEventPositions;
  const a = Array.isArray(known) ? known.length : 0;
  const b = Array.isArray(knownPos) ? knownPos.length : 0;
  return a + b;
}

function dangerousSoon(upcoming) {
  return hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD");
}

// ---------- MOVE scoring (SNATCH/SCOUT/FORRAGE/SHIFT) ----------
export function scoreMoveMoves({ view, upcoming, profile }) {
  const chosen = view?.me?.moveChosenThisRound ?? null;
  if (chosen) {
    return [{
      type: "MOVE",
      move: chosen,
      score: -999,
      riskLabel: "LOW",
      confidence: 0.7,
      bullets: ["Je hebt je MOVE al gekozen deze ronde."],
    }];
  }

  const w = profile?.weights || {};
  const evLoot = expectedLootCardPoints(view);
  const intel = intelCount(view);
  const danger = dangerousSoon(upcoming);
  const lock = !!view.flags?.lockEvents;

  const candidates = ["SNATCH", "SCOUT", "FORRAGE", "SHIFT"].map((move) => {
    let score = 0;
    let risk = 0.05;
    const bullets = [];

    if (move === "SNATCH") {
      // direct punten → belangrijk voor winconditie
      score += (w.loot ?? 1.2) * (evLoot / 3);
      bullets.push(`SNATCH: +1 loot kaart (+~${evLoot.toFixed(1)} punten verwacht).`);
      bullets.push("Meeste loot wint → dit is pure value.");
    }

    if (move === "FORRAGE") {
      // 2 action cards → strategisch, vooral als hand klein is
      const handSize = Array.isArray(view?.me?.hand) ? view.me.hand.length : 0;
      const future = 1.1 - Math.min(0.4, handSize * 0.08);
      score += 0.85 * future;
      bullets.push("FORRAGE: trek 2 Action Cards (meer opties in OPS).");
      if (handSize < 2) bullets.push("Extra sterk: je hand is nog klein.");
    }

    if (move === "SCOUT") {
      // intel is super waardevol vóór Decision, zeker bij danger of geen intel
      const info = 1.0 + (intel === 0 ? 0.35 : 0) + (danger ? 0.25 : 0);
      score += 0.95 * info;
      bullets.push("SCOUT: bekijk 1 Event Card naar keuze.");
      if (danger) bullets.push("Er kan gevaar aankomen → intel is extra waardevol.");
      if (intel === 0) bullets.push("Je hebt nog geen intel → top pick.");
    }

    if (move === "SHIFT") {
      // SHIFT: 2 verborgen events verplaatsen, geen extra info. Sterk mét intel, zwak zonder.
      if (lock) {
        score -= 0.6;
        bullets.push("SHIFT kan niet/werkt slecht: Events zijn gelocked.");
        risk = 0.02;
      } else {
        const control = 0.35 + Math.min(0.65, intel * 0.18) + (danger ? 0.15 : 0);
        score += 0.9 * control;
        bullets.push("SHIFT: verplaats 2 verborgen Events (geen extra info).");
        if (intel === 0) bullets.push("Zonder intel is SHIFT vaak gokken.");
        else bullets.push("Met jouw intel kun je events tactisch herpositioneren.");
      }
    }

    // kleine risk-penalty (MOVE is meestal low-risk)
    score -= (w.risk ?? 1.0) * risk;

    return {
      type: "MOVE",
      move,
      score,
      riskLabel: riskLabel(clamp01(risk)),
      confidence: 0.72,
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
  // breid uit met jouw echte IDs
};

export function scoreActionCardsNow({ view, upcoming }) {
  const hand = view?.me?.hand || [];
  const lock = !!view.flags?.lockEvents;
  const danger = dangerousSoon(upcoming);

  const scored = hand.map((cardId) => {
    const tags = ACTION_TAGS[cardId] || [];
    let value = 0.15;
    const bullets = [];

    if (tags.includes("INFO_DECISION")) {
      value += 0.75 + (danger ? 0.15 : 0);
      bullets.push("Info kaart: helpt richting Decision.");
    }

    if (tags.includes("TRACK_MANIP")) {
      if (lock) {
        value -= 0.7;
        bullets.push("Events gelocked → track-manip is nu zwak/niet mogelijk.");
      } else {
        value += 0.65 + (danger ? 0.2 : 0);
        bullets.push("Track-manip: sterk als er gevaarlijke events aankomen.");
      }
    }

    if (tags.includes("DEN_SWAP")) {
      value += 0.35;
      bullets.push("Den-swap: nuttig als jouw den je nu benadeelt.");
    }

    if (tags.includes("COPY_DECISION_LATER")) {
      value += 0.25;
      bullets.push("Copy-decision: handig als je 1 speler als indicator gebruikt.");
    }

    return { type: "ACTION", cardId, score: value, bullets: bullets.slice(0, 3) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------- OPS scoring = welke Action Card spelen of PASS ----------
export function scoreOpsPlays({ view, upcoming, profile }) {
  const w = profile?.weights || {};
  const rankedCards = scoreActionCardsNow({ view, upcoming });

  const bestCard = rankedCards[0] || null;
  const bestScore = bestCard ? bestCard.score : 0;

  // PASS baseline: soms beter bewaren dan een zwakke kaart “weggooien”
  const passScore = 0.22; // tune dit

  const options = [];

  if (bestCard) {
    options.push({
      type: "OPS",
      play: "PLAY_CARD",
      cardId: bestCard.cardId,
      score: bestScore,
      confidence: 0.7,
      bullets: [
        `Beste kaart nu: ${bestCard.cardId}`,
        ...(bestCard.bullets || []),
      ].slice(0, 4),
    });
  }

  options.push({
    type: "OPS",
    play: "PASS",
    score: passScore + (w.conserveOps ?? 0) * 0.0,
    confidence: 0.65,
    bullets: [
      "PASS: je bewaart je kaarten voor een beter moment.",
      ...(bestCard && bestScore < passScore
        ? ["Je beste kaart scoort nu laag → bewaren is logisch."]
        : []),
    ].slice(0, 3),
  });

  options.sort((a, b) => b.score - a.score);
  return options;
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
      };
    });

  options.sort((a, b) => b.score - a.score);
  return options;
}
