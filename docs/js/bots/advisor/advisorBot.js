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
  if (p.includes("ACTIONS") || p.includes("ACTION")) return "OPS"; // jouw game gebruikt ACTIONS
  if (p.includes("DEC")) return "DECISION";
  if (p.includes("RES") || p.includes("REVEAL")) return "RESOLVE";
  return "UNKNOWN";
}

// ------------------------------
// Hand -> action names (strings of objects)
// ------------------------------
function normalizeActionName(x) {
  const name =
    typeof x === "string" ? x :
    (x?.name || x?.id || x?.cardId || "");
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
  const known = getKnownHandActions(me)
    .filter((x) => x.def || x.info)
    .map((x) => x.name);

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
// Profiel-variant (def/agg) via weights
// ------------------------------
function deriveProfile(baseProfile, style) {
  const p = baseProfile || {};
  const w = p.weights || {};

  if (style === "DEFENSIVE") {
    return {
      ...p,
      weights: {
        ...w,
        loot: (w.loot ?? 1.0) * 0.90,
        risk: (w.risk ?? 1.0) * 1.25,
        conserve: (w.conserve ?? 0.0) * 1.20,
        conserveOps: (w.conserveOps ?? 0.0) + 0.15,
      },
    };
  }

  if (style === "AGGRESSIVE") {
    return {
      ...p,
      weights: {
        ...w,
        loot: (w.loot ?? 1.0) * 1.25,
        risk: (w.risk ?? 1.0) * 0.85,
        conserve: (w.conserve ?? 0.0) * 0.80,
        conserveOps: (w.conserveOps ?? 0.0) - 0.10,
      },
    };
  }

  return p;
}

function safeBest(ranked, fallback) {
  return (Array.isArray(ranked) && ranked.length ? ranked[0] : null) || fallback;
}

function labelPlay(x) {
  if (!x) return "PASS";
  if (x.play === "PASS") return "PASS";
  return `Speel: ${x.cardId || x.cardName || x.name || "?"}`;
}

function labelMove(x) {
  return x?.move || "—";
}

function labelDecision(x) {
  return x?.decision || "—";
}

// ------------------------------
// Game helpers: lead fox & revealed dens
// ------------------------------
const DEN_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];
const KNOWN_EVENT_IDS = [
  "DOG_CHARGE",
  "SECOND_CHARGE",
  "SHEEPDOG_PATROL",
  "HIDDEN_NEST",
  "GATE_TOLL",
  "MAGPIE_SNITCH",
  "PAINT_BOMB_NEST",
  "ROOSTER_CROW",
  "DEN_RED",
  "DEN_BLUE",
  "DEN_GREEN",
  "DEN_YELLOW",
];

