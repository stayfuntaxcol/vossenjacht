// /bots/core/scoring.js
import { hasTag } from "./eventIntel.js";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// Heuristiek loot-basis (pas aan naar jouw spelbalans)
function baseLoot(decision) {
  if (decision === "DASH") return 1.0;
  if (decision === "BURROW") return 0.6;
  return 0.3; // LURK
}

// Heuristiek risico op basis van event tags + flags
function baseRisk(decision, view, upcoming) {
  let risk = 0.15;

  if (decision === "DASH") risk += 0.35;
  if (decision === "BURROW") risk += 0.10;
  if (decision === "LURK") risk += 0.05;

  // Tags die DASH gevaarlijk maken
  if (decision === "DASH" && hasTag(upcoming, "CATCH_DASHERS")) risk += 0.45;

  // Tags die "yard" gevaarlijk maken
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

function riskLabel(risk01) {
  if (risk01 < 0.35) return "LOW";
  if (risk01 < 0.65) return "MED";
  return "HIGH";
}

// Nieuw: “spaar BURROW” (schaarste) + illegal als op
function conservePenalty(decision, view) {
  if (decision !== "BURROW") return 0;

  const rem = view?.me?.burrowRemaining ?? 1;

  // BURROW op = praktisch onmogelijk adviseren
  if (rem <= 0) return 999;

  // Laatste BURROW is kostbaar: flinke penalty zodat hij niet default ronde 1 wordt
  if (rem === 1) return 0.55;

  return 0.25;
}

export function scoreDecisions({ view, upcoming, profile }) {
  const w = profile?.weights || {};

  const options = ["LURK", "BURROW", "DASH"]
    // Filter BURROW weg als hij niet meer kan
    .filter(
      (d) => d !== "BURROW" || (view?.me?.burrowRemaining ?? 1) > 0
    )
    .map((decision) => {
      const loot = baseLoot(decision);
      const risk = baseRisk(decision, view, upcoming);
      const flex = flexibility(decision);
      const conserve = conservePenalty(decision, view);

      const score =
        (w.loot ?? 1.0) * loot -
        (w.risk ?? 1.0) * risk +
        (w.flexibility ?? 0.0) * flex -
        (w.conserve ?? 0.0) * conserve +
        (w.synergy ?? 0.0) * 0.0; // later uitbreiden

      return {
        type: "DECISION",
        decision,
        score,
        components: { loot, risk, flex, conserve },
        riskLabel: riskLabel(risk),
      };
    });

  options.sort((a, b) => b.score - a.score);
  return options;
}
