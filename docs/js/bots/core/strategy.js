// js/bots/core/strategy.js
export const BOT_UTILITY_CFG = {
  // weights
  wLoot: 1.0,
  wDeny: 0.65,
  wTeam: 0.50,
  wRisk: 1.15,
  wResource: 0.70,
  wShare: 0.75, // invloed van sack-bonus op V(p)

  // thresholds
  dashPushThreshold: 6.2,
  panicStayRisk: 7.5,        // stayRisk (0-10) boven dit = paniek
  safeDashRisk: 3.0,         // dashRisk (0-10) onder dit = “veilig genoeg”
  burrowMinSafetyGain: 2.0,  // minimaal voordeel (stayRisk - burrowRisk)
  shiftMinGain: 1.8,         // minimaal utility voordeel om SHIFT te doen
  comboMinGain: 1.2,         // minimaal extra voordeel vs beste single
  holdHorizon: 2,            // bewaar counters als event binnen 1-2
  lookaheadN: 5,

  // EVs (ruw, maar stabiel)
  lootEV: 1.7,          // gemiddelde lootkaart (Egg=1, Hen=2, PrizeHen=3)
  actionCardEV: 0.9,    // gemiddelde waarde van 1 action card in hand

  // combo discount (kans dat je later nog een keer aan de beurt komt in OPS)
  comboSecondTurnBaseProb: 0.55,
};

// js/bots/core/strategy.js
import { getEventFacts } from "../bots/rulesIndex.js"; // pas pad aan naar jouw rulesIndex
import { getActionDefByName } from "../cards.js";

// ---------- small helpers ----------
const clamp = (x, a=0, b=10) => Math.max(a, Math.min(b, Number(x||0)));
const normColor = (c) => String(c || "").trim().toUpperCase();

export function sumLootPoints(loot) {
  const arr = Array.isArray(loot) ? loot : [];
  return arr.reduce((s, card) => s + Number(card?.v || 0), 0);
}

export function highestLootCardIndex(loot) {
  const arr = Array.isArray(loot) ? loot : [];
  let bestI = -1;
  let bestV = -Infinity;
  for (let i=0;i<arr.length;i++){
    const v = Number(arr[i]?.v||0);
    if (v > bestV) { bestV = v; bestI = i; }
  }
  return bestI;
}

function deepClone(x) {
  // structuredClone is modern; fallback ok
  if (typeof structuredClone === "function") return structuredClone(x);
  return JSON.parse(JSON.stringify(x));
}

// ---------- peek intel ----------
export function getPeekIntel({ game, player, flagsRound, lookaheadN }) {
  const g = game || {};
  const p = player || {};
  const flags = flagsRound || {};

  const N = Math.max(1, Number(lookaheadN || 3));
  const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
  const idx = Number.isFinite(g.eventIndex) ? g.eventIndex : 0;

  // als noPeek effect actief is voor deze speler: val terug op knownUpcomingEvents
  const noPeekArr = Array.isArray(flags.noPeek) ? flags.noPeek : [];
  const isNoPeek = noPeekArr.includes(String(p.id || ""));

  const fromTrack = track.slice(idx, idx + N).filter(Boolean);
  const fromKnown = Array.isArray(p.knownUpcomingEvents) ? p.knownUpcomingEvents.slice(0, N) : [];

  const ids = (isNoPeek ? fromKnown : fromTrack);
  return {
    nextKnown: ids.length > 0,
    upcomingIds: ids,
    nextId: ids[0] || null,
  };
}
// js/bots/core/strategy.js (vervolg)

function isDenEvent(eventId) {
  return String(eventId||"").startsWith("DEN_");
}
function denColorFromEvent(eventId){
  const parts = String(eventId||"").split("_");
  return normColor(parts[1] || "");
}

