// /bots/advisor/advisorBot.js

import { ADVISOR_PROFILES } from "../core/botConfig.js";
import { buildPlayerView } from "../core/stateView.js";
import { getUpcomingEvents } from "../core/eventIntel.js";
import {
  scoreMoveMoves,
  scoreOpsPlays,
  scoreDecisions,
} from "../core/scoring.js";

// Action defs + info (1 bron: cards.js)
import { getActionDefByName, getActionInfoByName } from "../../cards.js";

// ------------------------------
// Phase normalisatie
// ------------------------------
function normalizePhase(phase) {
  const p = String(phase || "").toUpperCase();
  if (p.includes("MOVE")) return "MOVE";
  if (p.includes("OPS")) return "OPS";
  if (p.includes("ACTIONS") || p.includes("ACTION")) return "OPS"; // jouw game gebruikt ACTIONS
  if (p.includes("DEC")) return "DECISION";
  if (p.includes("RES") || p.includes("REVEAL")) return "RESOLVE";
  return "UNKNOWN";
}

// ------------------------------
// Hand -> action names (strings of objects)
// ------------------------------
function normalizeActionName(x) {
  const name =
    typeof x === "string" ? x :
    (x?.name || x?.id || x?.cardId || "");
  return String(name).trim();
}

function getHandActionNames(me) {
  const hand = Array.isArray(me?.hand) ? me.hand : [];
  return hand.map(normalizeActionName).filter(Boolean);
}

function getKnownHandActions(me) {
  const names = getHandActionNames(me);
  return names.map((n) => ({
    name: n,
    def: getActionDefByName(n),
    info: getActionInfoByName(n),
  }));
}

function summarizeHandRecognition(me) {
  const names = getHandActionNames(me);
  const known = getKnownHandActions(me)
    .filter((x) => x.def || x.info)
    .map((x) => x.name);

  const unknown = names.filter((n) => !known.includes(n));

  return {
    names,
    known,
    unknown,
    lineHand: names.length ? `Hand: ${names.join(", ")}` : "Hand: —",
    lineKnown: known.length ? `Herkenning: ${known.join(", ")}` : "Herkenning: —",
    lineUnknown: unknown.length ? `Onbekend: ${unknown.join(", ")}` : null,
  };
}

// ------------------------------
// Headerregels
// ------------------------------
function headerLines(view, upcoming) {
  const ids = (upcoming || []).map((e) => e.id).filter(Boolean);
  return [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    `Opkomend: ${ids.length ? ids.join(" → ") : "—"}`,
  ];
}

// ------------------------------
// Profiel-variant (def/agg) via weights
// (werkt direct met jouw scoring.js, zonder extra wijzigingen)
// ------------------------------
function deriveProfile(baseProfile, style) {
  const p = baseProfile || {};
  const w = p.weights || {};

  if (style === "DEFENSIVE") {
    return {
      ...p,
      weights: {
        ...w,
        loot: (w.loot ?? 1.0) * 0.90,
        risk: (w.risk ?? 1.0) * 1.25,
        conserve: (w.conserve ?? 0.0) * 1.20,
        conserveOps: (w.conserveOps ?? 0.0) + 0.15,
      },
    };
  }

  if (style === "AGGRESSIVE") {
    return {
      ...p,
      weights: {
        ...w,
        loot: (w.loot ?? 1.0) * 1.25,
        risk: (w.risk ?? 1.0) * 0.85,
        conserve: (w.conserve ?? 0.0) * 0.80,
        conserveOps: (w.conserveOps ?? 0.0) - 0.10,
      },
    };
  }

  return p;
}

function safeBest(ranked, fallback) {
  return (Array.isArray(ranked) && ranked.length ? ranked[0] : null) || fallback;
}

function labelPlay(x) {
  if (!x) return "PASS";
  if (x.play === "PASS") return "PASS";
  return `Speel: ${x.cardId || x.cardName || x.name || "?"}`;
}

function labelMove(x) {
  return x?.move || "—";
}

function labelDecision(x) {
  return x?.decision || "—";
}

