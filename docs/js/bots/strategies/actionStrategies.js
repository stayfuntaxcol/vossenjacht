// js/bots/strategies/actionStrategies.js
// Action Strategy Library (Spec v1)
// - Declaratieve per-action regels (deny / bonus / save)
// - Geen Firestore/DOM, alleen ctx + comboInfo -> modifiers
//
// Exports:
// - ACTION_STRATEGIES (data)
// - applyActionStrategies(ctx, comboInfo)

const DEFAULTS = {
  PREFER_BONUS: 1,          // thenPrefer zonder thenAddTotal
  SAVE_BIAS: 2,             // penalty om te spelen (bewaar voor later)
  HAILMARY_BEHIND: 6,       // fallback als ctx.hailMaryBehind ontbreekt
};

// Canonical actionIds (moeten overeenkomen met RULES_INDEX action ids)
export const ACTION_ID = {
  KICK_UP_DUST: "KICK_UP_DUST",
  FOLLOW_THE_TAIL: "FOLLOW_THE_TAIL",
  BURROW_BEACON: "BURROW_BEACON",
};

// ---------- condition engine ----------
function getField(obj, path) {
  if (!path) return undefined;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isArray(x) {
  return Array.isArray(x);
}

function eq(a, b) {
  return a === b;
}

function evaluateCondition(cond, ctx) {
  if (!cond || typeof cond !== "object") return false;
  const op = cond.op;
  const field = cond.field;
  const v = getField(ctx, field);

  switch (op) {
    case "eq":
      return eq(v, cond.value);
    case "neq":
      return !eq(v, cond.value);
    case "gte":
      return Number(v) >= Number(cond.value);
    case "lte":
      return Number(v) <= Number(cond.value);
    case "in": {
      const list = isArray(cond.value) ? cond.value : [];
      if (isArray(v)) return v.some((x) => list.includes(x));
      return list.includes(v);
    }
    case "notIn": {
      const list = isArray(cond.value) ? cond.value : [];
      if (isArray(v)) return v.every((x) => !list.includes(x));
      return !list.includes(v);
    }
    case "truthy":
      return !!v;
    case "falsy":
      return !v;
    default:
      return false;
  }
}

function ruleMatches(rule, ctx) {
  if (!rule) return false;
  const ifAll = isArray(rule.ifAll) ? rule.ifAll : null;
  const ifAny = isArray(rule.ifAny) ? rule.ifAny : null;

  const allOk = ifAll ? ifAll.every((c) => evaluateCondition(c, ctx)) : true;
  const anyOk = ifAny ? ifAny.some((c) => evaluateCondition(c, ctx)) : true;

  return allOk && anyOk;
}

function add(map, key, delta) {
  if (!key) return;
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return;
  map[key] = (map[key] || 0) + d;
}

// ---------- derived ctx (keeps rules declarative) ----------
function deriveCtx(ctx) {
  const out = { ...(ctx || {}) };

  // hailMary convenience flag (so rules stay simple)
  const behindThreshold =
    Number.isFinite(Number(out.hailMaryBehind)) ? Number(out.hailMaryBehind) : DEFAULTS.HAILMARY_BEHIND;

  out.hailMary = !!out.isLast || Number(out.scoreBehind || 0) >= behindThreshold;

  // normalize scoutTier if absent
  if (!out.scoutTier) {
    const k = Number(out.knownUpcomingCount || 0);
    out.scoutTier = k >= 2 ? "HARD_SCOUT" : k >= 1 ? "SOFT_SCOUT" : "NO_SCOUT";
  }

  return out;
}

// ---------- Strategy data ----------
export const ACTION_STRATEGIES = [
  // --- KICK_UP_DUST ---
  {
    actionId: ACTION_ID.KICK_UP_DUST,
    baseAddTotal: 0,
    rules: [
      // R1: hard deny without scout
      {
        ifAll: [{ op: "eq", field: "scoutTier", value: "NO_SCOUT" }],
        thenDeny: true,
        note: "No scout → no shuffle.",
      },

      // R2: soft penalty if not dangerous and not hail-mary
      {
        ifAll: [
          { op: "neq", field: "scoutTier", value: "NO_SCOUT" },
          { op: "lte", field: "dangerNext", value: 6 },
          { op: "falsy", field: "hailMary" },
        ],
        thenAddTotal: -3,
        note: "Scout but low danger → usually save.",
      },

      // R3: prefer if danger is high and we have scout
      {
        ifAll: [
          { op: "in", field: "scoutTier", value: ["SOFT_SCOUT", "HARD_SCOUT"] },
          { op: "gte", field: "dangerNext", value: 7 },
        ],
        thenAddTotal: +4,
        note: "Known danger → shuffle can save the raid.",
      },

      // R4: save if no Burrow Beacon (prefer shuffle→lock combo)
      {
        ifAll: [{ op: "falsy", field: "handHas_BURROW_BEACON" }],
        thenSave: true,
        thenAddTotal: -2,
        note: "No lock partner → save for combo later.",
      },

      // R5: hail-mary can justify earlier use (but still needs scout; R1 denies NO_SCOUT)
      {
        ifAll: [{ op: "truthy", field: "hailMary" }, { op: "neq", field: "scoutTier", value: "NO_SCOUT" }],
        thenAddTotal: +2,
        note: "Hail-mary → allow more chaos.",
      },
    ],
  },

  // --- FOLLOW_THE_TAIL ---
  {
    actionId: ACTION_ID.FOLLOW_THE_TAIL,
    baseAddTotal: 0,
    rules: [
      // R1: deny if next card already known
      {
        ifAll: [{ op: "truthy", field: "nextKnown" }],
        thenDeny: true,
        note: "Next known → copying is pointless / misleading.",
      },

      // R2: deny if there is no eligible target (same den OR revealed-den-color target)
      {
        ifAll: [{ op: "falsy", field: "hasEligibleFollowTarget" }],
        thenDeny: true,
        note: "No relevant target → don't play.",
      },

      // R3: prefer if best target matches your den
      {
        ifAll: [{ op: "truthy", field: "bestFollowTargetIsSameDen" }],
        thenAddTotal: +3,
        note: "Same den target → risk alignment.",
      },

      // R4: prefer if best target's den-color event is already revealed
      {
        ifAll: [{ op: "truthy", field: "bestFollowTargetDenRevealed" }],
        thenAddTotal: +2,
        note: "Target den event already revealed → they react to relevant risks.",
      },

      // R5: if eligible exists but best target is neither same-den nor revealed-den, penalize
      {
        ifAll: [
          { op: "truthy", field: "hasEligibleFollowTarget" },
          { op: "falsy", field: "bestFollowTargetIsSameDen" },
          { op: "falsy", field: "bestFollowTargetDenRevealed" },
        ],
        thenAddTotal: -2,
        note: "Eligible is weak/misaligned → avoid defaulting to Follow.",
      },
    ],
  },
];

// ---------- Apply strategies ----------
export function applyActionStrategies(ctx, comboInfo) {
  const dctx = deriveCtx(ctx);

  const hand = isArray(dctx.handActionIds) ? dctx.handActionIds : [];
  const handSet = new Set(hand);

  const addToActionTotal = {};
  const denySet = new Set();
  const saveBiasByActionId = {};

  // Evaluate only for actions in hand (fast + safe)
  for (const strat of ACTION_STRATEGIES) {
    const actionId = strat?.actionId;
    if (!actionId || !handSet.has(actionId)) continue;

    if (Number.isFinite(Number(strat.baseAddTotal))) {
      add(addToActionTotal, actionId, Number(strat.baseAddTotal));
    }

    const rules = isArray(strat.rules) ? strat.rules : [];
    for (const rule of rules) {
      if (!ruleMatches(rule, dctx)) continue;

      if (rule.thenDeny) {
        denySet.add(actionId);
        continue;
      }

      if (Number.isFinite(Number(rule.thenAddTotal))) {
        add(addToActionTotal, actionId, Number(rule.thenAddTotal));
      } else if (rule.thenPrefer) {
        add(addToActionTotal, actionId, DEFAULTS.PREFER_BONUS);
      }

      if (rule.thenSave) {
        // Save bias both: (1) separate channel and (2) immediate play penalty
        const sb = DEFAULTS.SAVE_BIAS;
        saveBiasByActionId[actionId] = (saveBiasByActionId[actionId] || 0) + sb;
        add(addToActionTotal, actionId, -sb);
      }
    }
  }

  return {
    addToActionTotal,
    denyActionIds: Array.from(denySet),
    saveBiasByActionId,
    debug: dctx?.debug
      ? { hailMary: !!dctx.hailMary, scoutTier: dctx.scoutTier, applied: Object.keys(addToActionTotal) }
      : undefined,
  };
}