function survivalProbNextEvent({ eventId, decision, game, player, flagsRound, isLead }) {
  const ev = String(eventId || "");
  const dec = String(decision || "LURK").toUpperCase();
  const p = player || {};
  const flags = flagsRound || {};
  const myColor = normColor(p.color || p.den);

  // Hold Still: target “can only LURK” (jij forceert dit in DECISION)
  // -> survival check gebeurt elders door forced decision; hier geen aparte rule.

  // Den immune = volledig safe tegen DOG + DEN (zoals in engine) :contentReference[oaicite:5]{index=5}
  const immune = !!(flags.denImmune && myColor && flags.denImmune[myColor]);

  // SHEEPDOG_PATROL: DASHers worden gepakt :contentReference[oaicite:6]{index=6}
  if (ev === "SHEEPDOG_PATROL") return dec === "DASH" ? 0 : 1;

  // DOG charges: lurkers gepakt, dash/burrow safe; immune maakt alles safe :contentReference[oaicite:7]{index=7}
  if (ev === "DOG_CHARGE" || ev === "SECOND_CHARGE") {
    if (immune) return 1;
    return dec === "LURK" ? 0 : 1;
  }

  // DEN_x: alleen jouw kleur is gevaarlijk (tenzij immune) :contentReference[oaicite:8]{index=8}
  if (isDenEvent(ev)) {
    if (immune) return 1;
    const c = denColorFromEvent(ev);
    if (c && c === myColor) return dec === "LURK" ? 0 : 1;
    return 1;
  }

  // GATE_TOLL: non-dash moet 1 loot betalen anders caught :contentReference[oaicite:9]{index=9}
  if (ev === "GATE_TOLL") {
    if (dec === "DASH") return 1;
    const lootLen = Array.isArray(p.loot) ? p.loot.length : 0;
    return lootLen > 0 ? 1 : 0;
  }

  // MAGPIE_SNITCH: Lead wordt gepakt als hij niet dash/burrow (engine) :contentReference[oaicite:10]{index=10}
  if (ev === "MAGPIE_SNITCH") {
    if (!isLead) return 1;
    return (dec === "DASH" || dec === "BURROW") ? 1 : 0;
  }

  // SILENT_ALARM: survival ok; loot penalty wordt apart behandeld :contentReference[oaicite:11]{index=11}
  if (ev === "SILENT_ALARM") return 1;

  // default: safe
  return 1;
}

function silentAlarmLootPenalty({ eventId, decision, player, isLead }) {
  if (String(eventId) !== "SILENT_ALARM") return 0;
  if (!isLead) return 0;
  const dec = String(decision||"LURK").toUpperCase();
  if (dec === "DASH") return 0; // jij ontwijkt meestal penalty door te dashen
  const lootPts = sumLootPoints(player?.loot);
  // engine: lead legt 2 loot af als hij kan (anders lead advance) :contentReference[oaicite:12]{index=12}
  return lootPts >= 2 ? 2 : 0.75; // 0.75 = “soft penalty” voor lead-advance risico
}

function estimateDashPush({ player, cfg, game }) {
  const lootPts = sumLootPoints(player?.loot);
  // simpele mapping naar 0..10
  let push = lootPts * 2.5; // 4 pts -> 10
  // rooster druk: dichter bij einde => meer dash
  const roosterSeen = Number.isFinite(Number(game?.roosterSeen)) ? Number(game.roosterSeen) : 0;
  if (roosterSeen >= 2) push += 1.5;
  return clamp(push, 0, 10);
}

// schatting: hoeveel dashers aan het einde (voor sack-bonus) — engine deelt door #dashers :contentReference[oaicite:13]{index=13}
function expectedFinalDashers({ game, players, cfg }) {
  const dashersNow = players.filter(p => p?.dashed === true).length;
  const yard = players.filter(p => p?.dashed !== true && p?.inYard !== false);
  let exp = dashersNow;
  for (const p of yard) {
    const dp = estimateDashPush({ player: p, cfg, game }) / 10;
    exp += clamp(dp, 0, 1);
  }
  return Math.max(1, exp);
}

function expectedSackBonusPerDasher({ game, players, cfg }) {
  const sackPts = sumLootPoints(game?.sack);
  const expDashers = expectedFinalDashers({ game, players, cfg });
  return (cfg.wShare || 0) * (sackPts / expDashers);
}

