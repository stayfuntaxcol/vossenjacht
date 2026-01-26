// ./bots/botProfiles.js (patched)
// Goal: prevent "auto-DASH" (especially on DEN_* events that only affect 1 color)
// by making profile decisions danger-aware and respecting appliesToMe.
//
// Expected ctx fields (best-effort, all optional):
// - ctx.me: { id, loot:[], burrowUsed, color|denColor }
// - ctx.game: { roosterSeen }
// - ctx.dangerNext: number (already scoped)  OR ctx.nextEventFacts: { dangerDash, dangerLurk, dangerBurrow, appliesToMe/_appliesToMe }
// - ctx.nextEventId: string like "DEN_GREEN" (optional fallback)
// - ctx.isLead: boolean (optional)
// - ctx.dashDecisionsSoFar / ctx.plannedDashers: number (optional anti-herd)

/** ===== small helpers ===== */
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function peakDanger(f) {
  if (!f) return 0;
  return Math.max(num(f.dangerDash), num(f.dangerLurk), num(f.dangerBurrow));
}

function stayDanger(f) {
  if (!f) return 0;
  // "Danger if I stay" = best defensive option among LURK/BURROW
  return Math.min(num(f.dangerLurk, 0), num(f.dangerBurrow, 0));
}

function getLootCount(ctx) {
  const loot = ctx?.me?.loot;
  return Array.isArray(loot) ? loot.length : 0;
}

function getCarryValue(ctx) {
  // DEPRECATED (CANON): carryValue must NOT drive DASH/BURROW.
  // Keep only for backward compatibility (e.g., logs).
  const explicit = ctx?.carryValue;
  return Number.isFinite(Number(explicit)) ? Number(explicit) : getLootCount(ctx);
}

function getRooster(ctx) {
  return num(ctx?.game?.roosterSeen, 0);
}

function getPlannedDashers(ctx) {
  // Optional anti-herd: if others already plan DASH this phase, raise DASH thresholds.
  const a = num(ctx?.plannedDashers, NaN);
  const b = num(ctx?.dashDecisionsSoFar, NaN);
  const c = num(ctx?.dashersThisDecision, NaN);
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  if (Number.isFinite(c)) return c;
  return 0;
}

function parseDenFromEventId(nextEventId) {
  const id = String(nextEventId || "").toUpperCase();
  // DEN_GREEN / DEN_RED / DEN_BLUE / DEN_YELLOW
  if (!id.startsWith("DEN_")) return null;
  return id.replace("DEN_", "");
}

function normColor(c) {
  return String(c || "").trim().toUpperCase();
}

function getAppliesToMe(ctx, facts) {
  // 1) Explicit flags from upstream (preferred)
  if (typeof facts?._appliesToMe === "boolean") return facts._appliesToMe;
  if (typeof facts?.appliesToMe === "boolean") return facts.appliesToMe;
  if (typeof ctx?.appliesToMe === "boolean") return ctx.appliesToMe;

  // 2) Fallback for DEN_* if we have nextEventId + myColor
  const den = parseDenFromEventId(ctx?.nextEventId);
  if (den) {
    const my = normColor(ctx?.me?.denColor || ctx?.me?.color);
    if (my) return my === den;
  }

  // 3) Unknown → assume it could apply (safer than under-reacting)
  return true;
}

function getDanger(ctx) {
  // Prefer already-scoped dangerNext (coming from your policy/heuristics)
  const dn = num(ctx?.dangerNext, NaN);
  const facts = ctx?.nextEventFacts || null;

  // Two readings:
  // - effectivePeak: used for "panic" detection
  // - effectiveStay: used for "should I dash because staying is unsafe?"
  const p = peakDanger(facts);
  const s = stayDanger(facts);

  // CANON: decision risk is primarily "LURK risk".
  // If caller provides ctx.dangerNext (already scoped), use it.
  // Otherwise fall back to dangerLurk from facts.
  const effective = Number.isFinite(dn) ? dn : num(facts?.dangerLurk, 0);

  return { facts, peak: p, stay: s, effective };
}

function preferBurrow(ctx) {
  return !ctx?.me?.burrowUsed;
}

/**
 * Decide with guardrails:
 * - If event does NOT apply to me: do NOT dash because of "danger".
 * - If staying is truly dangerous (effective >= HIGH): BURROW preferred (if available), else DASH.
  */
function decideWithProfile(ctx, profileKey) {
  const rooster = getRooster(ctx);
  const { facts, effective } = getDanger(ctx);
  const appliesToMe = getAppliesToMe(ctx, facts);
  const canBurrow = preferBurrow(ctx);

  // If the event doesn't apply to me, danger must NOT push BURROW/DASH.
  const dangerEff = appliesToMe === false ? 0 : effective;

  // Hard-kill: 3rd Rooster Crow (known/derived) => DASH or you're caught for sure.
  const isRooster3 =
    (String(facts?.id || "").toUpperCase() === "ROOSTER_CROW" && rooster >= 2) ||
    (num(facts?.dangerLurk, 0) >= 10 && num(facts?.dangerBurrow, 0) >= 10 && num(facts?.dangerDash, 0) <= 1);

  if (isRooster3) return "DASH";

  // Profile-tuned thresholds (NO carry-based cashout; DASH is final exit).
  const T = {
    GREEDY:   { HIGH_DANGER: 9, MED_DANGER: 7 },
    BALANCED: { HIGH_DANGER: 8, MED_DANGER: 6 },
    CAUTIOUS: { HIGH_DANGER: 7, MED_DANGER: 5 },
  }[profileKey] || { HIGH_DANGER: 8, MED_DANGER: 6 };

  // 1) Dire circumstances: staying is lethal => BURROW lifeline; else DASH.
  if (dangerEff >= T.HIGH_DANGER) {
    return canBurrow ? "BURROW" : "DASH";
  }

  // 2) Rising danger: cautious/balanced may pre-emptively BURROW.
  if (dangerEff >= T.MED_DANGER) {
    if (canBurrow && profileKey !== "GREEDY") return "BURROW";
    return "LURK";
  }

  // 3) Safe => stay (LURK)
  return "LURK";
}

export const BOT_PROFILES = {
  GREEDY: {
    moveWeights: { SNATCH: 55, FORAGE: 15, SCOUT: 10, SHIFT: 20 },
    decision(ctx) {
      return decideWithProfile(ctx, "GREEDY");
    },
    actionPlayChance: 0.75,
  },

  CAUTIOUS: {
    moveWeights: { SNATCH: 20, FORAGE: 20, SCOUT: 35, SHIFT: 25 },
    decision(ctx) {
      return decideWithProfile(ctx, "CAUTIOUS");
    },
    actionPlayChance: 0.55,
  },

  BALANCED: {
    moveWeights: { SNATCH: 35, FORAGE: 25, SCOUT: 20, SHIFT: 20 },
    decision(ctx) {
      return decideWithProfile(ctx, "BALANCED");
    },
    actionPlayChance: 0.65,
  },
};

export function pickProfile(name) {
  return BOT_PROFILES[name] || BOT_PROFILES.BALANCED;
}

export function weightedPick(weights) {
  const entries = Object.entries(weights || {});
  const total = entries.reduce((s, [, w]) => s + Math.max(0, Number(w) || 0), 0);
  if (!total) return entries[0]?.[0] || null;

  let r = Math.random() * total;
  for (const [k, wRaw] of entries) {
    const w = Math.max(0, Number(wRaw) || 0);
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1]?.[0] || null;
}
