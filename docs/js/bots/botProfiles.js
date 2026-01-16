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
  // Prefer an explicit value if your pipeline provides it.
  const explicit = ctx?.carryValue;
  if (Number.isFinite(Number(explicit))) return Number(explicit);
  // Fallback: treat each loot as ~1 value (conservative).
  return getLootCount(ctx);
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

  // If ctx.dangerNext exists, treat it as your authoritative effective metric.
  // Otherwise use stayDanger as safer default to avoid peak-triggered herd DASH.
  const effective = Number.isFinite(dn) ? dn : s;

  return { facts, peak: p, stay: s, effective };
}

function preferBurrow(ctx) {
  return !ctx?.me?.burrowUsed;
}

/**
 * Decide with guardrails:
 * - If event does NOT apply to me: do NOT dash because of "danger".
 * - If staying is truly dangerous (effective >= HIGH): BURROW preferred (if available), else consider DASH only if carry is high.
 * - Add anti-herd: if others already dash, raise thresholds (dash becomes less attractive).
 */
function decideWithProfile(ctx, profileKey) {
  const lootCount = getLootCount(ctx);
  const carry = getCarryValue(ctx);
  const rooster = getRooster(ctx);
  const { facts, peak, stay, effective } = getDanger(ctx);
  const appliesToMe = getAppliesToMe(ctx, facts);
  const canBurrow = preferBurrow(ctx);

  const plannedDashers = getPlannedDashers(ctx);
  const herdPenalty = plannedDashers >= 1 ? 1 : 0; // mild

  // Thresholds per profile
  const T = {
    GREEDY: {
      DASH_SAFE_CARRY: 7 + herdPenalty,
      DASH_ROOSTER_CARRY: 5 + herdPenalty,
      DASH_DANGER_CARRY: 4 + herdPenalty,
      HIGH_DANGER: 8,
      MED_DANGER: 6,
    },
    CAUTIOUS: {
      DASH_SAFE_CARRY: 8 + herdPenalty,
      DASH_ROOSTER_CARRY: 6 + herdPenalty,
      DASH_DANGER_CARRY: 6 + herdPenalty,
      HIGH_DANGER: 7,
      MED_DANGER: 5,
    },
    BALANCED: {
      DASH_SAFE_CARRY: 8 + herdPenalty,
      DASH_ROOSTER_CARRY: 6 + herdPenalty,
      DASH_DANGER_CARRY: 5 + herdPenalty,
      HIGH_DANGER: 8,
      MED_DANGER: 6,
    },
  }[profileKey] || {
    DASH_SAFE_CARRY: 8 + herdPenalty,
    DASH_ROOSTER_CARRY: 6 + herdPenalty,
    DASH_DANGER_CARRY: 5 + herdPenalty,
    HIGH_DANGER: 8,
    MED_DANGER: 6,
  };

  // If the event doesn't apply to me, don't let danger push DASH.
  const dangerEff = appliesToMe === false ? 0 : effective;

  // 1) Truly dangerous to stay → defend first
  if (dangerEff >= T.HIGH_DANGER) {
    if (canBurrow) return "BURROW";
    // If no BURROW possible, only DASH if carrying enough to justify the exit.
    if (carry >= T.DASH_DANGER_CARRY) return "DASH";
    return "LURK";
  }

  // 2) Medium danger → cautious: BURROW if possible (esp. for cautious/balanced)
  if (dangerEff >= T.MED_DANGER && canBurrow && profileKey !== "GREEDY") {
    return "BURROW";
  }

  // 3) Cashout conditions (safe or moderately safe)
  //    Keep thresholds higher than old (loot>=3) to prevent early herd DASH.
  if (carry >= T.DASH_SAFE_CARRY) return "DASH";

  // Roosters: nudge towards banking, but do not auto-dash at low carry.
  if (rooster >= 2 && carry >= T.DASH_ROOSTER_CARRY) return "DASH";

  // 4) Default: keep looting / positioning
  if (dangerEff >= T.MED_DANGER && canBurrow) return "BURROW";
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
