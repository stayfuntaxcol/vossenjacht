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
  if (p.includes("ACTION")) return "OPS";      // <-- belangrijk (jouw game gebruikt ACTIONS)
  if (p.includes("DEC")) return "DECISION";
  if (p.includes("RES")) return "RESOLVE";
  if (p.includes("REVEAL")) return "RESOLVE";
  return "UNKNOWN";
}

// ------------------------------
// Hand -> action names (strings of objects)
// ------------------------------
function normalizeActionName(x) {
  const name = typeof x === "string" ? x : (x?.name || x?.id || "");
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
  const known = getKnownHandActions(me).filter((x) => x.def || x.info).map((x) => x.name);

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
// Main hint
// ------------------------------
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

  // --- altijd: hand normaliseren voor scoring + debug ---
  const handMeta = summarizeHandRecognition(view.me || me || {});
  // Forceer een “scoring-safe” hand: array van {name,id}
  // (belangrijk als je Firestore hand strings opslaat)
  if (view?.me) {
    view.me.handNames = handMeta.names;
    view.me.handKnown = handMeta.known;
    view.me.handUnknown = handMeta.unknown;
    view.me.hand = handMeta.names.map((n) => ({ id: n, name: n }));
  }

  // MOVE
  if (phase === "MOVE") {
    const ranked = scoreMoveMoves({ view, upcoming, profile }) || [];
    const best = ranked[0] || { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" };

    return {
      title: `MOVE advies: ${best.move}`,
      confidence: best.confidence ?? 0.72,
      risk: best.riskLabel ?? "LOW",
      bullets: [...headerLines(view, upcoming), ...(best.bullets || [])].slice(0, 6),
      alternatives: ranked.slice(1, 3).map((o) => ({ move: o.move, risk: o.riskLabel })),
      debug: { phase: view.phase, ranked, hand: handMeta },
    };
  }

  // OPS (Action Cards / PASS)
  if (phase === "OPS") {
    const ranked = scoreOpsPlays({ view, upcoming, profile }) || [];
    const best = ranked[0];

    // Als scorer niks teruggeeft: geef meteen nuttige debug
    if (!ranked.length || !best) {
      const bullets = [
        ...headerLines(view, upcoming),
        handMeta.lineHand,
        handMeta.lineKnown,
        ...(handMeta.lineUnknown ? [handMeta.lineUnknown] : []),
        "Ik kan nu geen kaart-score maken. Check of je card-namen exact matchen met ACTION_DEFS in cards.js.",
      ].slice(0, 6);

      return {
        title: "OPS advies: PASS",
        confidence: 0.6,
        risk: "MED",
        bullets,
        alternatives: [],
        debug: { phase: view.phase, ranked, hand: handMeta },
      };
    }

    const bestCardId = best.cardId || best.cardName || best.name || "";
    const label = best.play === "PASS" ? "PASS" : `Speel: ${bestCardId}`;

    const bullets = [
      ...headerLines(view, upcoming),
      handMeta.lineHand,
      handMeta.lineKnown,
      ...(handMeta.lineUnknown ? [handMeta.lineUnknown] : []),
      ...(best.bullets || []),
    ].slice(0, 6);

    return {
      title: `OPS advies: ${label}`,
      confidence: best.confidence ?? 0.7,
      risk: best.riskLabel ?? "LOW",
      bullets,
      alternatives: ranked.slice(1, 3).map((o) => ({
        play: o.play === "PASS" ? "PASS" : `PLAY ${o.cardId || o.cardName || o.name || "?"}`,
      })),
      debug: { phase: view.phase, ranked, hand: handMeta },
    };
  }

  // DECISION
  if (phase === "DECISION") {
    const ranked = scoreDecisions({ view, upcoming, profile }) || [];
    const best = ranked[0] || { decision: "—", riskLabel: "MED" };

    const bullets = [
      ...headerLines(view, upcoming),
      ...(best.decision === "BURROW" && (view.me?.burrowRemaining ?? 1) === 1
        ? ["Let op: BURROW is schaars (1x per Raid). Alleen doen als het echt nodig is."]
        : []),
      `Risico-inschatting: ${best.riskLabel}`,
    ].slice(0, 6);

    return {
      title: `Decision advies: ${best.decision}`,
      confidence: 0.7,
      risk: best.riskLabel ?? "MED",
      bullets,
      alternatives: ranked.slice(1, 3).map((o) => ({ decision: o.decision, risk: o.riskLabel })),
      debug: { phase: view.phase, ranked, hand: handMeta },
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
