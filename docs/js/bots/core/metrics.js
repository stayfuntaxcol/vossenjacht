// js/bots/core/metrics.js
// Pure metrics for bots: carry + danger
// No Firestore calls. Safe fallbacks if facts are missing.

import { getEventFacts } from "../aiKit.js";
import { BOT_PRESETS, presetFromDenColor } from "../botHeuristics.js";
import { DEFAULT_CORE_CONFIG } from "../botPolicyCore.js";

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
function normColor(c) {
  return String(c || "").trim().toUpperCase();
}
function asArray(x) {
  return Array.isArray(x) ? x : [];
}
function sumLootPoints(p) {
  const loot = asArray(p?.loot);
  return loot.reduce((s, c) => {
    const raw = c?.v ?? c?.value ?? c?.points ?? c?.pts ?? 0;
    const n = Number(raw);
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
}

/**
 * Canonical carryValue: align with scoring-ish values:
 * eggs=1, hens=2, prize=3, plus loot card points.
 */
export function computeCarryValue(p) {
  const eggs = Number(p?.eggs ?? 0);
  const hens = Number(p?.hens ?? 0);

  // prize can be boolean or number
  const prizeCount = typeof p?.prize === "number" ? Number(p.prize) : (p?.prize ? 1 : 0);
  const prizePts = prizeCount * 3;

  const lootPts = sumLootPoints(p);
  return eggs * 1 + hens * 2 + prizePts + lootPts;
}

function computeIsLeadForPlayer(game, me, players) {
  const leadId = String(game?.leadFoxId || "");
  if (leadId && leadId === String(me?.id || "")) return true;

  const leadName = String(game?.leadFox || "");
  if (leadName && leadName === String(me?.name || "")) return true;

  const idx = Number.isFinite(Number(game?.leadIndex)) ? Number(game.leadIndex) : null;
  if (idx === null) return false;

  const ordered = asArray(players).slice().sort((a, b) => (a?.joinOrder ?? 9999) - (b?.joinOrder ?? 9999));
  return ordered[idx]?.id === me?.id;
}

function getNextEventIndex(game) {
  const track = asArray(game?.eventTrack);
  const rev = asArray(game?.eventRevealed);
  if (!track.length) return 0;
  if (!rev.length) return 0;
  const n = Math.min(track.length, rev.length);
  for (let i = 0; i < n; i++) {
    if (rev[i] !== true) return i;
  }
  return n; // past end
}

function countRevealedRoosters(game) {
  const track = asArray(game?.eventTrack);
  const rev = asArray(game?.eventRevealed);
  const n = Math.min(track.length, rev.length);
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (rev[i] === true && String(track[i] || "") === "ROOSTER_CROW") c++;
  }
  if (c === 0 && Number.isFinite(Number(game?.roosterSeen))) c = Number(game.roosterSeen);
  return c;
}

function normalizeFlags(flagsRound) {
  const fr = flagsRound || {};
  return {
    lockEvents: !!fr.lockEvents,
    scatter: !!fr.scatter,
    denImmune: fr.denImmune && typeof fr.denImmune === "object" ? fr.denImmune : {},
    opsLocked: !!fr.opsLocked,
    followTail: fr.followTail && typeof fr.followTail === "object" ? fr.followTail : {},
    scentChecks: asArray(fr.scentChecks),
    predictions: asArray(fr.predictions),
    holdStill: fr.holdStill && typeof fr.holdStill === "object" ? fr.holdStill : {},
    // IMPORTANT: noPeek is sometimes array (No-Go Zone positions), sometimes boolean in older logic
    noPeek: fr.noPeek,
  };
}

function inferNoInfer(flags, intel) {
  // preferred explicit knob
  if (typeof intel?.noInfer === "boolean") return intel.noInfer;

  // if flags.noPeek is boolean, treat as "no infer/peek"
  if (typeof flags?.noPeek === "boolean") return flags.noPeek;

  // if it's array (positions blocked), that should NOT mean "no infer"
  return false;
}

function noPeekPositions(flags, intel) {
  if (asArray(intel?.noPeekPositions).length) return asArray(intel.noPeekPositions);
  return Array.isArray(flags?.noPeek) ? flags.noPeek : [];
}

function getFactsOrFallback(eventId, opts) {
  if (!eventId) return null;

  // 1) try rulesIndex facts
  try {
    const f = getEventFacts(eventId, opts) || null;
    if (f && (Number.isFinite(Number(f.dangerDash)) || Number.isFinite(Number(f.dangerLurk)) || Number.isFinite(Number(f.dangerBurrow)))) {
      return f;
    }
    // still use it for tags/category if present
    if (f) return f;
  } catch {
    // ignore
  }

  // 2) fallback heuristic facts (only if rulesIndex missing)
  const id = String(eventId || "");
  const isDen = id.startsWith("DEN_");
  const isDog = id.includes("CHARGE") || id.includes("DOG") || id.includes("SHEEPDOG");
  const isRooster = id === "ROOSTER_CROW";

  if (isDen) {
    // Staying risky for matching den; dash safer
    return { id, dangerDash: 2, dangerLurk: 8, dangerBurrow: 8, tags: ["CATCH_BY_DEN_COLOR"], category: "DEN" };
  }
  if (isDog) {
    // Dogs often punish dashers; burrow helps most
    return { id, dangerDash: 8, dangerLurk: 4, dangerBurrow: 2, tags: ["CATCH_DASHERS"], category: "DOG" };
  }
  if (isRooster) {
    return { id, dangerDash: 1, dangerLurk: 2, dangerBurrow: 2, tags: ["ROOSTER_TICK"], category: "ROOSTER" };
  }

  // neutral default
  return { id, dangerDash: 3, dangerLurk: 3, dangerBurrow: 3, tags: [], category: "MISC" };
}

function scopeFactsToMe(facts, { denColor, isLead, flags }) {
  if (!facts) return { facts: null, applies: 0, notes: ["no_facts"] };

  const id = String(facts.id || facts.eventId || "");
  const cat = String(facts.category || "");
  const tags = asArray(facts.tags);

  // default: applies
  let applies = 1;
  const notes = [];

  // DEN_x applies only to matching den
  if (id.startsWith("DEN_")) {
    const c = id.slice(4).toUpperCase();
    if (c && c !== denColor) {
      applies = 0;
      notes.push("den_mismatch");
    }
  }

  // lead-only (hard check by known ids OR tag)
  const leadOnly =
    id === "SILENT_ALARM" ||
    id === "MAGPIE_SNITCH" ||
    tags.some((t) => String(t).toUpperCase() === "TARGET_LEAD_FOX");

  if (leadOnly && !isLead) {
    applies = 0;
    notes.push("lead_only_not_lead");
  }

  // Den Signal immunity: neutralize DOG/DEN catch events for that color
  const immune = !!flags?.denImmune?.[denColor];
  const dogOrDen = id.startsWith("DEN_") || cat.toUpperCase() === "DOG" || id.includes("CHARGE") || id.includes("SHEEPDOG");
  if (immune && dogOrDen) {
    applies = 0;
    notes.push("den_signal_immune");
  }

  // apply scaling to numbers, but keep the same object shape
  const f2 = { ...facts };

  // If doesn't apply: zero out dangers so expectations work
  if (!applies) {
    f2.dangerDash = 0;
    f2.dangerLurk = 0;
    f2.dangerBurrow = 0;
  }

  // ensure numeric
  f2.dangerDash = clamp(Number(f2.dangerDash || 0), 0, 10);
  f2.dangerLurk = clamp(Number(f2.dangerLurk || 0), 0, 10);
  f2.dangerBurrow = clamp(Number(f2.dangerBurrow || 0), 0, 10);

  // mark applies in a compatible way for other code if needed
  f2._appliesToMe = !!applies;

  return { facts: f2, applies, notes };
}

function vecFromFacts(f) {
  return {
    dash: clamp(Number(f?.dangerDash ?? 0), 0, 10),
    lurk: clamp(Number(f?.dangerLurk ?? 0), 0, 10),
    burrow: clamp(Number(f?.dangerBurrow ?? 0), 0, 10),
  };
}
function peakFromVec(v) {
  return Math.max(Number(v?.dash || 0), Number(v?.lurk || 0), Number(v?.burrow || 0));
}
function stayFromVec(v, player) {
  const burrowOk = !player?.burrowUsed;
  if (!burrowOk) return Number(v?.lurk || 0);
  return Math.min(Number(v?.lurk || 0), Number(v?.burrow || 0));
}
function mixVec(a, b, wa, wb) {
  return {
    dash: clamp((a.dash * wa) + (b.dash * wb), 0, 10),
    lurk: clamp((a.lurk * wa) + (b.lurk * wb), 0, 10),
    burrow: clamp((a.burrow * wa) + (b.burrow * wb), 0, 10),
  };
}

function buildRemainingDistribution(game, startIndex) {
  const track = asArray(game?.eventTrack);
  const from = clamp(startIndex, 0, track.length);
  const rest = track.slice(from).filter(Boolean);
  const total = rest.length;
  if (!total) return [];
  const counts = new Map();
  for (const id of rest) counts.set(id, (counts.get(id) || 0) + 1);
  return Array.from(counts.entries()).map(([id, c]) => ({ id, p: c / total, c }));
}

function expectedVecFromDist(dist, optsScope) {
  const parts = [];
  for (const item of dist) {
    const facts0 = getFactsOrFallback(item.id, optsScope);
    const scoped = scopeFactsToMe(facts0, optsScope);
    const vec = vecFromFacts(scoped.facts);
    parts.push({ id: item.id, p: item.p, vec, applies: scoped.applies, notes: scoped.notes });
  }

  const out = { dash: 0, lurk: 0, burrow: 0 };
  let pDanger = 0;
  let maxP = 0;
  let topId = null;
  let appliesProb = 0;

  for (const part of parts) {
    out.dash += part.vec.dash * part.p;
    out.lurk += part.vec.lurk * part.p;
    out.burrow += part.vec.burrow * part.p;

    const pk = peakFromVec(part.vec);
    if (pk >= 6.5) pDanger += part.p;

    if (part.p > maxP) {
      maxP = part.p;
      topId = part.id;
    }
    appliesProb += part.applies * part.p;
  }

  return {
    vec: { dash: clamp(out.dash, 0, 10), lurk: clamp(out.lurk, 0, 10), burrow: clamp(out.burrow, 0, 10) },
    pDanger: clamp(pDanger, 0, 1),
    confidence: clamp(maxP, 0.15, 0.6),
    topId,
    appliesProb: clamp(appliesProb, 0, 1),
    parts,
  };
}

function carrySeverityAdd(carryValue) {
  return clamp((Number(carryValue || 0) - 6) * 0.25, 0, 2.5);
}
function riskMultFromPreset(presetKey) {
  const preset = BOT_PRESETS?.[presetKey] || BOT_PRESETS?.BLUE;
  const w = Number(preset?.weights?.risk ?? 1.05);
  return clamp(w / 1.05, 0.75, 1.25);
}

/**
 * Main: compute danger metrics (0–10) + debug fields
 */
export function computeDangerMetrics({ game, player, players = [], flagsRound = null, intel = null }) {
  const g = game || {};
  const me = player || {};
  const flags = normalizeFlags(flagsRound ?? g.flagsRound);

  const denColor = normColor(me?.color || me?.den || me?.denColor);
  const presetKey = presetFromDenColor(denColor);
  const isLead = computeIsLeadForPlayer(g, me, players);

  const carryValue = computeCarryValue(me);

  const roosterSeen = countRevealedRoosters(g);
  const postRooster2Window = roosterSeen >= 2;

  const knownUpcomingEvents = asArray(intel?.knownUpcomingEvents ?? me?.knownUpcomingEvents).filter(Boolean);
  const scoutTier =
    intel?.scoutTier ||
    (knownUpcomingEvents.length >= 2 ? "HARD" : knownUpcomingEvents.length === 1 ? "SOFT" : "NONE");

  const noInfer = inferNoInfer(flags, intel);
  const noPeekPos = noPeekPositions(flags, intel);

  const nextIndex = getNextEventIndex(g);
  const track = asArray(g?.eventTrack);

  // Resolve "next" and "next+1"
  const nextFromTrack = track[nextIndex] || null;
  const next2FromTrack = track[nextIndex + 1] || null;

  const nextKnown =
    typeof intel?.nextKnown === "boolean"
      ? intel.nextKnown
      : (!noInfer ? true : knownUpcomingEvents.length > 0);

  const nextIdUsed = nextKnown
    ? (noInfer ? (knownUpcomingEvents[0] || null) : nextFromTrack)
    : null;

  const next2Known =
    typeof intel?.next2Known === "boolean"
      ? intel.next2Known
      : (!noInfer ? true : knownUpcomingEvents.length > 1);

  const next2IdUsed = next2Known
    ? (noInfer ? (knownUpcomingEvents[1] || null) : next2FromTrack)
    : null;

  const scopeOpts = { game: g, me, denColor, isLead, flags };

  // Slot0 vec
  let slot0 = null;
  if (nextIdUsed) {
    const f0 = getFactsOrFallback(nextIdUsed, { game: g, me, denColor, isLead });
    const scoped0 = scopeFactsToMe(f0, scopeOpts);
    slot0 = {
      mode: "KNOWN",
      eventId: nextIdUsed,
      vec: vecFromFacts(scoped0.facts),
      pDanger: peakFromVec(vecFromFacts(scoped0.facts)) >= 6.5 ? 1 : 0,
      confidence: noInfer ? (scoutTier === "HARD" ? 0.95 : scoutTier === "SOFT" ? 0.85 : 0.7) : 1.0,
      appliesProb: scoped0.applies,
      notes: scoped0.notes,
    };
  } else {
    const dist0 = buildRemainingDistribution(g, nextIndex);
    const exp0 = expectedVecFromDist(dist0, scopeOpts);
    slot0 = {
      mode: "PROB",
      eventId: exp0.topId || null,
      vec: exp0.vec,
      pDanger: exp0.pDanger,
      confidence: exp0.confidence,
      appliesProb: exp0.appliesProb,
      notes: ["probabilistic_next"],
      distTop: exp0.topId,
    };
  }

  // Slot1 vec (optional)
  let slot1 = null;
  if (next2IdUsed) {
    const f1 = getFactsOrFallback(next2IdUsed, { game: g, me, denColor, isLead });
    const scoped1 = scopeFactsToMe(f1, scopeOpts);
    slot1 = {
      mode: "KNOWN",
      eventId: next2IdUsed,
      vec: vecFromFacts(scoped1.facts),
      pDanger: peakFromVec(vecFromFacts(scoped1.facts)) >= 6.5 ? 1 : 0,
      confidence: noInfer ? (scoutTier === "HARD" ? 0.9 : 0.8) : 1.0,
      appliesProb: scoped1.applies,
      notes: scoped1.notes,
    };
  } else {
    const dist1 = buildRemainingDistribution(g, nextIndex + 1);
    const exp1 = expectedVecFromDist(dist1, scopeOpts);
    slot1 = {
      mode: "PROB",
      eventId: exp1.topId || null,
      vec: exp1.vec,
      pDanger: exp1.pDanger,
      confidence: exp1.confidence,
      appliesProb: exp1.appliesProb,
      notes: ["probabilistic_next2"],
      distTop: exp1.topId,
    };
  }

  // Combine 1–2 lookahead
  const w1 = 0.72;
  const w2 = 0.28;
  const dangerVec = mixVec(slot0.vec, slot1.vec, w1, w2);

  const dangerPeak = peakFromVec(dangerVec);
  const dangerStay = stayFromVec(dangerVec, me);

  // Effective danger (policy-ish): stay focus, plus rooster window
  let dangerEffective = dangerStay;

  // Apply probability that it applies (so DEN mismatch etc doesn't inflate)
  const appliesProb = clamp(slot0.appliesProb * w1 + slot1.appliesProb * w2, 0, 1);
  dangerEffective = dangerEffective * appliesProb;

  if (postRooster2Window) {
    dangerEffective = clamp(dangerEffective + Number(DEFAULT_CORE_CONFIG?.ROOSTER_BONUS ?? 2), 0, 10);
  } else {
    dangerEffective = clamp(dangerEffective, 0, 10);
  }

  const pDanger = clamp(slot0.pDanger * w1 + slot1.pDanger * w2, 0, 1);
  let confidence = clamp(slot0.confidence * w1 + slot1.confidence * w2, 0, 1);

  if (flags.lockEvents) confidence = clamp(confidence + 0.1, 0, 1);

  const carryAdd = carrySeverityAdd(carryValue);
  const riskMult = riskMultFromPreset(presetKey);

  const dangerScore =
    clamp((0.55 * dangerEffective + 0.45 * dangerPeak) * riskMult + carryAdd, 0, 10);

  return {
    carryValue,

    dangerScore,
    dangerVec,
    dangerPeak,
    dangerStay,
    dangerEffective,

    nextEventIdUsed: nextIdUsed || slot0.eventId || null,
    pDanger,
    confidence,

    // debug/intel echo
    intel: {
      nextKnown,
      next2Known,
      scoutTier,
      noInfer,
      knownUpcomingEvents,
      predictions: asArray(intel?.predictions ?? flags.predictions),
      noPeekPositions: noPeekPos,
      lockEvents: flags.lockEvents,
      denImmune: !!flags.denImmune?.[denColor],
      isLead,
      roosterSeen,
      postRooster2Window,
      nextIndex,
      slot0,
      slot1,
      riskMult,
      carryAdd,
      presetKey,
    },
  };
}
