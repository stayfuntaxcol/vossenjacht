export function buildPlayerView({ game, me, players }) {
  // Only keep what a normal player should know.
  // Pas dit aan als jouw game object andere velden heeft.
  return {
    phase: game.phase ?? game.state ?? "UNKNOWN",
    round: game.round ?? game.roundIndex ?? 0,

    // eventTrack is vaak publiek (of deels). Als het bij jou verborgen is, kun je hier maskeren.
    eventTrack: Array.isArray(game.eventTrack) ? game.eventTrack : [],
    eventCursor:
      game.eventCursor ?? game.eventIndex ?? game.roundEventIndex ?? 0,

    flags: game.flags ?? {},
    me: {
      id: me.id,
      name: me.name,
      den: me.den ?? me.denColor ?? null,
      decision: me.decision ?? null,
      loot: me.loot ?? me.score ?? 0,
      hand: Array.isArray(me.hand) ? me.hand : [], // action cards ids
      status: me.status ?? null,
    },

    playersPublic: (players || []).map((p) => ({
      id: p.id,
      name: p.name,
      den: p.den ?? p.denColor ?? null,
      // decision van anderen is meestal verborgen -> NIET opnemen.
      status: p.status ?? null,
      loot: p.loot ?? p.score ?? null, // alleen als dit publiek hoort te zijn
    })),
  };
}