function isAlly(me, other){
  return normColor(me?.color || me?.den) && normColor(me?.color || me?.den) === normColor(other?.color || other?.den);
}

function computeIsLead({ game, player, players }) {
  const leadIndex = Number.isFinite(Number(game?.leadIndex)) ? Number(game.leadIndex) : 0;
  const order = [...(players||[])].sort((a,b)=> Number(a?.joinOrder||0)-Number(b?.joinOrder||0));
  const lead = order[leadIndex] || null;
  return !!(lead && String(lead.id) === String(player?.id));
}

function bestDecisionForPlayer({ eventId, game, player, players, flagsRound, cfg }) {
  // forced by Hold Still?
  const hs = flagsRound?.holdStill || {};
  if (hs && hs[String(player?.id)]) return "LURK";

  const isLead = computeIsLead({ game, player, players });
  const burrowAllowed = player?.burrowUsed ? false : true;

  const dashSurv = survivalProbNextEvent({ eventId, decision:"DASH", game, player, flagsRound, isLead });
  const lurkSurv = survivalProbNextEvent({ eventId, decision:"LURK", game, player, flagsRound, isLead });
  const burSurv  = burrowAllowed ? survivalProbNextEvent({ eventId, decision:"BURROW", game, player, flagsRound, isLead }) : 0;

  const lootPts = sumLootPoints(player?.loot);
  const dashPush = estimateDashPush({ player, cfg, game });

  // heel eenvoudige “zelf utility”: loot behouden + survival + alarm penalty
  const alarmDash = silentAlarmLootPenalty({ eventId, decision:"DASH", player, isLead });
  const alarmLurk = silentAlarmLootPenalty({ eventId, decision:"LURK", player, isLead });
  const alarmBur  = silentAlarmLootPenalty({ eventId, decision:"BURROW", player, isLead });

  const uDash = dashSurv * (lootPts) - (1-dashSurv) * lootPts - alarmDash + (dashPush/10)*0.4;
  const uLurk = lurkSurv * (lootPts) - (1-lurkSurv) * lootPts - alarmLurk;
  const uBur  = burSurv  * (lootPts) - (1-burSurv)  * lootPts - alarmBur  - 0.35; // burrow “kost” future option

  let best = { dec:"LURK", u:uLurk };
  if (uDash > best.u) best = { dec:"DASH", u:uDash };
  if (burrowAllowed && uBur > best.u) best = { dec:"BURROW", u:uBur };
  return best.dec;
}

function playerValuePerspective({ game, players, player, flagsRound, cfg, nextEventId }) {
  const lootPts = sumLootPoints(player?.loot);
  const bonus = expectedSackBonusPerDasher({ game, players, cfg });

  // als al dashed: risk next event ~ 0 voor deze value
  if (player?.dashed === true || player?.inYard === false) {
    return lootPts + bonus;
  }

  const dec = bestDecisionForPlayer({ eventId: nextEventId, game, player, players, flagsRound, cfg });
  const isLead = computeIsLead({ game, player, players });
  const surv = survivalProbNextEvent({ eventId: nextEventId, decision: dec, game, player, flagsRound, isLead });
  const alarm = silentAlarmLootPenalty({ eventId: nextEventId, decision: dec, player, isLead });

  // expected loss: caught => loot kwijt (ruw), plus alarm penalty
  const expectedLoss = (1 - surv) * lootPts + alarm;

  // hand = “potentieel” (dit maakt FORAGE/HOLD STILL/denial meetellen)
  const handLen = Array.isArray(player?.hand) ? player.hand.length : 0;
  const handPotential = handLen * (cfg.actionCardEV || 0);

  return (lootPts + bonus + handPotential) - expectedLoss;
}

