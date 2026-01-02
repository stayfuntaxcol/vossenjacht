import { ADVISOR_PROFILES } from "../core/botConfig.js";
import { buildPlayerView } from "../core/stateView.js";
import { getUpcomingEvents } from "../core/eventIntel.js";
import { scoreDecisions } from "../core/scoring.js";

function confidenceFromGap(best, second) {
  if (!second) return 0.75;
  const gap = best.score - second.score;
  // simpele mapping
  if (gap > 0.9) return 0.9;
  if (gap > 0.5) return 0.8;
  if (gap > 0.25) return 0.7;
  return 0.6;
}

function buildExplanation(best, upcoming) {
  const bullets = [];

  if (best.decision === "BURROW") {
    bullets.push("BURROW houdt je veilig én flexibel deze ronde.");
  }
  if (best.decision === "DASH") {
    bullets.push("DASH kan veel opleveren, maar is vaak het meest riskant.");
  }
  if (best.decision === "LURK") {
    bullets.push("LURK is low-risk: je wacht af en verzamelt info via het spelverloop.");
  }

  // Event-based hints (op basis van tags)
  const ids = upcoming.map((e) => e.id).filter(Boolean);
  if (ids.length) bullets.push(`Let op: opkomende events: ${ids.join(" → ")}`);

  // Risk component
  bullets.push(`Inschatting risico voor ${best.decision}: ${best.riskLabel}`);

  return bullets.slice(0, 4);
}

export function getAdvisorHint({
  game,
  me,
  players,
  profileKey = "BEGINNER_COACH",
}) {
  const profile = ADVISOR_PROFILES[profileKey] || ADVISOR_PROFILES.BEGINNER_COACH;

  const view = buildPlayerView({ game, me, players });
  const upcoming = getUpcomingEvents(view, 2);

  const ranked = scoreDecisions({ view, upcoming, profile });
  const best = ranked[0];
  const second = ranked[1];

  const confidence = confidenceFromGap(best, second);

  return {
    title: `Advies: ${best.decision}`,
    confidence,
    risk: best.riskLabel,
    bullets: buildExplanation(best, upcoming),
    alternatives: ranked.slice(1, 3).map((o) => ({
      decision: o.decision,
      risk: o.riskLabel,
    })),
    debug: {
      profile: profile.name,
      ranked,
      upcoming,
      phase: view.phase,
      round: view.round,
    },
  };
}
