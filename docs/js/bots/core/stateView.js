// /bots/core/stateView.js
// PlayerView = “fair” snapshot: alleen wat een normale speler hoort te weten.
// Inclusief BURROW-schaarste velden zodat de advisor geen dom advies geeft.

function num(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function buildPlayerView({ game = {}, me = {}, players = [] }) {
  // --- phase/round ---
  const phase = game.phase ?? game.state ?? "UNKNOWN";
  const round = num(game.round ?? game.roundIndex ?? game.roundNo, 0);

  // --- event track/cursor ---
  const eventTrack = Array.isArray(game.eventTrack) ? game.eventTrack : [];
  const eventCursor = num(
    game.eventCursor ?? game.eventIndex ?? game.roundEventIndex ?? 0,
    0
  );

  // --- flags ---
  const flags = game.flags ?? {};

  // --- BURROW scarcity (pas veldnamen aan als je ze al hebt) ---
  // Ondersteunt meerdere mogelijke veldnamen zodat het niet crasht.
  const burrowUsedThisRaid = num(
    me.burrowUsedThisRaid ??
      me.burrowUsedRaid ??
      me.burrowUsed ??
      me.burrowCountUsed ??
      0,
    0
  );

  const burrowLimitThisRaid = num(
    me.burrowLimitThisRaid ??
      me.burrowLimitRaid ??
      me.burrowLimit ??
      1, // default: 1x per Raid
    1
  );

  const burrowRemaining = Math.max(0, burrowLimitThisRaid - burrowUsedThisRaid);

  // --- me ---
  const meView = {
    id: me.id,
    name: me.name,
    den: me.den ?? me.denColor ?? null,
    decision: me.decision ?? null,
    loot: num(me.loot ?? me.score ?? 0, 0),
    hand: Array.isArray(me.hand) ? me.hand : [],
    status: me.status ?? null,

    // nieuw: advisor/bots kunnen hier rekening mee houden
    burrowUsedThisRaid,
    burrowLimitThisRaid,
    burrowRemaining,
  };

  // --- public players ---
  const playersPublic = (players || []).map((p) => ({
    id: p.id,
    name: p.name,
    den: p.den ?? p.denColor ?? null,
    status: p.status ?? null,
    loot: p.loot ?? p.score ?? null, // alleen als dit bij jou publiek is
  }));

  return {
    phase,
    round,
    eventTrack,
    eventCursor,
    flags,
    me: meView,
    playersPublic,
  };
}
