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
  return upper(a.type ?? a.kind ?? a.actionType ?? a.action ?? "");
}

function pickMoveName(a) {
  // move-fase keuze
  return upper(a.move ?? a.value ?? a.choice ?? a.payload?.move ?? "");
}

function pickDecision(a) {
  return upper(a.decision ?? a.value ?? a.choice ?? a.payload?.decision ?? "");
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
  const eventCursor = num(
    game.eventCursor ?? game.eventIndex ?? game.roundEventIndex ?? 0,
    0
  );

  const flags = game.flags ?? {};

  const raidKey = game.raidId ?? game.raid ?? game.raidIndex ?? game.raidNo ?? null;

  const myId = me.id;
  const myActions = (actions || []).filter((a) => pickActionPlayerId(a) === myId);

  // --- MOVE keuze deze ronde (SNATCH/SCOUT/FORRAGE/SHIFT) ---
  let moveChosenThisRound = null;

  // --- SCOUT intel (deze ronde) ---
  const knownEvents = [];
  const knownEventPositions = [];

  for (const a of myActions) {
    const aRound = pickActionRound(a);
    if (aRound !== null && num(aRound, -1) !== round) continue;

    const t = pickActionType(a);
    const move = pickMoveName(a);

    // MOVE detectie: type bevat MOVE of move is één van de moves
    const isMove =
      t.includes("MOVE") ||
      ["SNATCH", "SCOUT", "FORRAGE", "SHIFT"].includes(move);

    if (isMove && !moveChosenThisRound && ["SNATCH", "SCOUT", "FORRAGE", "SHIFT"].includes(move)) {
      moveChosenThisRound = move;
    }

    if (move === "SCOUT" || t.includes("SCOUT")) {
      const { eventId, pos } = pickScoutPayload(a);
      if (eventId) knownEvents.push(eventId);
      if (pos !== null && pos !== undefined) knownEventPositions.push(pos);
    }
  }

  // --- BURROW used this raid (afgeleid uit Decision actions) ---
  let burrowUsedThisRaid = 0;
  for (const a of myActions) {
    const aRaid = pickActionRaid(a);
    if (raidKey !== null && aRaid !== null && String(aRaid) !== String(raidKey)) continue;

    const t = pickActionType(a);
    const d = pickDecision(a);
    const isDecision = t.includes("DEC") || t.includes("DECISION") || ["LURK", "BURROW", "DASH"].includes(d);
    if (isDecision && d === "BURROW") burrowUsedThisRaid++;
  }

  const burrowLimitThisRaid = num(
    me.burrowLimitThisRaid ?? me.burrowLimitRaid ?? me.burrowLimit ?? 1,
    1
  );
  const burrowRemaining = Math.max(0, burrowLimitThisRaid - burrowUsedThisRaid);

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

      // derived:
      moveChosenThisRound, // "SNATCH"|"SCOUT"|"FORRAGE"|"SHIFT"|null
      knownEvents,
      knownEventPositions,

      burrowUsedThisRaid,
      burrowLimitThisRaid,
      burrowRemaining,
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
