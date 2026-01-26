// docs/js/bots/opsSafety.js
// OPS safety scorer: kiest action die p(safeNow) het meest verhoogt.
// safeNow canon: safety actief (bv Den Signal voor jou) OR dangerStay(LURK) <= 3.0

import { getEventFacts, getActionFacts } from "./rulesIndex.js";
import { getActionIdByName } from "../cards.js";

const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
function normColor(c) {
  return String(c || "").trim().toUpperCase();
}

function mergeFlags(game, flagsRound) {
  const g = (game?.flagsRound && typeof game.flagsRound === "object") ? game.flagsRound : {};
  const f = (flagsRound && typeof flagsRound === "object") ? flagsRound : {};
  return { ...g, ...f };
}

function computeCarryValue(me) {
  // exact loot (if you store loot[])
  if (Array.isArray(me?.loot)) {
    return me.loot.reduce((s, it) => s + num(it?.v, 0), 0);
  }
  // fallback counters (Egg=1, Hen=2, Prize=3)
  const eggs = num(me?.eggs, 0);
  const hens = num(me?.hens, 0);
  const prize = num(me?.prize, 0);
  return eggs * 1 + hens * 2 + prize * 3;
}

function isLeadNow(game, me, ctx = {}) {
  if (typeof ctx?.isLead === "boolean") return ctx.isLead;
  const leadId = game?.leadFoxId || game?.leadId || game?.leadFox || game?.leadPlayerId || null;
  if (!leadId || !me?.id) return false;
  return String(leadId) === String(me.id);
}

function getNoPeek(game, flags) {
  return game?.flagsRound?.noPeek === true || flags?.noPeek === true;
}

function nextEventKnownId(game, me, flags, ctx = {}) {
  // prefer explicit
  const fromCtx =
    (ctx?.nextEventIdUsed != null ? String(ctx.nextEventIdUsed || "") : "") ||
    (ctx?.nextEventKey ? String(ctx.nextEventKey) : "") ||
    (ctx?.nextEventFacts?.id ? String(ctx.nextEventFacts.id) : "");
  if (fromCtx) return fromCtx;

  // if peeking is allowed, use track order
  const noPeek = getNoPeek(game, flags);
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = num(game?.eventIndex, 0);
  if (!noPeek && track[idx]) return String(track[idx]);

  // if noPeek, only use player-known intel if present
  const known = Array.isArray(me?.knownUpcomingEvents) ? me.knownUpcomingEvents : [];
  if (known.length) return String(known[0] || "");

  return null;
}

function remainingBagIds(game, flags, opts = {}) {
  // CANON / noPeek-safe:
  // - noPeek=true: do NOT read game.eventTrack (it's the full shuffled order).
  // - Instead, only use a caller-provided bag (e.g., deck composition minus revealed)
  //   via opts.bagIds, or return null to signal unknown distribution.
  const noPeek = getNoPeek(game, flags);
  const fromCaller = Array.isArray(opts?.bagIds) ? opts.bagIds : null;
  if (noPeek) return fromCaller;

  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = num(game?.eventIndex, 0);
  return track.slice(Math.max(0, idx)).map((x) => String(x || "")).filter(Boolean);
}

function buildRiskCtx({ game, me, flags, ctx = {}, denColor, isLead }) {
  const roosterSeen = num(ctx?.roosterSeen, num(game?.roosterSeen, 0));
  const lootLen =
    Number.isFinite(Number(ctx?.lootLen)) ? Number(ctx.lootLen) :
    Array.isArray(me?.loot) ? me.loot.length :
    (num(me?.eggs, 0) + num(me?.hens, 0) + num(me?.prize, 0));

  const carryValue =
    Number.isFinite(Number(ctx?.carryValueExact)) ? Number(ctx.carryValueExact) :
    Number.isFinite(Number(ctx?.carryValue)) ? Number(ctx.carryValue) :
    computeCarryValue(me);

  // rulesIndex deriveEventDanger reads from ctx.denColor / ctx.game.flagsRound / ctx.flagsRound
  return {
    game,
    me,
    denColor,
    isLead,
    roosterSeen,
    lootLen,
    carryValue,
    flagsRound: flags,
    flags, // extra alias (harmless)
  };
}