function stateUtility({ game, players, meId, flagsRound, cfg, nextEventId }) {
  const me = players.find(p => String(p.id) === String(meId));
  if (!me) return -Infinity;

  const allies = players.filter(p => p && String(p.id)!==String(meId) && isAlly(me,p));
  const enemies= players.filter(p => p && String(p.id)!==String(meId) && !isAlly(me,p));

  const Vme = playerValuePerspective({ game, players, player: me, flagsRound, cfg, nextEventId });
  const Vallies = allies.reduce((s,p)=> s + playerValuePerspective({ game, players, player:p, flagsRound, cfg, nextEventId }), 0);
  const Venemies= enemies.reduce((s,p)=> s + playerValuePerspective({ game, players, player:p, flagsRound, cfg, nextEventId }), 0);

  return (cfg.wLoot||0)*Vme + (cfg.wTeam||0)*Vallies - (cfg.wDeny||0)*Venemies;
}

// js/bots/core/strategy.js (vervolg)

function swapInPlace(arr, i, j) {
  const a = [...arr];
  if (!a[i] || !a[j]) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}

function bestShiftSwap({ game, players, meId, flagsRound, cfg, intel }) {
  const g = game || {};
  const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
  const idx = Number.isFinite(g.eventIndex) ? g.eventIndex : 0;

  const N = Math.max(2, Number(cfg.lookaheadN || 5));
  const lo = idx;
  const hi = Math.min(track.length-1, idx + N - 1);

  const baseNext = intel.nextId;
  const baseU = stateUtility({ game:g, players, meId, flagsRound, cfg, nextEventId: baseNext });

  let best = { gain: -Infinity, pair: null };

  for (let i=lo; i<=hi; i++){
    for (let j=i+1; j<=hi; j++){
      const g2 = { ...g, eventTrack: swapInPlace(track, i, j) };
      const intel2 = getPeekIntel({ game: g2, player: players.find(p=>String(p.id)===String(meId)), flagsRound, lookaheadN: cfg.lookaheadN });
      const u2 = stateUtility({ game:g2, players, meId, flagsRound, cfg, nextEventId: intel2.nextId });
      const gain = u2 - baseU;
      if (gain > best.gain) best = { gain, pair: [i, j], intel2 };
    }
  }

  return best.pair ? best : null;
}

export function evaluateMoveOptions({ game, bot, players, flagsRound, cfg = BOT_UTILITY_CFG }) {
  const g = game || {};
  const me = bot || {};
  const P = Array.isArray(players) ? players.map(p => (String(p.id)===String(me.id) ? me : p)) : [me];
  const flags = flagsRound || {};

  const intel = getPeekIntel({ game:g, player:me, flagsRound:flags, lookaheadN: cfg.lookaheadN });
  const nextId = intel.nextId;

  // baseline utility
  const baseU = stateUtility({ game:g, players:P, meId: me.id, flagsRound: flags, cfg, nextEventId: nextId });

  const loot = Array.isArray(me.loot) ? me.loot : [];
  const hand = Array.isArray(me.hand) ? me.hand : [];
  const lootDeckLen = Array.isArray(g.lootDeck) ? g.lootDeck.length : 0;
  const actionDeckLen = Array.isArray(g.actionDeck) ? g.actionDeck.length : 0;

  // ---- candidate: SNATCH (deck draw, expected) ----
  // SNATCH is “altijd ok” zolang lootDeck niet leeg is
  const snatchGain = (cfg.wLoot||0) * (cfg.lootEV||0);
  const uSnatch = baseU + snatchGain;

  // ---- candidate: FORAGE (2 action cards, expected) ----
  // waarde groeit als je weinig hand hebt en/of gevaar nadert
  const handNeed = hand.length < 2 ? 1 : (hand.length < 3 ? 0.5 : 0);
  const dangerFacts = nextId ? getEventFacts(nextId, { denColor: normColor(me.color), lootLen: loot.length, isLead: false }) : null;
  const dangerNeed = dangerFacts ? clamp(Math.max(dangerFacts.dangerLurk, dangerFacts.dangerDash, dangerFacts.dangerBurrow)) / 10 : 0.3;
  const forageEV = (cfg.actionCardEV||0) * 2 * (1 + 0.7*handNeed + 0.6*dangerNeed);
  const uForage = baseU + forageEV;

  // ---- candidate: SHIFT (track swap + cost) ----
  let bestShift = null;
  let uShift = -Infinity;
  if (!flags.lockEvents && loot.length > 0) { // SHIFT verboden zonder loot (kost) of als lockEvents actief is :contentReference[oaicite:14]{index=14}
    bestShift = bestShiftSwap({ game:g, players:P, meId: me.id, flagsRound: flags, cfg, intel });
    if (bestShift?.pair) {
      const hiIdx = highestLootCardIndex(loot);
      const costV = hiIdx >= 0 ? Number(loot[hiIdx]?.v||0) : 0;
      uShift = (baseU + bestShift.gain) - (cfg.wResource||0) * costV;
    }
  }

  // ---- candidate: SCOUT ----
  // in peek-mode meestal low value; alleen als noPeek effect actief is
  const noPeekArr = Array.isArray(flags.noPeek) ? flags.noPeek : [];
  const isNoPeek = noPeekArr.includes(String(me.id||""));
  const uScout = isNoPeek ? baseU + 0.8 : -Infinity;

  // filter op echte beschikbaarheid
  const opts = [];
  if (lootDeckLen > 0) opts.push({ kind:"SNATCH", u:uSnatch });
  if (actionDeckLen > 0) opts.push({ kind:"FORAGE", u:uForage });
  if (bestShift?.pair && uShift > -Infinity) opts.push({ kind:"SHIFT", u:uShift, swap: bestShift.pair });
  if (uScout > -Infinity) opts.push({ kind:"SCOUT", u:uScout });

  // kies beste, maar SHIFT alleen als gain groot genoeg
  opts.sort((a,b)=> b.u - a.u);
  const best = opts[0] || null;
  if (!best) return null;

  if (best.kind === "SHIFT") {
    const gainNet = best.u - Math.max(uSnatch, uForage);
    if (gainNet < (cfg.shiftMinGain||0)) {
      // SHIFT niet waard -> fallback
      return (uForage > uSnatch && actionDeckLen>0) ? { kind:"FORAGE" } : { kind:"SNATCH" };
    }
  }

  return best.kind === "SHIFT" ? { kind:"SHIFT", swap: best.swap } : { kind: best.kind };
}

