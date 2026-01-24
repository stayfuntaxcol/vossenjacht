// docs/js/bots/aiKit.js

import {
  RULES_INDEX,
  buildRulesIndex,
  getEventFacts as baseGetEventFacts,
  getActionFacts,
} from "./rulesIndex.js";

import {
  BOT_WEIGHTS,
  scoreEventFacts,
  scoreActionFacts,
  rankActions,
} from "./botHeuristics.js";

export {
  RULES_INDEX,
  buildRulesIndex,
  getActionFacts,
  BOT_WEIGHTS,
  scoreEventFacts,
  scoreActionFacts,
  rankActions,
};

// -------- helpers --------
const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];
const norm = (x) => String(x || "").trim().toUpperCase();

function inferTargetDenColor(eventId, facts) {
  const id = norm(eventId);

  // DEN_<COLOR>
  if (id.startsWith("DEN_")) {
    const c = norm(id.slice(4));
    if (DEN_COLORS.includes(c)) return c;
  }

  // fallback fields
  const direct = norm(facts?.targetDenColor || facts?.denColor || facts?.color);
  if (DEN_COLORS.includes(direct)) return direct;

  // last fallback: scan text-ish fields
  const blob = `${facts?.title || ""} ${facts?.name || ""} ${facts?.text || ""} ${facts?.desc || ""} ${(facts?.notes || []).join(" ")}`.toUpperCase();
  for (const c of DEN_COLORS) if (blob.includes(c)) return c;

  return null;
}

function zeroAllDangerKeys(out) {
  if (!out || typeof out !== "object") return;
  for (const k of Object.keys(out)) {
    if (k.startsWith("danger")) out[k] = 0;
  }
}

function zeroAllPenaltyKeys(out) {
  if (!out || typeof out !== "object") return;
  for (const k of Object.keys(out)) {
    const kk = k.toLowerCase();
    if (kk.startsWith("penalty") || kk.startsWith("cost") || kk.includes("penalty")) out[k] = 0;
  }
}

// -------- wrapped export --------
export function getEventFacts(eventId, opts = {}) {
  const base = baseGetEventFacts(eventId, opts);
  if (!base) return base;

  // clone (niet muteren als base gecached wordt)
  const out = { ...base };

  const id = norm(eventId);

  // 1) DEN_* events: alleen gevaarlijk voor target denColor (of als Den Signal immune is: 0)
  if (id.startsWith("DEN_")) {
    const target = inferTargetDenColor(eventId, out);
    const myColor = norm(opts?.denColor || opts?.me?.color || opts?.me?.denColor || opts?.me?.den);
    const immune = !!(opts?.flagsRound?.denImmune && target && opts.flagsRound.denImmune[target]);

    if (target) out.targetDenColor = target;

    // niet jouw kleur of immune => geen gevaar
    if (!myColor || myColor !== target || immune) {
      zeroAllDangerKeys(out);
    }
  }

  // 2) LEAD-only events: alleen gevaarlijk voor Lead Fox
  if (id === "MAGPIE_SNITCH" || id === "SILENT_ALARM") {
    const isLead = !!opts?.isLead; // komt uit botRunner
    if (!isLead) {
      zeroAllDangerKeys(out);
      zeroAllPenaltyKeys(out);
    }
    out.appliesTo = "LEAD";
  }

  return out;
}