function computeLeadFoxId(game, players) {
  const list = Array.isArray(players) ? [...players] : [];
  const ordered = list.sort((a, b) => {
    const ao = typeof a.joinOrder === "number" ? a.joinOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.joinOrder === "number" ? b.joinOrder : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  const active = ordered.filter((p) => p?.inYard !== false && !p?.dashed);
  const base = active.length ? active : [];

  let leadIdx = typeof game?.leadIndex === "number" ? game.leadIndex : 0;
  if (leadIdx < 0) leadIdx = 0;
  if (base.length) leadIdx = leadIdx % base.length;

  const lf = base[leadIdx];
  return lf?.id || null;
}

function getRevealedEventIds(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const revealed = Array.isArray(game?.eventRevealed) ? game.eventRevealed : [];
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;

  // voorkeur: eventIndex (alles < idx is gespeeld)
  if (idx > 0 && idx <= track.length) {
    return track.slice(0, idx).filter(Boolean);
  }

  // fallback: eventRevealed flags
  const out = [];
  for (let i = 0; i < track.length; i++) {
    if (revealed[i]) out.push(track[i]);
  }
  return out.filter(Boolean);
}

function getRemainingEventIds(game) {
  const track = Array.isArray(game?.eventTrack) ? game.eventTrack : [];
  const idx = typeof game?.eventIndex === "number" ? game.eventIndex : 0;
  return track.slice(Math.max(0, idx)).filter(Boolean);
}

function extractDenColorFromEventId(eventId) {
  if (!eventId) return null;
  if (!String(eventId).startsWith("DEN_")) return null;
  return String(eventId).substring(4).toUpperCase(); // RED/BLUE/GREEN/YELLOW
}

function getSeenDenColors(game) {
  const seen = new Set();
  const revealedIds = getRevealedEventIds(game);
  for (const id of revealedIds) {
    const c = extractDenColorFromEventId(id);
    if (c) seen.add(c);
  }
  return seen;
}

// ------------------------------
// Loot helpers
// ------------------------------
function getLootPoints(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.reduce((sum, c) => sum + (Number(c?.v) || 0), 0);
}
function getLootCount(p) {
  const loot = Array.isArray(p?.loot) ? p.loot : [];
  return loot.length;
}

// ------------------------------
// Event danger evaluation (voor "LURK" baseline)
// - Sheepdog Patrol: veilig als je LURK (gevaarlijk als je DASH)
// - Gate Toll: gevaarlijk als je 0 loot en je niet DASHt
// - Magpie Snitch: gevaarlijk als je Lead Fox en je niet BURROW/DASH
// - Den events: gevaarlijk als het jouw kleur is (tenzij je jezelf beschermt)
// - DOG/SECOND charge: gevaarlijk voor iedereen (LURK), tenzij je jezelf beschermt
// - Rooster Crow: alleen gevaarlijk als het de 3e is (roosterSeen==2 en er komt nog een ROOSTER)
// ------------------------------
function isDangerousEventForMe(eventId, ctx) {
  const id = String(eventId || "");
  if (!id) return false;

  // 3e rooster is gevaarlijk
  if (id === "ROOSTER_CROW") {
    return (ctx.roosterSeen ?? 0) >= 2;
  }

  // charges zijn gevaarlijk voor iedereen als je LURK
  if (id === "DOG_CHARGE" || id === "SECOND_CHARGE") {
    return true;
  }

  // Den event: alleen jouw kleur gevaarlijk
  if (id.startsWith("DEN_")) {
    const c = extractDenColorFromEventId(id);
    if (!c) return false;
    return c === ctx.myColor;
  }

  // Sheepdog Patrol: alleen gevaarlijk als je DASH (dus baseline LURK = veilig)
  if (id === "SHEEPDOG_PATROL") {
    return false;
  }

  // Gate Toll: als je geen loot hebt, word je gepakt (als je niet DASHt)
  if (id === "GATE_TOLL") {
    return (ctx.lootCount ?? 0) <= 0;
  }

  // Magpie Snitch: gevaarlijk voor Lead Fox als je niet BURROW/DASH (baseline LURK = gevaar)
  if (id === "MAGPIE_SNITCH") {
    return !!ctx.isLead;
  }

  // Hidden Nest / Paint bomb: niet “gevaarlijk” (wel strategisch)
  return false;
}

// ------------------------------
// Kansberekening (zonder spieken): "als het volgende event willekeurig uit resterend deck komt"
// ------------------------------
function calcDangerProbFromRemaining(remainingIds, ctx) {
  const ids = Array.isArray(remainingIds) ? remainingIds.filter(Boolean) : [];
  if (!ids.length) return 0;

  let danger = 0;
  for (const id of ids) {
    if (isDangerousEventForMe(id, ctx)) danger++;
  }
  return danger / ids.length;
}

function countRemainingOf(remainingIds, predicate) {
  const ids = Array.isArray(remainingIds) ? remainingIds.filter(Boolean) : [];
  let n = 0;
  for (const id of ids) if (predicate(id)) n++;
  return n;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function pct(x) {
  return `${Math.round(clamp01(x) * 100)}%`;
}

// ------------------------------
// Bullet sanitizing: geen Event IDs/titels lekken
// ------------------------------
function sanitizeTextNoEventNames(text) {
  let s = String(text || "");

  // vervang bekende event IDs met neutrale termen
  for (const id of KNOWN_EVENT_IDS) {
    const re = new RegExp(`\\b${id}\\b`, "g");
    s = s.replace(re, "opkomend event");
  }

  // vervang DEN_{kleur} varianten generiek
  s = s.replace(/\bDEN_(RED|BLUE|GREEN|YELLOW)\b/g, "Den-event");

  // vervang veelvoorkomende titels (als scoring die ooit gebruikt)
  s = s.replace(/\bRooster Crow\b/gi, "rooster-event");
  s = s.replace(/\bHidden Nest\b/gi, "bonus-event");
  s = s.replace(/\bSheepdog Patrol\b/gi, "patrol-event");
  s = s.replace(/\bSecond Charge\b/gi, "charge-event");
  s = s.replace(/\bSheepdog Charge\b/gi, "charge-event");

  return s;
}

function sanitizeBullets(bullets) {
  const arr = Array.isArray(bullets) ? bullets : [];
  return arr.map(sanitizeTextNoEventNames);
}

// ------------------------------
// Headerregels (zonder “opkomend: IDs”)
// ------------------------------
function headerLinesCompact(view, riskMeta) {
  return [
    `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
    `Volgende kaart: ${riskMeta.nextLabel} • Kans gevaar (deck): ${pct(riskMeta.probNextDanger)}`,
  ];
}

// ------------------------------
// Extra adviesregels (based on jouw nieuwe regels)
// ------------------------------
function buildRiskMeta({ game, me, players, upcomingPeek }) {
  const myColor = String(me?.color || "").toUpperCase();
  const roosterSeen = Number(game?.roosterSeen || 0);

  const lootCount = getLootCount(me);
  const lootPts = getLootPoints(me);

  const leadFoxId = computeLeadFoxId(game, players);
  const isLead = !!me?.id && leadFoxId === me.id;

  const ctx = { myColor, roosterSeen, lootCount, lootPts, isLead };

  const remaining = getRemainingEventIds(game);

  // kans zonder spieken
  const probNextDanger = calcDangerProbFromRemaining(remaining, ctx);

  // uitsplitsing (zonder namen): den van jouw kleur, charges, 3e rooster
  const total = remaining.length || 1;

  const myDenId = myColor ? `DEN_${myColor}` : null;
  const pMyDen =
    myDenId ? countRemainingOf(remaining, (id) => String(id) === myDenId) / total : 0;

  const pCharges =
    countRemainingOf(remaining, (id) => id === "DOG_CHARGE" || id === "SECOND_CHARGE") / total;

  // kans dat "volgende rooster = 3e" (alleen relevant als roosterSeen>=2)
  const pThirdRooster =
    roosterSeen >= 2
      ? countRemainingOf(remaining, (id) => id === "ROOSTER_CROW") / total
      : 0;

  // peek (advisor mag intern weten, maar nooit benoemen)
  const nextId = upcomingPeek?.[0]?.id || null;
  const nextIsDanger = nextId ? isDangerousEventForMe(nextId, ctx) : false;

  const nextLabel = nextId ? (nextIsDanger ? "GEVAARLIJK" : "VEILIG") : "—";

  return {
    ctx,
    remaining,
    probNextDanger,
    pMyDen,
    pCharges,
    pThirdRooster,
    nextId,        // intern
    nextIsDanger,  // intern
    nextLabel,     // toonbaar
  };
}

// ------------------------------
// OPS: tactische override aanbeveling (zonder event namen te lekken)
// ------------------------------
function pickOpsTacticalAdvice({ view, handNames, riskMeta }) {
  const lines = [];
  const has = (name) => handNames.includes(name);

  const myColor = riskMeta.ctx.myColor || "?";
  const flags = view?.game?.flagsRound || {};
  const denImmune = flags?.denImmune || {};
  const denSignalActiveForMe = !!denImmune[myColor] || !!denImmune[String(myColor).toLowerCase()];

  // Als de volgende kaart gevaarlijk is: liefst eerst “veiligstellen”
  if (riskMeta.nextIsDanger) {
    // Charges / Den van jouw kleur → Den Signal is top
    if (has("Den Signal") && !denSignalActiveForMe) {
      lines.push("OPS tip: speel **Den Signal** op je eigen Den-kleur om jezelf veilig te zetten tegen charges en jouw Den-event.");
    }

    // Als risico vooral “Den van jouw kleur” is → Molting/Mask Swap zijn sterk
    if (riskMeta.pMyDen >= 0.10) {
      if (has("Molting Mask")) {
        lines.push("OPS tip: bij Den-gevaar is **Molting Mask** heel sterk (willekeurige nieuwe Den-kleur).");
      }
      if (has("Mask Swap")) {
        lines.push("OPS tip: **Mask Swap** is een alternatief als er andere actieve spelers in de Yard zijn.");
      }
    }

    // Hoge algemene dreiging → probeer track te “repareren”
    if (has("Pack Tinker")) {
      lines.push("OPS tip: overweeg **Pack Tinker** om gevaar verder naar achter te schuiven.");
    }
    if (has("Kick Up Dust")) {
      lines.push("OPS tip: **Kick Up Dust** kan toekomstige events herschudden (als Burrow Beacon niet lockt).");
    }
  }

  // Speciaal: “bonus-event voor DASH” (Hidden Nest) – niet benoemen, wel uitleg
  if (riskMeta.nextId === "HIDDEN_NEST") {
    lines.push("Let op: volgende kaart is een **DASH-bonus event**. Bonus werkt alleen als 1–3 spelers DASH kiezen (3/2/1 loot).");
    lines.push("Strategie: vaak beter om dit bonus-event later te zetten (Pack Tinker / SHIFT), zodat je niet direct uit de Yard vertrekt.");
  }

  // Speciaal: Rooster-event vroeg → vaak beter naar achteren om meer rondes te krijgen
  if (riskMeta.nextId === "ROOSTER_CROW") {
    if ((view?.game?.roosterSeen || 0) >= 2) {
      lines.push("Alarm: een **3e rooster-event** is gevaarlijk (raid eindigt). Probeer dit naar achteren te schuiven (Pack Tinker / SHIFT).");
    } else {
      lines.push("Strategie: rooster-events zijn vaak beter later in de track (meer rondes om loot te pakken).");
    }
  }

  return lines.map(sanitizeTextNoEventNames);
}

// ------------------------------
// DECISION: tactische guidance (Den Signal rule + Hidden Nest dash boost)
// ------------------------------
function decisionTacticalAdvice({ view, riskMeta }) {
  const lines = [];
  const g = view?.game || {};
  const me = view?.me || {};
  const myColor = riskMeta.ctx.myColor || "";

  const flags = g.flagsRound || {};
  const denImmune = flags.denImmune || {};
  const denSignalActiveForMe = !!denImmune[myColor] || !!denImmune[String(myColor).toLowerCase()];

  // JOUW regel:
  // Den Signal (eigen kleur gekozen) => veilig tegen charges + jouw Den-event => in DECISION: LURK (niet BURROW/DASH)
  if (denSignalActiveForMe) {
    lines.push(`Den Signal actief voor jouw kleur → **kies LURK** (dus niet BURROW/DASH).`);
  }

  // Bonus-event voor DASH (Hidden Nest) => hoog DASH advies (aggressief), maar met nuance
  if (riskMeta.nextId === "HIDDEN_NEST") {
    const active = Array.isArray(view?.players)
      ? view.players.filter((p) => p?.inYard !== false && !p?.dashed)
      : [];
    const activeCount = active.length;

    lines.push("Aggressief: **DASH** kan hier extra loot opleveren (alleen als 1–3 spelers DASH kiezen: 3/2/1).");
    if (activeCount > 3) {
      lines.push("Waarschuwing: met 4+ spelers tegelijk DASH is er **geen** bonus.");
    }
    lines.push("Strategie: meestal is het beter om dit bonus-event later te zetten (Pack Tinker / SHIFT), zodat je niet te vroeg uit de Yard vertrekt.");
  }

  // 3e rooster waarschuwing
  if (riskMeta.nextId === "ROOSTER_CROW" && (g.roosterSeen || 0) >= 2) {
    lines.push("3e rooster-event is gevaarlijk (raid eindigt). Defensief: voorkom paniek-dash; liever de track fixen (Pack Tinker / SHIFT).");
  }

  return lines.map(sanitizeTextNoEventNames);
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
  const baseProfile =
    ADVISOR_PROFILES[profileKey] || ADVISOR_PROFILES.BEGINNER_COACH;

  const profileDef = deriveProfile(baseProfile, "DEFENSIVE");
  const profileAgg = deriveProfile(baseProfile, "AGGRESSIVE");

  const view = buildPlayerView({ game, me, players, actions });
  const phase = normalizePhase(view.phase);

  // advisor mag intern “peek” (2 upcoming), maar we tonen nooit IDs/titels
  const upcomingPeek = getUpcomingEvents(view, 2);

  // hand normaliseren voor scoring + debug
  const handMeta = summarizeHandRecognition(view.me || me || {});

  // scoring-safe hand: array van objects {id,name}
  if (view?.me) {
    view.me.handNames = handMeta.names;
    view.me.handKnown = handMeta.known;
    view.me.handUnknown = handMeta.unknown;
    view.me.hand = handMeta.names.map((n) => ({ id: n, name: n }));
  }

  // risk meta
  const riskMeta = buildRiskMeta({
    game: view.game || game,
    me: view.me || me,
    players: view.players || players,
    upcomingPeek,
  });

  const riskBullets = [
    `Jouw Den-kleur: ${riskMeta.ctx.myColor || "—"}`,
    `Kans: Den-event van jouw kleur: ${pct(riskMeta.pMyDen)} • Charges: ${pct(riskMeta.pCharges)} • 3e rooster: ${pct(riskMeta.pThirdRooster)}`,
  ];

  // =======================
  // MOVE
  // =======================
  if (phase === "MOVE") {
    const rankedDef = scoreMoveMoves({ view, upcoming: upcomingPeek, profile: profileDef }) || [];
    const rankedAgg = scoreMoveMoves({ view, upcoming: upcomingPeek, profile: profileAgg }) || [];

    const bestDef = safeBest(rankedDef, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });
    const bestAgg = safeBest(rankedAgg, { move: "—", bullets: [], confidence: 0.6, riskLabel: "MED" });

    const defBullets = sanitizeBullets(bestDef.bullets || []);
    const aggBullets = sanitizeBullets(bestAgg.bullets || []);

    // extra strategy hints (zonder event namen)
    const strat = [];
    if (riskMeta.probNextDanger >= 0.35) {
      strat.push("Strategie: kans op gevaar is vrij hoog → overweeg **SHIFT** (MOVE) om gevaar naar achter te duwen.");
    }
    if (riskMeta.nextId === "HIDDEN_NEST") {
      strat.push("Strategie: er komt een DASH-bonus event aan → vaak slim om die later te zetten (SHIFT / Pack Tinker), zodat je niet te vroeg vertrekt.");
    }
    if (riskMeta.nextId === "ROOSTER_CROW") {
      strat.push("Strategie: rooster-events liever later (meer rondes om loot te pakken).");
    }

    return {
      title: `MOVE advies • Def: ${labelMove(bestDef)} • Agg: ${labelMove(bestAgg)}`,
      confidence: Math.max(bestDef.confidence ?? 0.65, bestAgg.confidence ?? 0.65),
      risk: riskMeta.nextIsDanger ? "HIGH" : "MIX",
      bullets: [
        ...headerLinesCompact(view, riskMeta),
        ...riskBullets,
        `DEFENSIEF: ${labelMove(bestDef)} (${bestDef.riskLabel ?? "?"})`,
        ...defBullets,
        `AANVALLEND: ${labelMove(bestAgg)} (${bestAgg.riskLabel ?? "?"})`,
        ...aggBullets,
        ...sanitizeBullets(strat),
      ].filter(Boolean).slice(0, 10),
      alternatives: [
        { mode: "DEF alt", pick: rankedDef[1]?.move },
        { mode: "AGG alt", pick: rankedAgg[1]?.move },
      ].filter((x) => x.pick),
      debug: {
        phase: view.phase,
        hand: handMeta,
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          probNextDanger: riskMeta.probNextDanger,
          pMyDen: riskMeta.pMyDen,
          pCharges: riskMeta.pCharges,
          pThirdRooster: riskMeta.pThirdRooster,
        },
      },
    };
  }

  // =======================
  // OPS
  // =======================
  if (phase === "OPS") {
    const defRanked = scoreOpsPlays({ view, upcoming: upcomingPeek, profile: profileDef, style: "DEFENSIVE" }) || [];
    const aggRanked = scoreOpsPlays({ view, upcoming: upcomingPeek, profile: profileAgg, style: "AGGRESSIVE" }) || [];

    const bestDef = safeBest(defRanked, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });
    const bestAgg = safeBest(aggRanked, { play: "PASS", bullets: ["PASS: bewaar je kaarten."], confidence: 0.6, riskLabel: "LOW" });

    const labelDef = labelPlay(bestDef);
    const labelAgg = labelPlay(bestAgg);

    const tactical = pickOpsTacticalAdvice({
      view,
      handNames: handMeta.names,
      riskMeta,
    });

    return {
      title: `OPS advies • Def: ${labelDef} • Agg: ${labelAgg}`,
      confidence: Math.max(bestDef.confidence ?? 0.65, bestAgg.confidence ?? 0.65),
      risk: riskMeta.nextIsDanger ? "HIGH" : "MIX",
      bullets: [
        ...headerLinesCompact(view, riskMeta),
        ...riskBullets,
        handMeta.lineHand,
        handMeta.lineKnown,
        ...(handMeta.lineUnknown ? [handMeta.lineUnknown] : []),

        `DEFENSIEF: ${labelDef} (${bestDef.riskLabel ?? "?"})`,
        ...sanitizeBullets(bestDef.bullets || []),

        `AANVALLEND: ${labelAgg} (${bestAgg.riskLabel ?? "?"})`,
        ...sanitizeBullets(bestAgg.bullets || []),

        ...tactical,
      ].filter(Boolean).slice(0, 10),
      alternatives: [
        {
          mode: "DEF alt",
          pick: defRanked[1]
            ? (defRanked[1].play === "PASS" ? "PASS" : (defRanked[1].cardId || defRanked[1].cardName))
            : null,
        },
        {
          mode: "AGG alt",
          pick: aggRanked[1]
            ? (aggRanked[1].play === "PASS" ? "PASS" : (aggRanked[1].cardId || aggRanked[1].cardName))
            : null,
        },
      ].filter((x) => x.pick),
      debug: {
        phase: view.phase,
        hand: handMeta,
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          probNextDanger: riskMeta.probNextDanger,
          pMyDen: riskMeta.pMyDen,
          pCharges: riskMeta.pCharges,
          pThirdRooster: riskMeta.pThirdRooster,
        },
      },
    };
  }

  // =======================
  // DECISION
  // =======================
  if (phase === "DECISION") {
    const rankedDef = scoreDecisions({ view, upcoming: upcomingPeek, profile: profileDef }) || [];
    const rankedAgg = scoreDecisions({ view, upcoming: upcomingPeek, profile: profileAgg }) || [];

    const bestDef = safeBest(rankedDef, { decision: "—", riskLabel: "MED" });
    const bestAgg = safeBest(rankedAgg, { decision: "—", riskLabel: "MED" });

    const tactical = decisionTacticalAdvice({ view, riskMeta });

    const extraBurrowWarn =
      bestDef.decision === "BURROW" && (view.me?.burrowRemaining ?? 1) === 1
        ? ["Let op: BURROW is schaars (1x per Raid). Alleen doen als het echt nodig is."]
        : [];

    return {
      title: `Decision advies • Def: ${labelDecision(bestDef)} • Agg: ${labelDecision(bestAgg)}`,
      confidence: 0.7,
      risk: riskMeta.nextIsDanger ? "HIGH" : "MIX",
      bullets: [
        ...headerLinesCompact(view, riskMeta),
        ...riskBullets,
        ...sanitizeBullets(extraBurrowWarn),
        `DEFENSIEF: ${labelDecision(bestDef)} (${bestDef.riskLabel ?? "?"})`,
        `AANVALLEND: ${labelDecision(bestAgg)} (${bestAgg.riskLabel ?? "?"})`,
        ...tactical,
      ].filter(Boolean).slice(0, 10),
      alternatives: [
        { mode: "DEF alt", pick: rankedDef[1]?.decision },
        { mode: "AGG alt", pick: rankedAgg[1]?.decision },
      ].filter((x) => x.pick),
      debug: {
        phase: view.phase,
        hand: handMeta,
        riskMeta: {
          nextLabel: riskMeta.nextLabel,
          probNextDanger: riskMeta.probNextDanger,
          pMyDen: riskMeta.pMyDen,
          pCharges: riskMeta.pCharges,
          pThirdRooster: riskMeta.pThirdRooster,
        },
      },
    };
  }

  // fallback
  return {
    title: "Hint",
    confidence: 0.6,
    risk: "MED",
    bullets: [
      `Ronde: ${view.round ?? 0} • Fase: ${view.phase ?? "?"}`,
      handMeta.lineHand,
      "Geen fase herkend.",
    ].filter(Boolean).slice(0, 6),
    alternatives: [],
    debug: { phase: view.phase, hand: handMeta },
  };
}
