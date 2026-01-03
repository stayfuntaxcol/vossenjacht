// /bots/advisor/advisorBot.js
// Router voor hints per fase (OPS / DECISION / RESOLVE) + action card suggestie

import { ADVISOR_PROFILES } from "../core/botConfig.js";
import { buildPlayerView } from "../core/stateView.js";
import { getUpcomingEvents } from "../core/eventIntel.js";
import {
  scoreDecisions,
  scoreOpsMoves,
  scoreActionCardsNow,
} from "../core/scoring.js";

function normalizePhase(phase) {
  const p = String(phase || "").toUpperCase();

  // Veel voorkomende varianten in jullie codebase
  if (p.includes("OPS")) return "OPS";
  if (p.includes("ACTION")) return "OPS";
  if (p.includes("RAID")) return "OPS";

  if (p.includes("DEC")) return "DECISION";
  if (p.includes("DECISION")) return "DECISION";

  if (p.includes("RES")) return "RESOLVE";
  if (p.includes("RESOLVE")) return "RESOLVE";

  return "UNKNOWN";
}

function bulletsHeader(view, upcoming) {
  const items = (upcoming || []).map((e) => e.id).filter(Boolean);
  const line = items.length ? items.join(" → ") : "—";
  return [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    `Opkomend: ${line}`,
  ];
}

function buildActionCardRecommendation({ view, upcoming, profile }) {
  const cardsRanked = scoreActionCardsNow({ view, upcoming, profile });
  const best = cardsRanked && cardsRanked.length ? cardsRanked[0] : null;

  if (!best) return null;

  return {
    id: best.cardId,
    bullets: Array.isArray(best.bullets) ? best.bullets : [],
    score: best.score,
  };
}

export function getAdvisorHint({
  game,
  me,
  players,
  profileKey = "BEGINNER_COACH",
}) {
  const profile =
    ADVISOR_PROFILES[profileKey] || ADVISOR_PROFILES.BEGINNER_COACH;

  const view = buildPlayerView({ game, me, players });
  const upcoming = getUpcomingEvents(view, 2);
  const phase = normalizePhase(view.phase);

  // -------------------------
  // OPS (SNATCH/FORRAGE/SCOUT/SHIFT + evt action card)
  // -------------------------
  if (phase === "OPS") {
    const opsRanked = scoreOpsMoves({ view, upcoming, profile });
    const bestOps = opsRanked && opsRanked.length ? opsRanked[0] : null;

    const actionCard = buildActionCardRecommendation({ view, upcoming, profile });

    if (!bestOps) {
      return {
        title: "OPS advies: —",
        confidence: 0.55,
        risk: "MED",
        bullets: [
          ...bulletsHeader(view, upcoming),
          "Ik kan nog geen OPS advies maken (geen opties gevonden).",
        ],
        recommendations: { ops: null, actionCard },
        alternatives: [],
        debug: { phase: view.phase, opsRanked, upcoming },
      };
    }

    const bullets = [
      ...bulletsHeader(view, upcoming),
      ...(bestOps.bullets || []),
    ];

    // Voeg target info toe als SNATCH een target heeft
    if (bestOps.move === "SNATCH" && bestOps.target?.name) {
      bullets.push(`Aanbevolen target: ${bestOps.target.name}`);
    }

    // Voeg action card tip toe (kort)
    if (actionCard?.id) {
      bullets.push(`Speel (optioneel) Action Card: ${actionCard.id}`);
    }

    return {
      title: `OPS advies: ${bestOps.move}`,
      confidence: bestOps.confidence ?? 0.68,
      risk: bestOps.riskLabel ?? "MED",
      bullets: bullets.slice(0, 6),
      recommendations: {
        ops: bestOps,
        actionCard: actionCard
          ? { id: actionCard.id, why: actionCard.bullets }
          : null,
      },
      alternatives: (opsRanked || [])
        .slice(1, 3)
        .map((o) => ({ move: o.move, risk: o.riskLabel })),
      debug: { phase: view.phase, opsRanked, upcoming },
    };
  }

  // -------------------------
  // DECISION (LURK/BURROW/DASH)
  // -------------------------
  if (phase === "DECISION") {
    const ranked = scoreDecisions({ view, upcoming, profile });
    const best = ranked && ranked.length ? ranked[0] : null;

    if (!best) {
      return {
        title: "Decision advies: —",
        confidence: 0.55,
        risk: "MED",
        bullets: [
          ...bulletsHeader(view, upcoming),
          "Ik kan nog geen Decision advies maken (geen opties gevonden).",
        ],
        alternatives: [],
        debug: { phase: view.phase, ranked, upcoming },
      };
    }

    const bullets = [
      ...bulletsHeader(view, upcoming),
      ...(best.decision === "BURROW" && (view.me?.burrowRemaining ?? 1) === 1
        ? ["Let op: BURROW is schaars (1x per Raid). Alleen doen als het echt nodig is."]
        : []),
      `Risico-inschatting: ${best.riskLabel}`,
    ];

    return {
      title: `Decision advies: ${best.decision}`,
      confidence: 0.7,
      risk: best.riskLabel ?? "MED",
      bullets: bullets.slice(0, 6),
      alternatives: (ranked || [])
        .slice(1, 3)
        .map((o) => ({ decision: o.decision, risk: o.riskLabel })),
      debug: { phase: view.phase, ranked, upcoming },
    };
  }

  // -------------------------
  // RESOLVE / UNKNOWN: geef algemene tip (en action card suggestie als die “nu” nog kan)
  // -------------------------
  const actionCard = buildActionCardRecommendation({ view, upcoming, profile });

  return {
    title: "Hint",
    confidence: 0.6,
    risk: "MED",
    bullets: [
      ...bulletsHeader(view, upcoming),
      "Geen specifieke fase gedetecteerd. Gebruik OPS voor value (FORRAGE/SCOUT) en bewaar high-risk keuzes voor wanneer het echt loont.",
      ...(actionCard?.id ? [`Action Card (optioneel): ${actionCard.id}`] : []),
    ].slice(0, 6),
    recommendations: {
      actionCard: actionCard ? { id: actionCard.id, why: actionCard.bullets } : null,
    },
    alternatives: [],
    debug: { phase: view.phase, upcoming },
  };
}
