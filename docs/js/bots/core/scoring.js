// /bots/core/scoring.js
// MOVE: SNATCH / SCOUT / FORRAGE / SHIFT
// OPS: Action Cards spelen of PASS (nu met DEFENSIVE/AGGRESSIVE styles)
// DECISION: LURK / BURROW / DASH
//
// Belangrijk: Action Card effecten komen uit cards.js (ACTION_DEFS via getActionDefByName)

import { hasTag } from "./eventIntel.js";
import { getActionDefByName } from "../../cards.js"; // pad: /bots/core -> /cards.js

// =====================
// shared helpers
// =====================
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
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
  const dash =
    hasTag(upcoming, "targets_dashers") || hasTag(upcoming, "CATCH_DASHERS");
  const yard = hasTag(upcoming, "yard_only") || hasTag(upcoming, "CATCH_ALL_YARD");
  const den =
    hasTag(upcoming, "catch_by_color") || hasTag(upcoming, "DEN_CHECK") || hasTag(upcoming, "CATCH_BY_DEN_COLOR");
  return { dog, dash, yard, den, any: dog || dash || yard || den };
}

function normalizeHandIds(hand) {
  return safeArr(hand)
    .map((c) => (typeof c === "string" ? c : (c?.name || c?.id || c?.cardId || "")))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function actionMeta(cardName) {
  const def = getActionDefByName(cardName);
  return {
    name: def?.name || cardName,
    id: def?.id || null,
    type: def?.type || "UTILITY",
    timing: def?.timing || "anytime",
    tags: safeArr(def?.tags),
    description: def?.description || "",
    meta: def?.meta || null, // <-- nieuw: advisor kan hierop bouwen
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
  const lock = !!(view?.flags?.lockEvents || view?.flagsRound?.lockEvents);
  const d = danger(upcoming);

  const candidates = ["SNATCH", "SCOUT", "FORRAGE", "SHIFT"].map((move) => {
    let score = 0;
    let risk = 0.05;
    const bullets = [];

    if (move === "SNATCH") {
      score += (w.loot ?? 1.3) * (evLoot / 5);
      bullets.push(`SNATCH: +1 loot kaart (+~${evLoot.toFixed(1)} punten verwacht).`);
      bullets.push("Meeste loot wint → dit is vaak de beste value-pick.");
    }

    if (move === "FORRAGE") {
      const handSize = safeArr(view?.me?.hand).length;
      const future = 1.1 - Math.min(0.45, handSize * 0.08);
      score += 0.95 * future;
      bullets.push("FORRAGE: trek 2 Action Cards (meer opties in OPS).");
      if (handSize < 2) bullets.push("Extra sterk: je hand is nog klein.");
    }

    if (move === "SCOUT") {
      const info = 1.0 + (intel === 0 ? 0.4 : 0.0) + (d.any ? 0.25 : 0.0);
      score += 1.05 * info;
      bullets.push("SCOUT: bekijk 1 Event Card naar keuze (grote waarde).");
      if (d.any) bullets.push("Er lijkt gevaar te komen → intel is extra belangrijk.");
      if (intel === 0) bullets.push("Je hebt nog geen intel → top pick.");
    }

    if (move === "SHIFT") {
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
// OPS scoring (nieuw)
// =====================

// flags helper (soms zit dit in flagsRound of game.flagsRound)
function getFlags(view) {
  return (
    view?.flagsRound ||
    view?.flags ||
    view?.game?.flagsRound ||
    view?.game?.flags ||
    {}
  );
}

function normalizeActionName(x) {
  const name = typeof x === "string" ? x : (x?.name || x?.id || x?.cardId || "");
  return String(name).trim();
}

function collectUpcomingIntel(upcoming = [], myDen = "") {
  // Werkt met jouw EVENT_DEFS objecten (id/category/denColor/tags),
  // maar pakt ook iets als upcoming minder info bevat.
  const tags = new Set();
  let hasCatchAll = false;
  let hasCatchDashers = false;
  let hasDenCheck = false;
  let denHit = false;
  let hasDogThreat = false;
  let leadTarget = false;

  // fallback via hasTag (als upcoming objects geen tags bevatten)
  const d = danger(upcoming);
  if (d.yard) hasCatchAll = true;
  if (d.dash) hasCatchDashers = true;
  if (d.den) hasDenCheck = true;
  if (d.dog) hasDogThreat = true;

  for (const ev of (upcoming || [])) {
    const evTags = Array.isArray(ev?.tags) ? ev.tags : [];
    evTags.forEach(t => tags.add(String(t)));

    const cat = String(ev?.category || "").toUpperCase();
    const denColor = String(ev?.denColor || "").toUpperCase();
    const id = String(ev?.id || "").toUpperCase();

    if (tags.has("CATCH_ALL_YARD")) hasCatchAll = true;
    if (tags.has("CATCH_DASHERS")) hasCatchDashers = true;

    if (cat === "DEN" || id.startsWith("DEN_")) {
      hasDenCheck = true;
      if (myDen && denColor && denColor === myDen) denHit = true;
    }

    if (cat === "DOG" || tags.has("dog_attack")) hasDogThreat = true;
    if (tags.has("target_lead_fox")) leadTarget = true;
  }

  return { tags, hasCatchAll, hasCatchDashers, hasDenCheck, denHit, hasDogThreat, leadTarget };
}

function riskFromRole(role, style) {
  const r = String(role || "").toLowerCase();
  if (r === "defense" || r === "info") return "LOW";
  if (r === "tempo" || r === "control" || r === "utility") return style === "AGGRESSIVE" ? "MED" : "LOW";
  if (r === "chaos") return style === "AGGRESSIVE" ? "HIGH" : "MED";
  return "MED";
}

function confidenceFromScore(score) {
  // 0..10 -> ~0.55..0.9 (clamped)
  return clamp(0.55 + (score / 10) * 0.35, 0.5, 0.9);
}

function buildOpsContext({ view, upcoming, style }) {
  const flags = getFlags(view);

  const me = view?.me || {};
  const game = view?.game || {};

  const myDen = String(me?.color || me?.denColor || me?.den || "").toUpperCase();

  const intel = collectUpcomingIntel(upcoming, myDen);

  const opsLocked = !!(flags.lockOps || flags.opsLocked || flags.lockActions || flags.lockOpsCards);
  const trackLocked = !!(flags.lockEvents || flags.trackLocked);

  const inYard = !(me?.caught || me?.isCaught || me?.dashed || me?.isDashed);

  const hand = Array.isArray(me?.hand) ? me.hand : [];
  const handNames = hand.map(normalizeActionName).filter(Boolean);

  // simpele threat score (hogere = meer reden om defensief te reageren)
  let threat = 0;
  if (intel.hasCatchAll) threat += 5;
  if (intel.hasDogThreat) threat += 3;
  if (intel.hasDenCheck) threat += 2;
  if (intel.denHit) threat += 3;
  if (intel.hasCatchDashers) threat += (style === "AGGRESSIVE" ? 3 : 2);

  // turn-order info (voor Hold Still waarde)
  const order = game?.opsTurnOrder || [];
  const idx = typeof game?.opsTurnIndex === "number" ? game.opsTurnIndex : 0;
  const playersAfterMe = order.length ? Math.max(0, order.length - idx - 1) : 0;

  const iAmLead = !!(me?.isLead || me?.lead === true || view?.isLead);

  return {
    me,
    game,
    flags,
    myDen,
    inYard,
    handNames,
    opsLocked,
    trackLocked,
    threat,
    playersAfterMe,
    intel,
    iAmLead,
  };
}

function typeBaseline(defType, style) {
  // fallback als meta ontbreekt
  const t = String(defType || "").toUpperCase();
  if (style === "DEFENSIVE") {
    if (t === "DEFENSE") return 2.8;
    if (t === "INFO") return 2.0;
    if (t === "UTILITY") return 1.4;
    if (t === "TRICK") return 1.2;
    return 1.0;
  } else {
    // AGGRESSIVE
    if (t === "TRICK") return 2.4;
    if (t === "UTILITY") return 2.0;
    if (t === "INFO") return 1.6;
    if (t === "DEFENSE") return 1.2;
    return 1.0;
  }
}

function scoreOneCard(cardName, def, ctx, style) {
  const meta = def?.meta || {};
  const role = meta.role || "utility";
  const tags = safeArr(def?.tags);

  // Basis: meta attack/defense, anders type baseline
  let score =
    style === "AGGRESSIVE"
      ? (Number(meta.attackValue) || typeBaseline(def?.type, style))
      : (Number(meta.defenseValue) || typeBaseline(def?.type, style));

  const bullets = [];

  // harde blocker
  if (ctx.opsLocked) {
    return {
      type: "OPS",
      play: "PLAY",
      cardId: cardName,
      score: -999,
      confidence: 0.2,
      riskLabel: "LOW",
      bullets: ["Hold Still is actief → je kunt geen kaarten spelen (alleen PASS)."],
    };
  }

  // timing bias (klein)
  const timing = String(def?.timing || "anytime").toLowerCase();
  if (timing === "after_event") score -= 0.6;
  if (timing === "before_event") score += 0.2;

  // === Heuristiek per bekende kaart/tag (mimi-set) ===

  // Den Signal (defensief top bij threat)
  if (cardName === "Den Signal" || tags.includes("DEN_IMMUNITY")) {
    if (ctx.intel.hasCatchAll || ctx.intel.hasDogThreat || ctx.intel.hasDenCheck) score += 3.5;
    if (ctx.threat >= 6) score += 1.5;
    bullets.push("Den Signal: beschermt 1 Den-kleur tegen vang-events (deze ronde).");
  }

  // Molting Mask (uit den-hit ontsnappen)
  if (cardName === "Molting Mask" || tags.includes("DEN_SWAP")) {
    if (ctx.intel.denHit) score += 4.5;
    else if (ctx.intel.hasDenCheck) score += 1.5;
    bullets.push("Molting Mask: wisselt jouw Den-kleur (kan Den-check ontwijken).");
  }

  // Mask Swap (reset alle den kleuren)
  if (cardName === "Mask Swap" || tags.includes("SHUFFLE_DEN_COLORS")) {
    if (ctx.intel.hasDenCheck) score += 2.8;
    if (ctx.threat >= 6) score += 0.8;
    bullets.push("Mask Swap: husselt Den-kleuren in Yard (breekt targeting).");
  }

  // Hold Still (OPS lock, sterker als er spelers na jou komen)
  if (cardName === "Hold Still" || tags.includes("LOCK_OPS")) {
    score += Math.min(5, ctx.playersAfterMe);
    if (ctx.threat >= 7 && style === "DEFENSIVE") score += 1.5;
    bullets.push("Hold Still: stopt verdere Action Cards (alleen PASS).");
  }

  // Burrow Beacon (track lock)
  if (cardName === "Burrow Beacon" || tags.includes("LOCK_EVENTS")) {
    if (ctx.trackLocked) score -= 3.5;
    else score += 2.2;
    bullets.push("Burrow Beacon: lockt Event Track (stopt manipulatie).");
  }

  // Track manipulation (Kick Up Dust / Pack Tinker)
  if (tags.includes("TRACK_MANIP") || tags.includes("SWAP_RANDOM") || tags.includes("SWAP_MANUAL")) {
    if (ctx.trackLocked) {
      score -= 6.5;
      bullets.push("Event Track is gelocked → manipulatie werkt niet.");
    } else {
      score += ctx.threat >= 6 ? (style === "DEFENSIVE" ? 2.6 : 3.4) : (style === "AGGRESSIVE" ? 2.0 : 1.0);
      bullets.push("Track manipulation: beïnvloedt toekomstige events.");
    }
  }

  // Info cards (Scent Check / Nose for Trouble)
  if (def?.type === "INFO" || tags.includes("INFO") || tags.includes("PEEK_DECISION") || tags.includes("PREDICT_EVENT")) {
    score += style === "DEFENSIVE" ? 1.2 : 0.6;
    if (ctx.intel.hasCatchDashers) score += 1.0;
    bullets.push("Info: betere timing voor DECISION (DASH/BURROW/LURK).");
  }

  // Scout denial
  if (tags.includes("BLOCK_SCOUT") || tags.includes("BLOCK_SCOUT_POS")) {
    score += style === "AGGRESSIVE" ? 1.6 : 0.6;
    bullets.push("Info-denial: voorkomt (gerichte) SCOUT info.");
  }

  // Alpha Call (lead safety)
  if (tags.includes("SET_LEAD")) {
    if (ctx.intel.leadTarget && ctx.iAmLead) score += 4.0;
    else if (ctx.intel.leadTarget) score += 1.2;
    bullets.push("Alpha Call: Lead wisselen (kan lead-target event ontwijken).");
  }

  // Follow the Tail (aggressive tempo)
  if (tags.includes("COPY_DECISION_LATER")) {
    score += style === "AGGRESSIVE" ? 1.6 : 0.2;
    bullets.push("Follow the Tail: meeliften op andermans DECISION (tempo).");
  }

  // in-yard check (als je al caught/dashed bent: veel minder waarde)
  if (!ctx.inYard) score -= 6;

  // kleine penalty als kaart alleen maar “ROUND_EFFECT” is en threat laag (defensief)
  if (style === "DEFENSIVE" && tags.includes("ROUND_EFFECT") && ctx.threat <= 2) score -= 0.8;

  // fallback bullet (korte beschrijving)
  if (def?.description && bullets.length < 3) bullets.push(def.description);

  return {
    type: "OPS",
    play: "PLAY",
    cardId: cardName,
    score,
    confidence: confidenceFromScore(score),
    riskLabel: riskFromRole(role, style),
    bullets: bullets.slice(0, 4),
    meta: def?.meta || null,
  };
}

function scorePass(ctx, style, profile) {
  const w = profile?.weights || {};
  let score = 2.2; // baseline

  const bullets = ["PASS: je bewaart kaarten voor later."];

  if (ctx.opsLocked) {
    score = 10;
    bullets.unshift("Hold Still is actief → PASS is de enige keuze.");
  }

  if (!ctx.handNames.length) {
    score = 10;
    bullets.unshift("Geen kaarten in hand → PASS.");
  }

  // defensief: threat laag → pass vaker ok
  if (style === "DEFENSIVE" && ctx.threat <= 3) score += 1.0;

  // aggressive: threat laag maar hand sterk → pass minder aantrekkelijk
  if (style === "AGGRESSIVE" && ctx.threat <= 3) score -= 0.6;

  // bestaand profielgewicht (optioneel)
  score += Number(w.conserveOps || 0) * 0.0;

  return {
    type: "OPS",
    play: "PASS",
    cardId: null,
    score,
    confidence: confidenceFromScore(score),
    riskLabel: "LOW",
    bullets: bullets.slice(0, 4),
  };
}

// EXPORT: OPS scoring met style support
export function scoreOpsPlays({ view, upcoming, profile, style = "DEFENSIVE" }) {
  const ctx = buildOpsContext({ view, upcoming, style });

  const ranked = [];
  ranked.push(scorePass(ctx, style, profile));

  for (const name of ctx.handNames) {
    const def = getActionDefByName(name);
    if (!def) {
      ranked.push({
        type: "OPS",
        play: "PLAY",
        cardId: name,
        score: 1.0,
        confidence: 0.45,
        riskLabel: "MED",
        bullets: ["Onbekende kaart-definitie → lage score."],
      });
      continue;
    }
    ranked.push(scoreOneCard(name, def, ctx, style));
  }

  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // context regel bovenaan bullets (handig debug)
  const ctxLine = `Context: threat=${ctx.threat} • trackLocked=${ctx.trackLocked ? "yes" : "no"} • opsLocked=${ctx.opsLocked ? "yes" : "no"} • style=${style}`;
  ranked.forEach(r => {
    r.bullets = [ctxLine, ...(r.bullets || [])].slice(0, 5);
  });

  return ranked;
}

// =====================
// DECISION scoring
// =====================
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

  if (decision === "DASH" && (hasTag(upcoming, "targets_dashers") || hasTag(upcoming, "CATCH_DASHERS"))) {
    risk += 0.45;
  }

  if (hasTag(upcoming, "yard_only") || hasTag(upcoming, "CATCH_ALL_YARD")) {
    if (decision === "DASH") risk += 0.25;
    if (decision === "LURK") risk += 0.15;
  }

  if ((view?.flags?.lockEvents || view?.flagsRound?.lockEvents) && decision === "DASH") risk += 0.10;

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