// ------------------------------
// Main hint
// ------------------------------
export function getAdvisorHint({
  game,
  me,
  players,
  actions = [],
  profileKey = "BEGINNER_COACH",
}) {
  const baseProfile =
    ADVISOR_PROFILES[profileKey] || ADVISOR_PROFILES.BEGINNER_COACH;

  const profileDef = deriveProfile(baseProfile, "DEFENSIVE");
  const profileAgg = deriveProfile(baseProfile, "AGGRESSIVE");

  const view = buildPlayerView({ game, me, players, actions });
  const upcoming = getUpcomingEvents(view, 2);
  const phase = normalizePhase(view.phase);

  // --- altijd: hand normaliseren voor scoring + debug ---
  const handMeta = summarizeHandRecognition(view.me || me || {});

  // scoring-safe hand: array van objects {id,name}
  if (view?.me) {
    view.me.handNames = handMeta.names;
    view.me.handKnown = handMeta.known;
    view.me.handUnknown = handMeta.unknown;
    view.me.hand = handMeta.names.map((n) => ({ id: n, name: n }));
  }

  // =======================
  // MOVE (2 adviezen)
  // =======================
  if (phase === "MOVE") {
    const rankedDef = scoreMoveMoves({ view, upcoming, profile: profileDef }) || [];
    const rankedAgg = scoreMoveMoves({ view, upcoming, profile: profileAgg }) || [];

    const bestDef = safeBest(rankedDef, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });
    const bestAgg = safeBest(rankedAgg, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });

    return {
      title: `MOVE advies • Def: ${labelMove(bestDef)} • Agg: ${labelMove(bestAgg)}`,
      confidence: Math.max(bestDef.confidence ?? 0.65, bestAgg.confidence ?? 0.65),
      risk: "MIX",
      bullets: [
        ...headerLines(view, upcoming),
        `DEFENSIEF: ${labelMove(bestDef)} (${bestDef.riskLabel ?? "?"})`,
        ...(bestDef.bullets || []),
        `AANVALLEND: ${labelMove(bestAgg)} (${bestAgg.riskLabel ?? "?"})`,
        ...(bestAgg.bullets || []),
      ].filter(Boolean).slice(0, 10),
      alternatives: [
        { mode: "DEF alt", pick: rankedDef[1]?.move },
        { mode: "AGG alt", pick: rankedAgg[1]?.move },
      ].filter((x) => x.pick),
      debug: { phase: view.phase, rankedDef, rankedAgg, hand: handMeta },
    };
  }

  // =======================
  // OPS (2 adviezen)
  // =======================
  if (phase === "OPS") {
    const defRanked = scoreOpsPlays({ view, upcoming, profile: profileDef, style: "DEFENSIVE" }) || [];
    const aggRanked = scoreOpsPlays({ view, upcoming, profile: profileAgg, style: "AGGRESSIVE" }) || [];

    const bestDef = safeBest(defRanked, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });
    const bestAgg = safeBest(aggRanked, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });

    const labelDef = labelPlay(bestDef);
    const labelAgg = labelPlay(bestAgg);

    return {
      title: `OPS advies • Def: ${labelDef} • Agg: ${labelAgg}`,
      confidence: Math.max(bestDef.confidence ?? 0.65, bestAgg.confidence ?? 0.65),
      risk: "MIX",
      bullets: [
        ...headerLines(view, upcoming),
        handMeta.lineHand,
        handMeta.lineKnown,
        ...(handMeta.lineUnknown ? [handMeta.lineUnknown] : []),

        `DEFENSIEF: ${labelDef} (${bestDef.riskLabel ?? "?"})`,
        ...(bestDef.bullets || []),

        `AANVALLEND: ${labelAgg} (${bestAgg.riskLabel ?? "?"})`,
        ...(bestAgg.bullets || []),
      ].filter(Boolean).slice(0, 10),
      alternatives: [
        {
          mode: "DEF alt",
          pick: defRanked[1]
            ? (defRanked[1].play === "PASS" ? "PASS" : defRanked[1].cardId)
            : null,
        },
        {
          mode: "AGG alt",
          pick: aggRanked[1]
            ? (aggRanked[1].play === "PASS" ? "PASS" : aggRanked[1].cardId)
            : null,
        },
      ].filter((x) => x.pick),
      debug: { phase: view.phase, bestDef, bestAgg, defRanked, aggRanked, hand: handMeta },
    };
  }

  // =======================
  // DECISION (2 adviezen)
  // =======================
  if (phase === "DECISION") {
    const rankedDef = scoreDecisions({ view, upcoming, profile: profileDef }) || [];
    const rankedAgg = scoreDecisions({ view, upcoming, profile: profileAgg }) || [];

    const bestDef = safeBest(rankedDef, { decision: "—", riskLabel: "MED" });
    const bestAgg = safeBest(rankedAgg, { decision: "—", riskLabel: "MED" });

    const extraBurrowWarn =
      bestDef.decision === "BURROW" && (view.me?.burrowRemaining ?? 1) === 1
        ? ["Let op: BURROW is schaars (1x per Raid). Alleen doen als het echt nodig is."]
        : [];

    return {
      title: `Decision advies • Def: ${labelDecision(bestDef)} • Agg: ${labelDecision(bestAgg)}`,
      confidence: 0.7,
      risk: "MIX",
      bullets: [
        ...headerLines(view, upcoming),
        ...extraBurrowWarn,
        `DEFENSIEF: ${labelDecision(bestDef)} (${bestDef.riskLabel ?? "?"})`,
        `AANVALLEND: ${labelDecision(bestAgg)} (${bestAgg.riskLabel ?? "?"})`,
      ].filter(Boolean).slice(0, 6),
      alternatives: [
        { mode: "DEF alt", pick: rankedDef[1]?.decision },
        { mode: "AGG alt", pick: rankedAgg[1]?.decision },
      ].filter((x) => x.pick),
      debug: { phase: view.phase, rankedDef, rankedAgg, hand: handMeta },
    };
  }

  // fallback
  return {
    title: "Hint",
    confidence: 0.6,
    risk: "MED",
    bullets: [...headerLines(view, upcoming), handMeta.lineHand, "Geen fase herkend."].slice(0, 6),
    alternatives: [],
    debug: { phase: view.phase, hand: handMeta },
  };
}
