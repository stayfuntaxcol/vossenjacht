// /bots/advisor/advisorBot.js

import { getActionDefByName, getActionInfoByName } from "../../cards.js"; // pas pad aan indien nodig

import { ADVISOR_PROFILES } from "../core/botConfig.js";
import { buildPlayerView } from "../core/stateView.js";
import { getUpcomingEvents } from "../core/eventIntel.js";
import {
  scoreMoveMoves,
  scoreOpsPlays,
  scoreDecisions,
} from "../core/scoring.js";

// =====================
// Action-hand helpers
// =====================
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

// =====================
// Generic helpers
// =====================
function normalizePhase(phase) {
  const p = String(phase || "").toUpperCase();
  if (p.includes("MOVE")) return "MOVE";
  if (p.includes("ACTIONS") || p.includes("ACTION") || p.includes("OPS")) return "OPS";
  if (p.includes("DEC")) return "DECISION";
  if (p.includes("RES") || p.includes("REVEAL")) return "RESOLVE";
  return "UNKNOWN";
}

function headerLines(view, upcoming) {
  const ids = (upcoming || []).map((e) => e.id).filter(Boolean);
  return [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    `Opkomend: ${ids.length ? ids.join(" → ") : "—"}`,
  ];
}

// =====================
// Main export
// =====================
export function getAdvisorHint({
  game,
  me,
  players,
  actions = [],
  profileKey = "BEGINNER_COACH",
}) {
  const profile =
    ADVISOR_PROFILES[profileKey] || ADVISOR_PROFILES.BEGINNER_COACH;

  const view = buildPlayerView({ game, me, players, actions });
  const upcoming = getUpcomingEvents(view, 2);
  const phase = normalizePhase(view.phase);

  // (optioneel) debug: welke Action Cards herkent hij?
  const knownHand = getKnownHandActions(me);

  // MOVE
  if (phase === "MOVE") {
    const ranked = scoreMoveMoves({ view, upcoming, profile });
    const best = ranked[0];

    return {
      title: `MOVE advies: ${best.move}`,
      confidence: best.confidence ?? 0.72,
      risk: best.riskLabel ?? "LOW",
      bullets: [...headerLines(view, upcoming), ...(best.bullets || [])].slice(0, 6),
      alternatives: ranked.slice(1, 3).map((o) => ({ move: o.move, risk: o.riskLabel })),
      debug: { phase: view.phase, ranked, knownHand },
    };
  }

  // OPS
  if (phase === "OPS") {
    const ranked = scoreOpsPlays({ view, upcoming, profile });
    const best = ranked[0];

    const label = best.play === "PASS" ? "PASS" : `Speel: ${best.cardId}`;

    return {
      title: `OPS advies: ${label}`,
      confidence: best.confidence ?? 0.7,
      risk: "LOW",
      bullets: [...headerLines(view, upcoming), ...(best.bullets || [])].slice(0, 6),
      alternatives: ranked.slice(1, 3).map((o) => ({
        play: o.play === "PASS" ? "PASS" : `PLAY ${o.cardId}`,
      })),
      debug: { phase: view.phase, ranked, knownHand },
    };
  }

  // DECISION
  if (phase === "DECISION") {
    const ranked = scoreDecisions({ view, upcoming, profile });
    const best = ranked[0];

    const bullets = [
      ...headerLines(view, upcoming),
      `Risico-inschatting: ${best.riskLabel}`,
      ...(best.bullets || []),
    ].filter(Boolean);

    return {
      title: `Decision advies: ${best.decision}`,
      confidence: 0.7,
      risk: best.riskLabel ?? "MED",
      bullets: bullets.slice(0, 6),
      alternatives: ranked.slice(1, 3).map((o) => ({ decision: o.decision, risk: o.riskLabel })),
      debug: { phase: view.phase, ranked, knownHand },
    };
  }

  // fallback
  return {
    title: "Hint",
    confidence: 0.6,
    risk: "MED",
    bullets: [...headerLines(view, upcoming), "Geen fase herkend."].slice(0, 6),
    alternatives: [],
    debug: { phase: view.phase, knownHand },
  };
}