// APPLY helper voor MOVE (SHIFT-cost): remove hoogste loot en unshift naar bottom lootDeck
export function applyShiftCost({ loot, lootDeck }) {
  const L = Array.isArray(loot) ? [...loot] : [];
  const D = Array.isArray(lootDeck) ? [...lootDeck] : [];
  const i = highestLootCardIndex(L);
  if (i < 0) return { loot: L, lootDeck: D, paid: null };
  const [paid] = L.splice(i,1);
  // deck top = pop(), dus bottom = unshift() :contentReference[oaicite:15]{index=15}
  D.unshift(paid);
  return { loot: L, lootDeck: D, paid };
}

// js/bots/core/strategy.js (vervolg)

// dry-run: pas een subset toe (zoals je live ook doet)
function applyActionDryRun(state, play, cfg) {
  const s = deepClone(state);
  const { game:g, players:P } = s;
  const flags = s.flagsRound || (s.flagsRound = {});
  const meId = String(play.by);

  const cardName = String(play.name || "").trim();

  // helpers
  const me = P.find(p => String(p.id)===meId);

  if (cardName === "Den Signal") {
    const c = normColor(play.denColor || me?.color);
    const denImmune = { ...(flags.denImmune || {}) };
    if (c) denImmune[c] = true;
    flags.denImmune = denImmune;
  }

  if (cardName === "Burrow Beacon") {
    flags.lockEvents = true;
  }

  if (cardName === "Hold Still") {
    const t = String(play.targetId||"");
    if (t) {
      const hs = { ...(flags.holdStill || {}) };
      hs[t] = true;
      flags.holdStill = hs;
    }
  }

  if (cardName === "Mask Swap") {
    const tId = String(play.targetId||"");
    const t = P.find(p => String(p.id)===tId);
    if (me && t) {
      const a = normColor(me.color);
      const b = normColor(t.color);
      if (a && b && a !== b) {
        me.color = b; me.den = b;
        t.color = a; t.den = a;
      }
    }
  }

  if (cardName === "Pack Tinker" && !flags.lockEvents) {
    // deterministische “beste swap” (zelfde als SHIFT zoek, maar pak alleen 1 pair)
    const intel = getPeekIntel({ game:g, player:me, flagsRound:flags, lookaheadN: cfg.lookaheadN });
    const best = bestShiftSwap({ game:g, players:P, meId: me?.id, flagsRound: flags, cfg, intel });
    if (best?.pair) {
      const [i,j] = best.pair;
      const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
      g.eventTrack = swapInPlace(track, i, j);
    }
  }

  if (cardName === "Kick Up Dust" && !flags.lockEvents) {
    // random shuffle → verwacht voordeel = 35% van “beste swap” (optimisme-factor)
    const intel = getPeekIntel({ game:g, player:me, flagsRound:flags, lookaheadN: cfg.lookaheadN });
    const best = bestShiftSwap({ game:g, players:P, meId: me?.id, flagsRound: flags, cfg, intel });
    if (best?.pair) {
      const [i,j] = best.pair;
      const track = Array.isArray(g.eventTrack) ? g.eventTrack : [];
      // apply best-case maar discount later in score
      g.eventTrack = swapInPlace(track, i, j);
      s._kickDiscount = 0.35;
    }
  }

  if (cardName === "Nose for Trouble") {
    // in peek-mode is dit super: prediction = next event
    const intel = getPeekIntel({ game:g, player:me, flagsRound:flags, lookaheadN: cfg.lookaheadN });
    flags.predictions = Array.isArray(flags.predictions) ? flags.predictions : [];
    flags.predictions = flags.predictions.filter(x => String(x?.playerId) !== meId);
    if (intel.nextId) flags.predictions.push({ playerId: meId, eventId: intel.nextId });
  }

  return s;
}