// dangerStay for safeNow is specifically LURK danger (canon)
function lurkDanger(f) {
  return num(f?.dangerLurk, 0);
}

function safetyStats({ knownEventId, bagIds, riskCtx, safeThreshold = 3.0 }) {
  if (knownEventId) {
    const f = getEventFacts(knownEventId, riskCtx);
    const d = lurkDanger(f);
    const pSafe = d <= safeThreshold ? 1 : 0;
    return {
      mode: "known",
      n: 1,
      pSafe,
      expDangerLurk: d,
      eventIdUsed: f?.id || knownEventId,
    };
  }

  const bag = Array.isArray(bagIds) ? bagIds : [];
  if (!bag.length) {
    // if we truly don't know anything, treat as mildly safe baseline
    return { mode: "unknown_empty", n: 0, pSafe: 0.5, expDangerLurk: 4.0, eventIdUsed: null };
  }

  let safe = 0;
  let sumD = 0;

  for (const id of bag) {
    const f = getEventFacts(id, riskCtx);
    const d = lurkDanger(f);
    sumD += d;
    if (d <= safeThreshold) safe++;
  }

  const n = bag.length;
  return {
    mode: "bag_uniform",
    n,
    pSafe: safe / n,
    expDangerLurk: sumD / n,
    eventIdUsed: null,
  };
}

function resolveActionId(actionKeyOrId) {
  const s = String(actionKeyOrId || "").trim();
  if (!s) return null;
  // already an ID?
  if (getActionFacts(s)) return s;
  // try name->id
  const id = getActionIdByName(s);
  return id && getActionFacts(id) ? id : null;
}

/**
 * Score 1 action by "how much does it increase p(safeNow)?"
 * Returns: {id, score, deltaP, before, after, reason}
 */
