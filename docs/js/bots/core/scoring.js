// /bots/core/scoring.js
import { hasTag } from "./eventIntel.js";

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function riskLabel(r) {
  if (r < 0.35) return "LOW";
  if (r < 0.65) return "MED";
  return "HIGH";
}

// --------------------
// DECISION scoring
// --------------------
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
    .filter(d => d !== "BURROW" || (view?.me?.burrowRemaining ?? 1) > 0)
    .map((decision) => {
      const loot = baseLoot(decision);
      const risk = baseRisk(decision, view, upcoming);
      const flex = flexibility(decision);
      const conserve = conservePenalty(decision, view);

      const score =
        (w.loot ?? 1) * loot -
        (w.risk ?? 1) * risk +
        (w.flexibility ?? 0) * flex -
        (w.conserve ?? 0) * conserve;

      return { type: "DECISION", decision, score, riskLabel: riskLabel(risk) };
    });

  options.sort((a, b) => b.score - a.score);
  return options;
}

// --------------------
// OPS scoring (SNATCH / FORRAGE / SCOUT / SHIFT)
// --------------------
// Aannames (MVP):
// - FORRAGE = veilige loot
// - SNATCH = loot swing (beter als tegenstander veel loot heeft)
// - SCOUT = info voordeel (beter bij onzekere/upcoming gevaarlijke events)
// - SHIFT = track manipuleren (nul als lockEvents true)

function bestSnatchTarget(view) {
  const list = view.playersPublic || [];
  let best = null;
  for (const p of list) {
    const loot = Number(p.loot);
    if (!Number.isFinite(loot)) continue;
    if (!best || loot > best.loot) best = { id: p.id, name: p.name, loot };
  }
  return best;
}

export function scoreOpsMoves({ view, upcoming, profile }) {
  const w = profile?.weights || {};
  const lock = !!view.flags?.lockEvents;

  const target = bestSnatchTarget(view);
  const targetLoot = target?.loot ?? 0;

  const candidates = ["FORRAGE", "SNATCH", "SCOUT", "SHIFT"].map((move) => {
    let loot = 0, risk = 0.15, info = 0, control = 0;
    const bullets = [];

    if (move === "FORRAGE") {
      loot = 0.7;
      risk += 0.05;
      bullets.push("FORRAGE is stabiel: je pakt value zonder veel gedoe.");
    }

    if (move === "SNATCH") {
      loot = 0.4 + clamp01(targetLoot / 6); // schaal met target loot
      risk += 0.20;
      bullets.push(target ? `SNATCH is interessant: ${target.name} heeft veel loot.` : "SNATCH is swingy: kies een target met veel loot.");
    }

    if (move === "SCOUT") {
      info = 0.9;
      risk += 0.05;
      bullets.push("SCOUT geeft info-voordeel: beter beslissen later deze ronde.");
      if (hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD")) {
        info += 0.3;
        bullets.push("Extra waarde: er komen mogelijk gevaarlijke events aan → info is goud.");
      }
    }

    if (move === "SHIFT") {
      if (lock) {
        control = 0;
        risk = 0.05;
        bullets.push("SHIFT kan nu niet: Events zijn gelocked.");
      } else {
        control = 0.9;
        risk += 0.10;
        bullets.push("SHIFT kan het event-verloop verbeteren (of anderen in verwarring brengen).");
        if (hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD")) {
          control += 0.3;
          bullets.push("Extra waarde: je kunt een gevaarlijk event-window proberen te verplaatsen.");
        }
      }
    }

    // simpele score: loot + info + control minus risk
    const score =
      (w.loot ?? 1) * loot +
      0.9 * info +
      0.9 * control -
      (w.risk ?? 1) * risk;

    return {
      type: "OPS",
      move,
      score,
      riskLabel: riskLabel(clamp01(risk)),
      confidence: 0.68,
      bullets: bullets.slice(0, 4),
      target: move === "SNATCH" ? target : null,
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// --------------------
// Action Card scoring (welke nú spelen)
// --------------------
// MVP: tag-based. Jij breidt uit met echte kaart-IDs.
// moment filtering doe je later; nu adviseren we “beste NU”.

const ACTION_TAGS = {
  MOLTING_MASK: ["DEN_SWAP"],
  SCENT_CHECK: ["INFO_DECISION"],
  FOLLOW_THE_TAIL: ["COPY_DECISION_LATER"],
  PACK_TINKER: ["TRACK_MANIP"],
  KICK_UP_DUST: ["CHAOS", "ANTI_DOG"], // voorbeeld
};

export function scoreActionCardsNow({ view, upcoming, profile }) {
  const hand = view?.me?.hand || [];
  const lock = !!view.flags?.lockEvents;

  const scored = hand.map((cardId) => {
    const tags = ACTION_TAGS[cardId] || [];
    let value = 0.2;
    const bullets = [];

    if (tags.includes("INFO_DECISION")) {
      value += 0.7;
      bullets.push("Info kaart: sterker als je onzeker bent wat anderen doen.");
      if (hasTag(upcoming, "CATCH_DASHERS")) value += 0.2;
    }

    if (tags.includes("TRACK_MANIP")) {
      if (lock) {
        value -= 0.6;
        bullets.push("Track-manip werkt slecht/ niet: events zijn gelocked.");
      } else {
        value += 0.6;
        bullets.push("Track-manip: sterk als er gevaarlijke events aankomen.");
        if (hasTag(upcoming, "CATCH_DASHERS") || hasTag(upcoming, "CATCH_ALL_YARD")) value += 0.3;
      }
    }

    if (tags.includes("DEN_SWAP")) {
      value += 0.35;
      bullets.push("Den-swap: goed als jouw huidige den je nu benadeelt.");
    }

    if (tags.includes("COPY_DECISION_LATER")) {
      value += 0.25;
      bullets.push("Copy-decision: handig als je 1 speler vertrouwt als 'leading indicator'.");
    }

    return {
      type: "ACTION",
      cardId,
      score: value,
      bullets: bullets.slice(0, 3),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
