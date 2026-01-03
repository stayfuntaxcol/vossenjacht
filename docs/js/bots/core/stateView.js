// /bots/core/stateView.js

function num(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function upper(x) {
  return String(x || "").toUpperCase();
}

function pickActionPlayerId(a) {
  return a.playerId ?? a.player ?? a.uid ?? a.actorId ?? null;
}

function pickActionRound(a) {
  return a.round ?? a.roundIndex ?? a.roundNo ?? null;
}

function pickActionRaid(a) {
  return a.raidId ?? a.raid ?? a.raidIndex ?? a.raidNo ?? null;
}

function pickActionType(a) {
  // probeer meerdere velden
  return upper(a.type ?? a.kind ?? a.actionType ?? a.action ?? a.move ?? "");
}

function pickDecision(a) {
  return upper(a.decision ?? a.value ?? a.choice ?? a.payload?.decision ?? "");
}

function pickOpsMove(a) {
  return upper(a.move ?? a.ops ?? a.value ?? a.choice ?? a.payload?.move ?? "");
}

function pickScoutPayload(a) {
  const p = a.payload ?? {};
  return {
    eventId: p.eventId ?? a.eventId ?? p.id ?? null,
    pos: p.pos ?? p.position ?? a.pos ?? a.position ?? null,
  };
}

export function buildPlayerView({ game = {}, me = {}, players = [], actions = [] }) {
  const phase = game.phase ?? game.state ?? "UNKNOWN";
  const round = num(game.round ?? game.roundIndex ?? game.roundNo, 0);

  const eventTrack = Array.isArray(game.eventTrack) ? game.eventTrack : [];
  const eventCursor = num(game.eventCursor ?? game.eventIndex ?? game.roundEventIndex ?? 0, 0);

  const flags = game.flags ?? {};

  // --- identify raid key if available ---
  const raidKey = game.raidId ?? game.raid ?? game.raidIndex ?? game.raidNo ?? null;

  // --- filter my actions ---
  const myId = me.id;
  const myActions = (actions || []).filter(a => pickActionPlayerId(a) === myId);

  // --- ops taken this round ---
  const opsTakenThisRound = [];
  for (const a of myActions) {
    const aRound = pickActionRound(a);
    if (aRound !== null && num(aRound, -1) !== round) continue;

    const t = pickActionType(a);
    const move = pickOpsMove(a);
    // detecteer OPS acties op basis van type of move
    const isOps =
      t.includes("OPS") ||
      ["SNATCH", "FORRAGE", "SCOUT", "SHIFT"].includes(move);

    if (isOps && ["SNATCH", "FORRAGE", "SCOUT", "SHIFT"].includes(move)) {
      if (!opsTakenThisRound.includes(move)) opsTakenThisRound.push(move);
    }
  }

  // --- burrow used this raid (afgeleid uit actions) ---
  let burrowUsedThisRaid = 0;
  for (const a of myActions) {
    // match raid als mogelijk
    const aRaid = pickActionRaid(a);
    if (raidKey !== null && aRaid !== null && String(aRaid) !== String(raidKey)) continue;

    const t = pickActionType(a);
    const d = pickDecision(a);

    const isDecision = t.includes("DEC") || t.includes("DECISION") || d.length > 0;
    if (isDecision && d === "BURROW") burrowUsedThisRaid++;
  }

  // limit: default 1x per Raid
  const burrowLimitThisRaid = num(me.burrowLimitThisRaid ?? me.burrowLimitRaid ?? me.burrowLimit ?? 1, 1);
  const burrowRemaining = Math.max(0, burrowLimitThisRaid - burrowUsedThisRaid);

  // --- SCOUT intel count (afgeleid) ---
  const knownEvents = [];
  const knownEventPositions = [];
  for (const a of myActions) {
    const aRound = pickActionRound(a);
    if (aRound !== null && num(aRound, -1) !== round) continue; // alleen deze ronde (MVP)

    const t = pickActionType(a);
    const move = pickOpsMove(a);
    if (t.includes("SCOUT") || move === "SCOUT") {
      const { eventId, pos } = pickScoutPayload(a);
      if (eventId) knownEvents.push(eventId);
      if (pos !== null && pos !== undefined) knownEventPositions.push(pos);
    }
  }

  return {
    phase,
    round,
    eventTrack,
    eventCursor,
    flags,

    me: {
      id: me.id,
      name: me.name,
      den: me.den ?? me.denColor ?? null,
      decision: me.decision ?? null,
      loot: num(me.loot ?? me.score ?? 0, 0),
      hand: Array.isArray(me.hand) ? me.hand : [],
      status: me.status ?? null,

      // derived (uit actions)
      burrowUsedThisRaid,
      burrowLimitThisRaid,
      burrowRemaining,

      opsTakenThisRound,
      knownEvents,
      knownEventPositions,
    },

    playersPublic: (players || []).map((p) => ({
      id: p.id,
      name: p.name,
      den: p.den ?? p.denColor ?? null,
      status: p.status ?? null,
      loot: p.loot ?? p.score ?? null,
    })),
  };
}