export function scoreOpsActionForSafeNow(actionKeyOrId, opts = {}) {
  const game = opts?.game || null;
  const me = opts?.me || null;
  if (!game || !me) return null;

  const flags = mergeFlags(game, opts?.flagsRound);
  const ctx = (opts?.ctx && typeof opts.ctx === "object") ? opts.ctx : {};
  const denColor0 = normColor(ctx?.denColor || me?.denColor || me?.den || me?.color);
  const isLead0 = isLeadNow(game, me, ctx);

  const knownId = nextEventKnownId(game, me, flags, ctx);
  const bagIds = remainingBagIds(game, flags, opts) || [];

  const baseRiskCtx = buildRiskCtx({ game, me, flags, ctx, denColor: denColor0, isLead: isLead0 });
  const before = safetyStats({ knownEventId: knownId, bagIds, riskCtx: baseRiskCtx });
  const safeNowBefore = before.pSafe >= 0.999 || before.expDangerLurk <= 3.0;

  const id = resolveActionId(actionKeyOrId);
  if (!id) return null;

  const a = getActionFacts(id);
  const tags = Array.isArray(a?.tags) ? a.tags : [];

  // ---- simulate action effects (only what impacts danger/safeNow) ----
  // default: no change
  let afterBest = null;

  // Helper: evaluate a simulated context
  function evalSim({ denColor = denColor0, isLead = isLead0, flagsSim = flags, forceBagMode = false } = {}) {
    const riskCtx = buildRiskCtx({ game, me, flags: flagsSim, ctx, denColor, isLead });

    // Special: KickUpDust -> approximate "next becomes bag-uniform" even if it was known
    const knownEventId = forceBagMode ? null : knownId;

    const out = safetyStats({
      knownEventId,
      bagIds,
      riskCtx,
    });

    return out;
  }

  // A) DEN_SIGNAL: set denImmune for MY den (self-safety)
  if (id === "DEN_SIGNAL") {
    const denImmune = (flags?.denImmune && typeof flags.denImmune === "object") ? { ...flags.denImmune } : {};
    if (denColor0) denImmune[denColor0] = true;

    const flagsSim = { ...flags, denImmune };
    afterBest = evalSim({ flagsSim });

    // small team bonus: more same-den players => more reason to play
    const players = Array.isArray(opts?.players) ? opts.players : [];
    const sameDen = denColor0 ? players.filter((p) => normColor(p?.denColor || p?.den || p?.color) === denColor0).length : 0;
    afterBest.__teamBonus = clamp(sameDen * 0.15, 0, 0.75);
    afterBest.__reason = "DEN_SIGNAL -> denImmune[myDen]=true";
  }

  // B) ALPHA_CALL: if I am lead, make me NOT lead (protect against lead-target events)
  else if (id === "ALPHA_CALL") {
    afterBest = evalSim({ isLead: false });
    afterBest.__reason = "ALPHA_CALL -> isLead=false";
  }

  // C) MOLTING_MASK: random den swap (expected value across 3 other colors)
  else if (id === "MOLTING_MASK") {
    const others = DEN_COLORS.filter((c) => c !== denColor0);
    if (!others.length) {
      afterBest = evalSim({});
      afterBest.__reason = "MOLTING_MASK(no-ops)";
    } else {
      let pSafe = 0;
      let expD = 0;
      for (const dc of others) {
        const r = evalSim({ denColor: dc });
        pSafe += r.pSafe;
        expD += r.expDangerLurk;
      }
      afterBest = {
        mode: "expected_den_swap",
        n: others.length,
        pSafe: pSafe / others.length,
        expDangerLurk: expD / others.length,
        eventIdUsed: null,
        __reason: "MOLTING_MASK -> expected over random new den",
      };
    }
  }

  // D) KICK_UP_DUST: random track swap (approx: turns known-next into bag-uniform)
  else if (id === "KICK_UP_DUST") {
    // If next was unknown anyway, effect on safeNow is near zero (still bag-uniform).
    // If next was known dangerous, forcing bag-uniform can improve.
    afterBest = evalSim({ forceBagMode: true });
    // penalty: randomness / can backfire
    afterBest.__randomPenalty = 0.35;
    afterBest.__reason = "KICK_UP_DUST -> approximate next=bag_uniform";
  }

  // E) Default: actions that don't change immediate danger (info/deny/lock) -> no safety gain
  else {
    afterBest = evalSim({});
    afterBest.__reason = "no direct safeNow effect";
  }

  const after = afterBest;

  const deltaP = (after.pSafe - before.pSafe);
  const deltaD = (before.expDangerLurk - after.expDangerLurk);

  // Core score: prioritize making safeNow true.
  // - 10x on probability swing
  // - 0.75x on expected danger reduction
  let score = (deltaP * 10) + (deltaD * 0.75);

  // Team bonus for Den Signal
  score += num(after.__teamBonus, 0);

  // Randomness penalty (Molting/KickUpDust etc)
  score -= num(after.__randomPenalty, 0);

  // If already safeNow, only allow actions that INCREASE safety further (usually 0) -> otherwise PASS
  if (safeNowBefore && score <= 0.25) score = -1.0;

  // If action is HOLD_STILL: almost never a "self safety" play
  if (id === "HOLD_STILL") score = -2.0;

  return {
    id,
    score: Math.round(score * 100) / 100,
    deltaP: Math.round(deltaP * 1000) / 1000,
    deltaDanger: Math.round(deltaD * 100) / 100,
    safeNowBefore,
    before,
    after,
    reason: after.__reason || null,
  };
}

/**
 * Rank hand actions by safeNow score.
 */
export function rankOpsActionsForSafeNow(hand = [], opts = {}) {
  const keys = Array.isArray(hand) ? hand : [];
  const out = [];

  for (const k of keys) {
    const s = scoreOpsActionForSafeNow(k, opts);
    if (s) out.push(s);
  }

  out.sort((a, b) => (b.score - a.score));
  return out;
}

/**
 * Pick best action to play in OPS (or PASS).
 */
export function pickBestOpsActionForSafeNow(hand = [], opts = {}) {
  const ranked = rankOpsActionsForSafeNow(hand, opts);
  if (!ranked.length) return { play: null, ranked, reason: "no_actions" };

  const best = ranked[0];
  const minScore = Number.isFinite(Number(opts?.minScore)) ? Number(opts.minScore) : 1.25;

  if (best.score >= minScore) return { play: best.id, ranked, reason: "best_safety_gain" };
  return { play: null, ranked, reason: "below_threshold" };
}

