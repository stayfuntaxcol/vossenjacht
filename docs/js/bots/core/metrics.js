// js/bots/core/metrics.js
// Pure helpers: carryValue + danger metrics (no Firestore)

function normColor(c) {
  return String(c || "").trim().toUpperCase();
}

function clamp(x, lo = 0, hi = 10) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function sumLootPoints(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.reduce((s, c) => {
    const raw = c?.v ?? c?.value ?? c?.points ?? c?.pts ?? 0;
    const n = Number(raw);
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
}

// 1:1 met jouw bestaande carryValue (eggs/hens/prize/loot)
export function computeCarryValue(p) {
  if (!p) return 0;
  if (Number.isFinite(Number(p.score))) return Number(p.score);

  const eggs = Number(p.eggs || 0);
  const hens = Number(p.hens || 0);
  const prize = p.prize ? 3 : 0;
  const lootPts = sumLootPoints(p);

  return eggs + hens + prize + lootPts;
}

function countRevealedRoosters(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const rev = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];
  const n = Math.min(track.length, rev.length);

  let c = 0;
  for (let i = 0; i < n; i++) {
    if (rev[i] === true && String(track[i]) === "ROOSTER_CROW") c++;
  }
  if (c === 0 && Number.isFinite(Number(game?.roosterSeen))) c = Number(game.roosterSeen);
  return c;
}

// Base risk per event for each decision (0..10)
function riskForEvent(eventId, { myColor, immune, isLead, lootPts, roosterSeen }) {
  const id = String(eventId || "");
  const postRooster2Window = Number(roosterSeen || 0) >= 2;

  // default low
  let dash = 0, lurk = 1, burrow = 1;
  let appliesToMe = true;

  if (!id) return { dash, lurk, burrow, appliesToMe };

  if (id.startsWith("DEN_")) {
    const c = id.slice(4).toUpperCase();
    if (c === myColor && !immune) {
      dash = 0; lurk = 9; burrow = 0;
    } else {
      appliesToMe = false;
      dash = 0; lurk = 0; burrow = 0;
    }
    return { dash, lurk, burrow, appliesToMe };
  }

  if (id === "DOG_CHARGE" || id === "SECOND_CHARGE") {
    if (immune) return { dash: 0, lurk: 0, burrow: 0, appliesToMe: false };
    return { dash: 0, lurk: 10, burrow: 0, appliesToMe: true };
  }

  if (id === "SHEEPDOG_PATROL") {
    return { dash: 9, lurk: 0, burrow: 0, appliesToMe: true };
  }

  if (id === "GATE_TOLL") {
    // alleen gevaarlijk als je 0 loot hebt en je niet DASHt
    const dangerStay = lootPts <= 0 ? 7 : 1;
    return { dash: 0, lurk: dangerStay, burrow: dangerStay, appliesToMe: true };
  }

  if (id === "MAGPIE_SNITCH") {
    if (!isLead) return { dash: 0, lurk: 0, burrow: 0, appliesToMe: false };
    return { dash: 0, lurk: 7, burrow: 2, appliesToMe: true };
  }

  if (id === "SILENT_ALARM") {
    // geen “caught”, wel penalty voor lead → modelleer als medium “danger”
    if (!isLead) return { dash: 0, lurk: 0, burrow: 0, appliesToMe: false };
    return { dash: 0, lurk: 5, burrow: 3, appliesToMe: true };
  }

  if (id === "ROOSTER_CROW") {
    // rooster = druk, vooral na 2 roosters
    if (postRooster2Window) return { dash: 0, lurk: 6, burrow: 5, appliesToMe: true };
    return { dash: 0, lurk: 2, burrow: 2, appliesToMe: true };
  }

  if (id === "HIDDEN_NEST") {
    // vooral opportunity, weinig “danger”
    return { dash: 0, lurk: 1, burrow: 1, appliesToMe: true };
  }

  return { dash, lurk, burrow, appliesToMe };
}

function weightedVec(vecA, wA, vecB, wB) {
  return {
    dash: (vecA.dash * wA) + (vecB.dash * wB),
    lurk: (vecA.lurk * wA) + (vecB.lurk * wB),
    burrow: (vecA.burrow * wA) + (vecB.burrow * wB),
    appliesToMe: vecA.appliesToMe || vecB.appliesToMe,
  };
}

function avgVecFromPool(poolIds, ctx) {
  const ids = Array.isArray(poolIds) ? poolIds.filter(Boolean) : [];
  if (!ids.length) return { dash: 0, lurk: 0, burrow: 0, appliesToMe: false };

  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);

  const total = ids.length;
  let dash = 0, lurk = 0, burrow = 0;
  let pDanger = 0;

  for (const [id, cnt] of counts.entries()) {
    const p = cnt / total;
    const v = riskForEvent(id, ctx);
    dash += p * v.dash;
    lurk += p * v.lurk;
    burrow += p * v.burrow;

    const stay = Math.min(v.lurk, v.burrow);
    if (v.appliesToMe && stay >= 7) pDanger += p;
  }

  return { dash, lurk, burrow, appliesToMe: true, pDanger };
}

