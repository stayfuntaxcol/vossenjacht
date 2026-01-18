// js/bots/core/metrics.js
// Pure metrics helpers (NO Firestore calls).
//
// Exported:
// - calcLootStats(loot) -> {eggs,hens,prize,points}
// - computeCarryValue(player) -> exact loot points in hand
// - computeCarryValueRec({game, player, players, mode, avgLootV}) -> {carryValueRec, debug...}
// - computeDangerMetrics({game, player, players, flagsRound, intel}) -> danger bundle
//
// Notes
// - This module intentionally avoids reading "secret" info unless you pass mode="omniscient".
// - Default mode="publicSafe" uses only counts + a stable average loot value.

import { getEventFacts } from "../aiKit.js";

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function bool(x) {
  return !!x;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function normColor(c) {
  return String(c || "").trim().toUpperCase();
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function sumV(cards) {
  const arr = safeArr(cards);
  let s = 0;
  for (const c of arr) s += num(c?.v, 0);
  return s;
}

function lootCountFromPlayer(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : null;
  if (loot) return loot.length;

  // fallback: if you store only counters
  const eggs = num(p?.eggs, 0);
  const hens = num(p?.hens, 0);
  const prize = num(p?.prize, 0);
  return eggs + hens + prize;
}

// ----------------------
// Loot / Carry (exact)
// ----------------------
export function calcLootStats(loot) {
  const items = loot || [];
  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let points = 0;

  for (const card of items) {
    const t = String(card?.t || "");
    const v = num(card?.v, 0);
    if (t === "Egg") eggs++;
    else if (t === "Hen") hens++;
    else if (t === "Prize Hen") prize++;
    points += v;
  }
  return { eggs, hens, prize, points };
}

// Exact points carried ("what you currently hold")
export function computeCarryValue(player) {
  const loot = Array.isArray(player?.loot) ? player.loot : null;
  if (loot && loot.length) {
    return calcLootStats(loot).points;
  }

  // fallback if loot[] isn't present (older schema)
  const eggs = num(player?.eggs, 0);
  const hens = num(player?.hens, 0);
  const prize = num(player?.prize, 0);

  // Values reflect your scoring model: Egg=1, Hen=2, Prize Hen=3
  return eggs * 1 + hens * 2 + prize * 3;
}

// ----------------------
// CarryValueRec (relative pressure)
// ----------------------
// 0..12 index tuned to match botPolicyCore config ranges (CARRY_HIGH / EXTREME).
// Interpretation:
// - higher -> "my current loot is a bigger-than-average slice" + "loot pool is running out" -> bank sooner
// - lower  -> "still early" / "I'm not ahead" -> keep farming & survive the obstacle course
export function computeCarryValueRec({
  game,
  player,
  players,
  mode = "publicSafe",
  avgLootV = null,
} = {}) {
  const mePoints = computeCarryValue(player);

  const list = Array.isArray(players) ? players : [];
  const inRaid = list.filter((p) => {
    if (!p) return false;
    if (p?.dashed) return false;
    if (p?.caught) return false;
    // default: if inYard missing, treat as active
    return p?.inYard !== false;
  });

  const nPlayers = Math.max(1, inRaid.length);

  const totalHeldCards = inRaid.reduce((s, p) => s + lootCountFromPlayer(p), 0);

  const deckCards = Array.isArray(game?.lootDeck) ? game.lootDeck.length : 0;
  const sackCards = Array.isArray(game?.sack) ? game.sack.length : 0;

  // We estimate initial deck size without needing a stored constant:
  // every loot card should be in exactly one of: deck, sack, or some player's loot.
  const initialDeckCardsEst = Math.max(1, deckCards + sackCards + totalHeldCards);
  const drawnCardsEst = sackCards + totalHeldCards;
  const depletion = clamp(drawnCardsEst / initialDeckCardsEst, 0, 1);

  // Average loot value per card
  let mu = num(avgLootV, 0);
  if (mu <= 0) {
    if (mode === "omniscient" && Array.isArray(game?.lootDeck) && game.lootDeck.length) {
      mu = sumV(game.lootDeck) / Math.max(1, game.lootDeck.length);
    } else {
      // Safe default (Egg=1 / Hen=2 / Prize=3) -> typical mean ~1.7..1.9 depending on mix.
      mu = 1.8;
    }
  }

  // We intentionally do NOT use exact other players' points in publicSafe mode.
  const totalHeldValueEst = totalHeldCards * mu;

  const myShareOfHeld = totalHeldValueEst > 0 ? mePoints / totalHeldValueEst : 0;
  const expectedShare = 1 / nPlayers;
  const shareVsExpected = expectedShare > 0 ? myShareOfHeld / expectedShare : 0; // == myShare * nPlayers

  // Core mapping to 0..12
  // - being above expected share matters (early bank pressure)
  // - depletion matters (late bank pressure)
  // - weights chosen so that early game typically stays low unless you're clearly ahead
  let recRaw = (shareVsExpected - 1) * 4 + depletion * 6;

  // guardrails
  if (!Number.isFinite(recRaw)) recRaw = 0;

  const carryValueRec = clamp(recRaw, 0, 12);

  return {
    carryValueRec: Math.round(carryValueRec * 10) / 10,
    debug: {
      mode,
      mePoints,
      nPlayers,
      muUsed: Math.round(mu * 100) / 100,
      totalHeldCards,
      deckCards,
      sackCards,
      initialDeckCardsEst,
      drawnCardsEst,
      depletion: Math.round(depletion * 1000) / 1000,
      myShareOfHeld: Math.round(myShareOfHeld * 1000) / 1000,
      shareVsExpected: Math.round(shareVsExpected * 1000) / 1000,
      recRaw: Math.round(recRaw * 100) / 100,
    },
  };
}

// ----------------------
// Danger metrics
// ----------------------
function eventAppliesToMeById(eventId, denColor, isLead, flagsRound) {
  const id = String(eventId || "").trim();
  if (!id) return true;

  // DEN color targeting
  if (id.startsWith("DEN_")) {
    const target = normColor(id.slice(4));
    if (target && denColor && target !== denColor) return false;
  }

  // lead-only events
  if (id === "MAGPIE_SNITCH" || id === "SILENT_ALARM") {
    if (!isLead) return false;
  }

  // Den Signal immunity (denImmune is map by color: {RED:true,...})
  const denImmune = flagsRound?.denImmune && typeof flagsRound.denImmune === "object"
    ? !!flagsRound.denImmune[denColor]
    : false;

  if (denImmune) {
    // In engine, denImmune blocks catch events like DOG_CHARGE / SECOND_CHARGE and DEN_*.
    if (id === "DOG_CHARGE" || id === "SECOND_CHARGE" || id.startsWith("DEN_")) {
      return false;
    }
  }

  return true;
}

function scopeEventFacts(eventId, { denColor, isLead, flagsRound } = {}) {
  const base = eventId ? getEventFacts(String(eventId)) : null;
  if (!base) return null;

  const applies = eventAppliesToMeById(base.id || eventId, denColor, isLead, flagsRound);

  // Clone shallow so we can safely mutate danger fields
  const f = { ...base };
  f.appliesToMe = applies;
  f._appliesToMe = applies;

  if (applies === false) {
    f.dangerDash = 0;
    f.dangerLurk = 0;
    f.dangerBurrow = 0;
  }

  return f;
}

function peakDanger(f) {
  if (!f) return 0;
  return Math.max(num(f.dangerDash, 0), num(f.dangerLurk, 0), num(f.dangerBurrow, 0));
}

function computeExpectedFactsFromBag(bagIds, scopedCtx) {
  const ids = safeArr(bagIds).map((x) => String(x || "").trim()).filter(Boolean);
  if (!ids.length) {
    return {
      expDash: 0,
      expLurk: 0,
      expBurrow: 0,
      pDanger: 0,
      n: 0,
    };
  }

  let sDash = 0;
  let sLurk = 0;
  let sBurrow = 0;
  let dangerous = 0;
  let n = 0;

  for (const id of ids) {
    const f = scopeEventFacts(id, scopedCtx);
    if (!f) continue;
    const d = num(f.dangerDash, 0);
    const l = num(f.dangerLurk, 0);
    const b = num(f.dangerBurrow, 0);
    sDash += d;
    sLurk += l;
    sBurrow += b;

    if (peakDanger(f) >= 7) dangerous++;
    n++;
  }

  if (!n) {
    return { expDash: 0, expLurk: 0, expBurrow: 0, pDanger: 0, n: 0 };
  }

  return {
    expDash: sDash / n,
    expLurk: sLurk / n,
    expBurrow: sBurrow / n,
    pDanger: dangerous / n,
    n,
  };
}

export function computeDangerMetrics({
  game,
  player,
  players,
  flagsRound,
  intel,
} = {}) {
  const denColor = normColor(intel?.denColor || player?.color || player?.den || player?.denColor);

  // isLead can be passed in intel by botRunner (recommended)
  const isLead = typeof intel?.isLead === "boolean" ? intel.isLead : false;

  const flags = flagsRound || game?.flagsRound || {};

  const noPeek = bool(flags?.noPeek) || bool(intel?.noPeek);
  const opsLocked = bool(flags?.opsLocked);

  // holdStill is stored as a per-player map in flagsRound (e.g. {playerId:true}).
  // Default from fillFlags() is {} which must not block dash.
  const holdStillFlag = flags?.holdStill;
  const holdStill =
    holdStillFlag === true ||
    (holdStillFlag && typeof holdStillFlag === "object" && player?.id && !!holdStillFlag[player.id]) ||
    (typeof intel?.holdStill === "boolean" ? intel.holdStill : false);
  // holdStill is stored as a per-player map (e.g. {<playerId>: true}) in flagsRound.
  // Default in fillFlags() is {} which must NOT be treated as true.
  const holdStillFlag = flags?.holdStill;
  const holdStill =
    holdStillFlag === true ||
    (holdStillFlag && typeof holdStillFlag === "object" && player?.id && !!holdStillFlag[player.id]) ||
    (typeof intel?.holdStill === "boolean" ? intel.holdStill : false);
  // holdStill is stored as a per-player map (e.g. {<playerId>: true}) in flagsRound.
  // Default in fillFlags() is {} which must NOT be treated as active.
  const holdStillFlag = flags?.holdStill;
  const holdStill =
    holdStillFlag === true ||
    (holdStillFlag && typeof holdStillFlag === "object" && player?.id && !!holdStillFlag[player.id]) ||
    bool(intel?.holdStill);

  const carryExact = num(intel?.carryValueExact, num(intel?.carryValue, computeCarryValue(player)));

  // scale danger slightly with "loss severity" (more carried loot -> more to lose)
  const severityScale = 1 + clamp(carryExact / 10, 0, 1) * 0.5; // up to +50%

  const track = safeArr(game?.eventTrack);
  const idx = num(game?.eventIndex, 0);
  const remainingBag = track.slice(Math.max(0, idx));

  const knownListRaw = safeArr(intel?.knownUpcomingEvents || player?.knownUpcomingEvents);
  const knownList = noPeek ? [] : knownListRaw.map((x) => String(x || "").trim()).filter(Boolean);

  const nextByTrack = !noPeek && track[idx] ? String(track[idx]) : null;
  const nextKnown = !!(knownList.length && nextByTrack && knownList[0] === nextByTrack);

  // If we *truly* know next, use it; otherwise treat as probabilistic.
  const useDeterministic = nextKnown && !noPeek;

  const scopedCtx = { denColor, isLead, flagsRound: flags };

  let dangerVec = { dash: 0, lurk: 0, burrow: 0 };
  let nextEventIdUsed = null;
  let pDanger = 0;
  let confidence = 0;
  let debug = {};

  if (useDeterministic) {
    const id1 = nextByTrack;
    const id2 = (track[idx + 1] ? String(track[idx + 1]) : null);

    const f1 = scopeEventFacts(id1, scopedCtx);
    const f2 = knownList.length >= 2 && id2 && knownList[1] === id2 ? scopeEventFacts(id2, scopedCtx) : null;

    const w1 = 0.7;
    const w2 = f2 ? 0.3 : 0.0;
    const ww = w2 > 0 ? (w1 + w2) : 1.0;

    dangerVec = {
      dash: ((num(f1?.dangerDash, 0) * w1) + (num(f2?.dangerDash, 0) * w2)) / ww,
      lurk: ((num(f1?.dangerLurk, 0) * w1) + (num(f2?.dangerLurk, 0) * w2)) / ww,
      burrow: ((num(f1?.dangerBurrow, 0) * w1) + (num(f2?.dangerBurrow, 0) * w2)) / ww,
    };

    nextEventIdUsed = id1;
    pDanger = peakDanger(f1) >= 7 ? 1 : 0;

    confidence = f2 ? 0.9 : 0.75;

    debug = {
      mode: "deterministic",
      nextByTrack: id1,
      next2ByTrack: id2,
      used2: !!f2,
      appliesToMe: f1?._appliesToMe,
    };
  } else {
    // Probabilistic: assume remaining events are a shuffled bag.
    const exp = computeExpectedFactsFromBag(remainingBag, scopedCtx);

    dangerVec = {
      dash: exp.expDash,
      lurk: exp.expLurk,
      burrow: exp.expBurrow,
    };

    nextEventIdUsed = null;
    pDanger = exp.pDanger;

    confidence = noPeek ? 0.25 : 0.45;

    debug = {
      mode: "probabilistic",
      bagN: exp.n,
      nextByTrack: nextByTrack,
      knownUpcomingCount: knownList.length,
      noPeek,
    };
  }

  // Ops locked -> staying is more dangerous because you can't play defense actions.
  if (opsLocked) {
    dangerVec.lurk += 0.75;
    dangerVec.burrow += 0.75;
  }

  // HoldStill (global) -> dash may be blocked; encode as extremely dangerous / infeasible.
  if (holdStill || bool(intel?.dashBlocked)) {
    dangerVec.dash = Math.max(dangerVec.dash, 9.5);
    debug.dashBlocked = true;
  }

  // Apply severity scale & clamp to 0..10
  dangerVec = {
    dash: clamp(dangerVec.dash * severityScale, 0, 10),
    lurk: clamp(dangerVec.lurk * severityScale, 0, 10),
    burrow: clamp(dangerVec.burrow * severityScale, 0, 10),
  };

  const dangerPeak = Math.max(dangerVec.dash, dangerVec.lurk, dangerVec.burrow);

  // Staying risk should reflect best defensive option, but if burrow isn't available, prefer lurk.
  const burrowUsed = bool(player?.burrowUsed) || bool(intel?.burrowUsed);
  const dangerStay = burrowUsed ? dangerVec.lurk : Math.min(dangerVec.lurk, dangerVec.burrow);

  // dangerScore: single scalar for UI/logs (weighted toward peak, but includes stay)
  const dangerScore = clamp(dangerPeak * 0.65 + dangerStay * 0.35, 0, 10);

  // dangerEffective: what should push cashout / policy ("stay danger")
  const dangerEffective = dangerStay;

  return {
    dangerScore: Math.round(dangerScore * 10) / 10,
    dangerVec: {
      dash: Math.round(dangerVec.dash * 10) / 10,
      lurk: Math.round(dangerVec.lurk * 10) / 10,
      burrow: Math.round(dangerVec.burrow * 10) / 10,
    },
    dangerPeak: Math.round(dangerPeak * 10) / 10,
    dangerStay: Math.round(dangerStay * 10) / 10,
    dangerEffective: Math.round(dangerEffective * 10) / 10,
    nextEventIdUsed,
    pDanger: Math.round(pDanger * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    intel: {
      denColor,
      isLead,
      nextKnown,
      knownUpcomingCount: knownList.length,
      noPeek,
      opsLocked,
      carryValueExact: carryExact,
      severityScale: Math.round(severityScale * 1000) / 1000,
    },
    debug,
  };
}