function actionHoldPenalty(cardName, intel, me, cfg) {
  // simpele hold logic: bewaar “counters” als relevant event binnen horizon
  const horizon = Math.max(1, Number(cfg.holdHorizon||2));
  const upcoming = Array.isArray(intel.upcomingIds) ? intel.upcomingIds.slice(0, horizon) : [];

  if (cardName === "Den Signal") {
    const myC = normColor(me?.color);
    const relevant = upcoming.some(ev => (ev==="DOG_CHARGE"||ev==="SECOND_CHARGE") || (isDenEvent(ev) && denColorFromEvent(ev)===myC));
    return relevant ? 0.9 : 0; // “bewaarwaarde”
  }

  if (cardName === "Alpha Call") {
    const relevant = upcoming.includes("MAGPIE_SNITCH") || upcoming.includes("SILENT_ALARM");
    return relevant ? 0.7 : 0;
  }

  return 0;
}

// combo search (max 2): evalueer A en A->B dry-run. Speel alleen als netto winst > comboMinGain.
export function evaluateOpsActions({ game, bot, players, flagsRound, cfg = BOT_UTILITY_CFG }) {
  const g = game || {};
  const me = bot || {};
  const P = Array.isArray(players) ? players.map(p => (String(p.id)===String(me.id) ? me : p)) : [me];
  const flags = flagsRound || {};

  const intel = getPeekIntel({ game:g, player:me, flagsRound:flags, lookaheadN: cfg.lookaheadN });
  const nextId = intel.nextId;

  // OPS locked => pass
  if (flags.opsLocked) return null;

  const hand = Array.isArray(me.hand) ? me.hand : [];
  if (!hand.length) return null;

  // baseline
  const baseState = { game: deepClone(g), players: deepClone(P), flagsRound: deepClone(flags) };
  const baseU = stateUtility({ game: baseState.game, players: baseState.players, meId: me.id, flagsRound: baseState.flagsRound, cfg, nextEventId: nextId });

  // candidates: alleen kaarten die jij daadwerkelijk kan spelen (naam moet matchen in hand)
  const cards = hand.map(c => String(c?.name || c || "").trim()).filter(Boolean);

  const plays = cards.map(name => {
    const def = getActionDefByName(name);
    return { name, actionId: def?.id || null, by: me.id };
  });

  // targetting helpers
  const enemies = P.filter(p => p && String(p.id)!==String(me.id) && !isAlly(me,p) && p.inYard !== false);
  const allies  = P.filter(p => p && String(p.id)!==String(me.id) && isAlly(me,p) && p.inYard !== false);
  const richestEnemy = [...enemies].sort((a,b)=> sumLootPoints(b.loot)-sumLootPoints(a.loot))[0] || null;
  const biggestHandEnemy = [...enemies].sort((a,b)=> (b.hand?.length||0)-(a.hand?.length||0))[0] || null;

  function withTarget(play){
    if (play.name === "Mask Swap") return { ...play, targetId: richestEnemy?.id || null };
    if (play.name === "Hold Still") return { ...play, targetId: biggestHandEnemy?.id || richestEnemy?.id || null };
    if (play.name === "Den Signal") return { ...play, denColor: normColor(me.color) }; // team-synergy default
    return play;
  }

  // score single
  let bestSingle = { u: -Infinity, play: null };

  for (const p0 of plays) {
    const play0 = withTarget(p0);
    if (!play0.name) continue;

    const holdPen = actionHoldPenalty(play0.name, intel, me, cfg);

    const s1 = applyActionDryRun(baseState, play0, cfg);
    const intel1 = getPeekIntel({ game:s1.game, player: s1.players.find(x=>String(x.id)===String(me.id)), flagsRound:s1.flagsRound, lookaheadN: cfg.lookaheadN });

    let u1 = stateUtility({ game:s1.game, players:s1.players, meId: me.id, flagsRound:s1.flagsRound, cfg, nextEventId: intel1.nextId });

    // discount Kick Up Dust optimism
    if (play0.name === "Kick Up Dust") {
      const disc = Number(s1._kickDiscount || 0.35);
      u1 = baseU + (u1 - baseU) * disc;
    }

    u1 -= (cfg.wResource||0) * holdPen;

    if (u1 > bestSingle.u) bestSingle = { u: u1, play: play0 };
  }

  // score combo A->B (max 2 kaarten)
  const p2 = clamp(Number(cfg.comboSecondTurnBaseProb||0.55), 0, 1);
  let bestCombo = { u: -Infinity, playA: null };

  for (const a0 of plays) {
    const A = withTarget(a0);
    const sA = applyActionDryRun(baseState, A, cfg);
    const intelA = getPeekIntel({ game:sA.game, player: sA.players.find(x=>String(x.id)===String(me.id)), flagsRound:sA.flagsRound, lookaheadN: cfg.lookaheadN });
    const uA = stateUtility({ game:sA.game, players:sA.players, meId: me.id, flagsRound:sA.flagsRound, cfg, nextEventId: intelA.nextId });

    for (const b0 of plays) {
      if (String(b0.name) === String(A.name)) continue; // zelfde kaart 2x: kan, maar skip voor nu
      const B = withTarget(b0);

      const sAB = applyActionDryRun(sA, B, cfg);
      const intelAB = getPeekIntel({ game:sAB.game, player: sAB.players.find(x=>String(x.id)===String(me.id)), flagsRound:sAB.flagsRound, lookaheadN: cfg.lookaheadN });
      const uAB = stateUtility({ game:sAB.game, players:sAB.players, meId: me.id, flagsRound:sAB.flagsRound, cfg, nextEventId: intelAB.nextId });

      // combo utility = uA nu + kans op tweede * (uAB - uA)
      const uCombo = uA + p2 * (uAB - uA);

      if (uCombo > bestCombo.u) bestCombo = { u: uCombo, playA: A };
    }
  }

  const best = (bestCombo.u > bestSingle.u + (cfg.comboMinGain||0)) ? { u: bestCombo.u, play: bestCombo.playA } : bestSingle;

  // PASS als geen duidelijke winst vs baseline
  if (!best.play) return null;
  if (best.u < baseU + 0.25) return null;

  return best.play;
}
// js/bots/core/strategy.js (vervolg)

