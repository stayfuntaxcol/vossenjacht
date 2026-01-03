// /bots/core/scoring.js
// MOVE: SNATCH / SCOUT / FORRAGE / SHIFT
// OPS: Action Cards spelen of PASS
// DECISION: LURK / BURROW / DASH
//
// Belangrijk: Action Card effecten komen uit cards.js (ACTION_DEFS via getActionDefByName)
// i.p.v. een hardcoded ACTION_TAGS map.

import { hasTag } from "./eventIntel.js";
import { getActionDefByName } from "../../cards.js"; // pad: /bots/core -> /cards.js

// =====================
// shared helpers
// =====================
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function riskLabel(r) {
  if (r < 0.35) return "LOW";
  if (r < 0.65) return "MED";
  return "HIGH";
}

function safeArr(a) {
  return Array.isArray(a) ? a : [];
}

function expectedLootCardPoints(view) {
  // Zonder deck stats: default EV=2 (Egg=1, Hen=3, Prize Hen=5 in jouw LOOT_DEFS)
  // Je kunt later view.lootModel.ev zetten voor exactere EV.
  const ev = Number(view?.lootModel?.ev);
  if (Number.isFinite(ev)) return ev;
  return 2.0;
}

function intelCount(view) {
  const known = safeArr(view?.me?.knownEvents);
  const knownPos = safeArr(view?.me?.knownEventPositions);
  return known.length + knownPos.length;
}

function danger(upcoming) {
  // Probeer beide stijlen: jouw EVENT_DEFS tags (lowercase) + oudere bot-tags (uppercase)
  const dog = hasTag(upcoming, "dog_attack") || hasTag(upcoming, "DOG_ATTACK");
  const dash = hasTag(upcoming, "targets_dashers") || hasTag(upcoming, "CATCH_DASHERS");
  const yard = hasTag(upcoming, "yard_only") || hasTag(upcoming, "CATCH_ALL_YARD");
  const den = hasTag(upcoming, "catch_by_color") || hasTag(upcoming, "DEN_CHECK");
  return { dog, dash, yard, den, any: dog || dash || yard || den };
}

function normalizeHandIds(hand) {
  return safeArr(hand)
    .map((c) => (typeof c === "string" ? c : (c?.name || c?.id || "")))
    .filter(Boolean);
}

function actionMeta(cardName) {
  const def = getActionDefByName(cardName);
  return {
    name: def?.name || cardName,
    type: def?.type || "UTILITY",
    timing: def?.timing || "anytime",
    tags: safeArr(def?.tags),
    description: def?.description || "",
  };
}

