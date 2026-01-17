// js/bots/advisor/advisor.js
import { computeCarryValue, computeDangerMetrics } from "../core/metrics.js";

export function getAdvisorHint({ game, me, players, phase, flagsRound, intel }) {
  const carryValue = Number(computeCarryValue(me) ?? 0);

  let metrics = null;
  try {
    metrics = computeDangerMetrics({
      game,
      player: me,
      players: Array.isArray(players) ? players : [],
      flagsRound: flagsRound || game?.flagsRound || {},
      intel: intel || {
        knownUpcomingEvents: Array.isArray(me?.knownUpcomingEvents)
          ? me.knownUpcomingEvents.filter(Boolean)
          : [],
      },
    });
  } catch (e) {
    metrics = null;
  }

  // TODO: per fase echte adviezen (MOVE / ACTIONS / DECISION)
  return {
    top: phase === "DECISION" ? "Overweeg DASH bij hoge carry + hoge danger" : "Speel rustig",
    why: [
      `carryValue: ${carryValue}`,
      `dangerScore: ${Number(metrics?.dangerScore ?? 0)}`,
      `confidence: ${Number(metrics?.confidence ?? 0)}`,
    ],
    alternatives: [],
    meters: {
      risk: Number(metrics?.dangerScore ?? 0),
      lootTempo: Math.min(10, Math.max(0, Math.round(carryValue / 2))),
    },
    debug: {
      nextEventIdUsed: metrics?.nextEventIdUsed ?? null,
      pDanger: metrics?.pDanger ?? null,
    },
  };
}