/**
 * Returns:
 * {
 *  carryValue, dangerScore, dangerVec:{dash,lurk,burrow}, dangerPeak, dangerStay,
 *  dangerEffective, nextEventIdUsed, pDanger, confidence, intel:{nextKnown, scoutTier}
 * }
 */
export function computeDangerMetrics({ game, player, players = [], flagsRound = {}, intel = {} }) {
  const g = game || {};
  const p = player || {};

  const myColor = normColor(p?.color || p?.den || p?.denColor);
  const flags = { ...(flagsRound || {}) };

  // IMPORTANT: noPeek is boolean-only here (arrays in noPeek => treat as false)
  const noPeek = flags.noPeek === true;
  const denImmune = (flags.denImmune && typeof flags.denImmune === "object") ? flags.denImmune : {};
  const immune = !!denImmune?.[myColor];

  const carryValue = computeCarryValue(p);
  const lootPts = sumLootPoints(p);

  const roosterSeen = countRevealedRoosters(g);

  // isLead (simple)
  const leadId = String(g?.leadFoxId || "");
  const isLead =
    (typeof intel.isLead === "boolean")
      ? intel.isLead
      : (leadId && leadId === String(p?.id || ""));

  const knownUpcomingEvents = Array.isArray(intel?.knownUpcomingEvents)
    ? intel.knownUpcomingEvents.filter(Boolean)
    : (Array.isArray(p?.knownUpcomingEvents) ? p.knownUpcomingEvents.filter(Boolean) : []);

  const knownUpcomingCount = knownUpcomingEvents.length;
  const scoutTier =
    knownUpcomingCount >= 2 ? "HARD_SCOUT"
    : knownUpcomingCount === 1 ? "SOFT_SCOUT"
    : "NO_SCOUT";

  const track = Array.isArray(g?.eventTrack) ? g.eventTrack : [];
  const idx = Number.isFinite(Number(g?.eventIndex)) ? Number(g.eventIndex) : 0;

  const nextKnown = !noPeek || knownUpcomingCount >= 1;

  // Step1 + Step2 (lookahead)
  const nextId1 = nextKnown
    ? (noPeek ? (knownUpcomingEvents[0] || null) : (track[idx] || null))
    : null;

  const nextId2 = (!noPeek)
    ? (track[idx + 1] || null)
    : (knownUpcomingCount >= 2 ? (knownUpcomingEvents[1] || null) : null);

  const ctx = { myColor, immune, isLead, lootPts, roosterSeen };

  let v1, v2;
  let nextEventIdUsed = nextId1;

  // If unknown, use pool distribution from remaining track (composition only)
  if (!nextId1) {
    const futurePool = track.slice(Math.max(0, idx));
    const avg = avgVecFromPool(futurePool, ctx);
    v1 = { dash: avg.dash, lurk: avg.lurk, burrow: avg.burrow, appliesToMe: true };
  } else {
    v1 = riskForEvent(nextId1, ctx);
  }

  if (!nextId2) {
    const futurePool2 = track.slice(Math.max(0, idx + 1));
    const avg2 = avgVecFromPool(futurePool2, ctx);
    v2 = { dash: avg2.dash, lurk: avg2.lurk, burrow: avg2.burrow, appliesToMe: true };
  } else {
    v2 = riskForEvent(nextId2, ctx);
  }

  // Lookahead blend
  const blended = weightedVec(v1, 0.7, v2, 0.3);

  // Carry amplifies “how bad danger feels”
  const carryBoost = clamp((carryValue / 10) * 2, 0, 2); // +0..+2
  const dangerVec = {
    dash: clamp(blended.dash),
    lurk: clamp(blended.lurk + carryBoost * (blended.lurk / 10)),
    burrow: clamp(blended.burrow + carryBoost * (blended.burrow / 10)),
  };

  const dangerPeak = clamp(Math.max(dangerVec.dash, dangerVec.lurk, dangerVec.burrow));
  const dangerStay = clamp(Math.min(dangerVec.lurk, dangerVec.burrow));

  // One scalar that matters most for “stay risk”
  const dangerScore = clamp(0.7 * dangerStay + 0.3 * dangerPeak);

  // “Effective danger” = stay risk + rooster pressure after 2
  const dangerEffective = clamp(dangerStay + (roosterSeen >= 2 ? 2 : 0));

  // Probability of a truly dangerous next card when you are blind
  let pDanger = null;
  if (!nextKnown) {
    const futurePool = track.slice(Math.max(0, idx));
    const avg = avgVecFromPool(futurePool, ctx);
    pDanger = clamp((avg.pDanger || 0) * 10, 0, 10) / 10; // 0..1
  }

  const confidence =
    !noPeek ? 1
    : (knownUpcomingCount >= 2 ? 0.95 : knownUpcomingCount === 1 ? 0.8 : 0.35);

  return {
    carryValue,
    dangerScore,
    dangerVec,
    dangerPeak,
    dangerStay,
    dangerEffective,
    nextEventIdUsed,
    pDanger,
    confidence,
    intel: { nextKnown, scoutTier },
  };
}