// =====================
// MOVE scoring
// =====================
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
  const lock = !!view?.flags?.lockEvents;
  const d = danger(upcoming);

  const candidates = ["SNATCH", "SCOUT", "FORRAGE", "SHIFT"].map((move) => {
    let score = 0;
    let risk = 0.05;
    const bullets = [];

    if (move === "SNATCH") {
      // SNATCH = pak 1 loot kaart -> directe punten
      score += (w.loot ?? 1.3) * (evLoot / 5); // normaliseer t.o.v. max loot (Prize Hen=5)
      bullets.push(`SNATCH: +1 loot kaart (+~${evLoot.toFixed(1)} punten verwacht).`);
      bullets.push("Meeste loot wint → dit is vaak de beste value-pick.");
    }

    if (move === "FORRAGE") {
      // FORRAGE = pak 2 action cards -> future value (OPS)
      const handSize = safeArr(view?.me?.hand).length;
      const future = 1.1 - Math.min(0.45, handSize * 0.08);
      score += 0.95 * future;
      bullets.push("FORRAGE: trek 2 Action Cards (meer opties in OPS).");
      if (handSize < 2) bullets.push("Extra sterk: je hand is nog klein.");
    }

    if (move === "SCOUT") {
      // SCOUT = bekijk event card -> intel value richting Decision
      const info = 1.0 + (intel === 0 ? 0.4 : 0.0) + (d.any ? 0.25 : 0.0);
      score += 1.05 * info;
      bullets.push("SCOUT: bekijk 1 Event Card naar keuze (grote waarde).");
      if (d.any) bullets.push("Er lijkt gevaar te komen → intel is extra belangrijk.");
      if (intel === 0) bullets.push("Je hebt nog geen intel → top pick.");
    }

    if (move === "SHIFT") {
      // SHIFT = verplaats 2 verborgen events -> control zonder info
      if (lock) {
        score -= 0.7;
        risk = 0.02;
        bullets.push("SHIFT werkt nu niet: Events zijn gelocked.");
      } else {
        const control = 0.35 + Math.min(0.75, intel * 0.18) + (d.any ? 0.15 : 0.0);
        score += 0.95 * control;
        bullets.push("SHIFT: verplaats 2 verborgen Events (geen extra info).");
        if (intel === 0) bullets.push("Zonder intel is SHIFT meestal gokken.");
        else bullets.push("Met intel kun je events tactisch herpositioneren.");
      }
    }

    // kleine risk penalty
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

// =====================
// Action card scoring (OPS)
// =====================
export function scoreActionCardsNow({ view, upcoming }) {
  const hand = normalizeHandIds(view?.me?.hand);
  const lock = !!view?.flags?.lockEvents;
  const d = danger(upcoming);

  const scored = hand.map((cardName) => {
    const meta = actionMeta(cardName);

    let score = 0.15;
    const bullets = [];

    // Timing bias: after_event kaarten liever bewaren (reaction)
    if (meta.timing === "after_event") {
      score -= 0.25;
      bullets.push("Reaction kaart: vaak beter bewaren tot na een Event.");
    } else if (meta.timing === "before_event") {
      score += 0.10;
      bullets.push("Before-event kaart: goed moment om druk te zetten.");
    } else {
      bullets.push("Anytime kaart: flexibel inzetbaar.");
    }

    // Type baseline
    if (meta.type === "INFO") score += 0.28;
    if (meta.type === "DEFENSE") score += 0.22;
    if (meta.type === "TRICK") score += 0.18;
    if (meta.type === "MOVEMENT") score += 0.12;

    // Tag synergie (jouw ACTION_DEFS tags)
    const t = meta.tags;

    // Tegen DOG events
    if (d.dog && (t.includes("avoid_dog") || t.includes("obscure") || t.includes("redirect_danger") || t.includes("escape"))) {
      score += 0.55;
      bullets.push("Sterk tegen Dog-events.");
    }

    // Tegen Den kleur checks
    if (d.den && (t.includes("swap_den") || t.includes("den_trick") || t.includes("protect_den") || t.includes("group_defense"))) {
      score += 0.45;
      bullets.push("Helpt tegen Den kleur-check events.");
    }

    // Intel / vooruit kijken
    if (t.includes("peek_event") || t.includes("peek") || t.includes("warn") || t.includes("info")) {
      score += 0.35 + (d.any ? 0.10 : 0.0);
      bullets.push("Info voordeel richting Decision.");
    }

    // Event manipulatie / redraw
    if (t.includes("cancel_event") || t.includes("redraw") || t.includes("reorder")) {
      if (lock) {
        score -= 0.25;
        bullets.push("Events gelocked → minder waarde nu.");
      } else {
        score += 0.30;
        bullets.push("Kan events beïnvloeden / ombuigen.");
      }
    }

    // “altijd ok” tags
    if (t.includes("counter") || t.includes("reaction")) score += 0.08;

    // korte beschrijving als fallback bullet
    if (meta.description && bullets.length < 3) bullets.push(meta.description);

    return {
      type: "ACTION",
      cardId: meta.name,           // let op: jouw hand gebruikt card "name"
      score,
      bullets: bullets.slice(0, 3),
      meta, // handig voor debug
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// =====================
// OPS scoring: PLAY CARD of PASS
// =====================
export function scoreOpsPlays({ view, upcoming, profile }) {
  const w = profile?.weights || {};

  const rankedCards = scoreActionCardsNow({ view, upcoming });
  const bestCard = rankedCards[0] || null;
  const bestScore = bestCard ? bestCard.score : 0;

  // PASS baseline: bewaren kan slim zijn als je beste kaart nu weinig doet
  const passScore = 0.22;

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

// =====================
// DECISION scoring
// =====================
function baseLoot(decision) {
  // Decision beïnvloedt overleving / toekomstige loot (heuristiek)
  if (decision === "DASH") return 1.0;
  if (decision === "BURROW") return 0.6;
  return 0.3; // LURK
}

function baseRisk(decision, view, upcoming) {
  let risk = 0.15;

  if (decision === "DASH") risk += 0.35;
  if (decision === "BURROW") risk += 0.10;
  if (decision === "LURK") risk += 0.05;

  // Dashers gepakt?
  if (decision === "DASH" && (hasTag(upcoming, "targets_dashers") || hasTag(upcoming, "CATCH_DASHERS"))) {
    risk += 0.45;
  }

  // Yard gevaar (algemeen)
  if (hasTag(upcoming, "yard_only") || hasTag(upcoming, "CATCH_ALL_YARD")) {
    if (decision === "DASH") risk += 0.25;
    if (decision === "LURK") risk += 0.15;
  }

  // Lock events kan dash minder voorspelbaar maken
  if (view?.flags?.lockEvents && decision === "DASH") risk += 0.10;

  // DOG events: LURK/DASH risk iets omhoog
  if (hasTag(upcoming, "dog_attack")) {
    if (decision === "DASH") risk += 0.15;
    if (decision === "LURK") risk += 0.10;
  }

  return clamp01(risk);
}

function flexibility(decision) {
  if (decision === "BURROW") return 0.8;
  if (decision === "LURK") return 0.6;
  return 0.3;
}

function conservePenalty(decision, view) {
  // BURROW is schaars (1x per Raid)
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
