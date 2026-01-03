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

  // Tags die "yard" gevaarlijk maken (als jij een yard-status hebt, kun je dat meenemen)
  if (hasTag(upcoming, "CATCH_ALL_YARD")) {
    // Vaak is BURROW veiliger dan DASH in zo'n event-window
    if (decision === "DASH") risk += 0.25;
    if (decision === "LURK") risk += 0.15;
  }

  // BURROW BEPERKING
  function conservePenalty(decision, view) {
  if (decision !== "BURROW") return 0;

  const rem = view.me?.burrowRemaining ?? 1;

  // Als BURROW op is: maak het praktisch onmogelijk
  if (rem <= 0) return 999;

  // Als je nog maar 1 BURROW hebt, is die “kostbaar”
  // penalty zorgt dat hij niet standaard in ronde 1 geroepen wordt
  if (rem === 1) return 0.55;

  return 0.25; // meerdere charges: kleine penalty
}

  // Voorbeeld: lockEvents betekent vaak dat SHIFT/peek niet kan; voor decision is dat indirect.
  if (view.flags?.lockEvents && decision === "DASH") risk += 0.10;

  return clamp01(risk);
}

function flexibility(decision) {
  // BURROW is vaak “veilig & flexibel”
  if (decision === "BURROW") return 0.8;
  if (decision === "LURK") return 0.6;
  return 0.3; // DASH commit
}

function riskLabel(risk01) {
  if (risk01 < 0.35) return "LOW";
  if (risk01 < 0.65) return "MED";
  return "HIGH";
}

const conserve = conservePenalty(decision, view);

const score =
  w.loot * loot -
  w.risk * risk +
  w.flexibility * flex -
  (w.conserve || 0) * conserve +
  w.synergy * 0.0;

export function scoreDecisions({ view, upcoming, profile }) {
  const w = profile.weights;

  const options = ["LURK", "BURROW", "DASH"].map((decision) => {
    const loot = baseLoot(decision);
    const risk = baseRisk(decision, view, upcoming);
    const flex = flexibility(decision);

    const score =
      w.loot * loot -
      w.risk * risk +
      w.flexibility * flex +
      w.synergy * 0.0; // later: den/event synergie

    return {
      type: "DECISION",
      decision,
      score,
      components: { loot, risk, flex },
      riskLabel: riskLabel(risk),
    };
  });

  options.sort((a, b) => b.score - a.score);
  return options;
}