export function evaluateDecision({ game, bot, players, flagsRound, cfg = BOT_UTILITY_CFG }) {
  const g = game || {};
  const me = bot || {};
  const P = Array.isArray(players) ? players.map(p => (String(p.id)===String(me.id) ? me : p)) : [me];
  const flags = flagsRound || {};

  const intel = getPeekIntel({ game:g, player:me, flagsRound:flags, lookaheadN: cfg.lookaheadN });
  const nextId = intel.nextId;

  // forced by Hold Still?
  const hs = flags?.holdStill || {};
  if (hs && hs[String(me.id)]) return { decision: "LURK", reason: "HOLD_STILL_FORCED" };

  const isLead = computeIsLead({ game:g, player:me, players:P });

  const dashPush = estimateDashPush({ player: me, cfg, game:g });

  const lurkSurv = survivalProbNextEvent({ eventId: nextId, decision:"LURK", game:g, player:me, flagsRound:flags, isLead });
  const dashSurv = survivalProbNextEvent({ eventId: nextId, decision:"DASH", game:g, player:me, flagsRound:flags, isLead });

  const canBurrow = !me.burrowUsed;
  const burSurv = canBurrow
    ? survivalProbNextEvent({ eventId: nextId, decision:"BURROW", game:g, player:me, flagsRound:flags, isLead })
    : 0;

  const stayRisk = (1 - Math.max(lurkSurv, burSurv || 0)) * 10;
  const dashRisk = (1 - dashSurv) * 10;
  const burRisk  = (1 - burSurv) * 10;

  // ---- HARD RULE: anti-suicide lurk ----
  if (stayRisk >= (cfg.panicStayRisk||7.5) && dashRisk <= (cfg.safeDashRisk||3.0)) {
    return { decision: "DASH", reason: "ANTI_SUICIDE_LURK" };
  }

  // ---- Evaluate utility explicitly (zelf) ----
  const lootPts = sumLootPoints(me.loot);
  const alarmDash = silentAlarmLootPenalty({ eventId: nextId, decision:"DASH", player:me, isLead });
  const alarmLurk = silentAlarmLootPenalty({ eventId: nextId, decision:"LURK", player:me, isLead });
  const alarmBur  = silentAlarmLootPenalty({ eventId: nextId, decision:"BURROW", player:me, isLead });

  const uDash = dashSurv * lootPts - (1-dashSurv)*lootPts - alarmDash + (dashPush/10)*0.8;
  const uLurk = lurkSurv * lootPts - (1-lurkSurv)*lootPts - alarmLurk;
  const uBur  = canBurrow ? (burSurv * lootPts - (1-burSurv)*lootPts - alarmBur - 0.5) : -Infinity;

  // ---- dash trigger ----
  const dashTriggered = dashPush >= (cfg.dashPushThreshold||6.2) && dashRisk <= stayRisk + 0.5;

  // ---- burrow trigger ----
  const burSafetyGain = stayRisk - burRisk;
  const burTriggered =
    canBurrow &&
    stayRisk >= (cfg.panicStayRisk||7.5) &&
    dashRisk >= (cfg.panicStayRisk||7.5) &&
    burSafetyGain >= (cfg.burrowMinSafetyGain||2.0);

  if (burTriggered) return { decision:"BURROW", reason:"BURROW_SAFETY_WINDOW" };
  if (dashTriggered) return { decision:"DASH", reason:"DASH_PUSH_TRIGGER" };

  // anders hoogste utility
  let best = { decision:"LURK", u:uLurk, reason:"MAX_U" };
  if (uDash > best.u) best = { decision:"DASH", u:uDash, reason:"MAX_U" };
  if (uBur  > best.u) best = { decision:"BURROW", u:uBur, reason:"MAX_U" };

  // HARD RULE: burrowUsed => nooit BURROW
  if (best.decision === "BURROW" && !canBurrow) return { decision:"LURK", reason:"BURROW_FORBIDDEN" };

  return { decision: best.decision, reason: best.reason, debug: { dashPush, stayRisk, dashRisk, burRisk } };
}
