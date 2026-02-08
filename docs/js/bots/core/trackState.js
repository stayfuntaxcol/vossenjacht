// core/trackState.js
// Minimal track lock + memory validity via headVersion.
// - HEAD = eventTrack[0]
// - headVersion increases ONLY when HEAD changes (mutations or advancing reveal)
// - No-Go Zone locks HEAD for 1 round (preventing KickUpDust/SHIFT from changing it)

const DEFAULT_STATE = {
  headVersion: 0,
  headLockedUntilRound: 0,
  headLockedId: null,
  headLockedBy: null,
};

export function ensureTrackState(game) {
  if (!game.trackState) game.trackState = { ...DEFAULT_STATE };
  if (typeof game.trackState.headVersion !== "number") game.trackState.headVersion = 0;
  if (typeof game.trackState.headLockedUntilRound !== "number") game.trackState.headLockedUntilRound = 0;
  if (!("headLockedId" in game.trackState)) game.trackState.headLockedId = null;
  return game.trackState;
}

export function eventId(ev) {
  if (!ev) return null;
  // supports strings or objects like {id:"DEN_BLUE_CAUGHT", ...}
  return String(ev.id ?? ev);
}

export function getRawHeadId(game) {
  return eventId(game?.eventTrack?.[0]);
}

export function isHeadLocked(game, round) {
  const st = ensureTrackState(game);
  return Boolean(st.headLockedId) && Number(round) <= Number(st.headLockedUntilRound);
}

export function getEffectiveHeadId(game, round) {
  const st = ensureTrackState(game);
  if (isHeadLocked(game, round)) return st.headLockedId;
  return getRawHeadId(game);
}

export function clearExpiredHeadLock(game, round) {
  const st = ensureTrackState(game);
  if (st.headLockedUntilRound && Number(round) > Number(st.headLockedUntilRound)) {
    st.headLockedUntilRound = 0;
    st.headLockedId = null;
    st.headLockedBy = null;
  }
}

export function lockHeadForRound(game, round, byPlayerId = null) {
  const st = ensureTrackState(game);
  const head = getRawHeadId(game);
  if (!head) return;
  st.headLockedUntilRound = Number(round);
  st.headLockedId = head;
  st.headLockedBy = byPlayerId;
}

/**
 * Apply a track mutation while respecting an active HEAD lock.
 * - If locked: mutate only tail (index 1..end), keep HEAD fixed.
 * - If unlocked: mutate full track.
 * Bumps headVersion only if raw HEAD changed.
 */
export function applyTrackMutationKeepingHead({ game, round, mutateWhole, mutateTail }) {
  ensureTrackState(game);
  const prevHead = getRawHeadId(game);

  const track0 = Array.isArray(game.eventTrack) ? [...game.eventTrack] : [];
  if (!track0.length) return;

  let nextTrack = track0;

  if (isHeadLocked(game, round)) {
    const lockedId = game.trackState.headLockedId;
    // Safety: ensure locked event is at head if it exists elsewhere (should already be true)
    const idx = track0.findIndex((e) => eventId(e) === lockedId);
    if (idx > 0) {
      const tmp = track0[0];
      track0[0] = track0[idx];
      track0[idx] = tmp;
    }
    const head = track0[0];
    const tail = track0.slice(1);
    const newTail = typeof mutateTail === "function" ? mutateTail(tail) : tail;
    nextTrack = [head, ...newTail];
  } else {
    nextTrack = typeof mutateWhole === "function" ? mutateWhole(track0) : track0;
  }

  game.eventTrack = nextTrack;

  const newHead = getRawHeadId(game);
  if (prevHead && newHead && prevHead !== newHead) {
    game.trackState.headVersion += 1;
  }
}

/**
 * Call when the raid advances the event track after REVEAL.
 * Shifts head off and bumps headVersion if the new head differs.
 */
export function advanceEventTrackHead(game) {
  ensureTrackState(game);
  const prevHead = getRawHeadId(game);
  const track0 = Array.isArray(game.eventTrack) ? [...game.eventTrack] : [];
  if (!track0.length) return;
  track0.shift();
  game.eventTrack = track0;
  const newHead = getRawHeadId(game);
  if (prevHead !== newHead) game.trackState.headVersion += 1;
}

/**
 * Per-bot "memory / belief" resolver.
 * Use this from strategy/botRunner:
 * - If HEAD locked => confidence=1, source=LOCK
 * - Else if canPeek => confidence=1, source=PEEK
 * - Else if memory matches headVersion => source=MEMORY_VALID
 * - Else => MEMORY_STALE (lower confidence)
 */
export function getEffectiveNextEventIntel({ game, me, round, canPeek = true }) {
  ensureTrackState(game);
  clearExpiredHeadLock(game, round);

  const headVersion = game.trackState.headVersion;
  const locked = isHeadLocked(game, round);

  if (locked) {
    return {
      nextEventId: game.trackState.headLockedId,
      confidence: 1.0,
      source: "LOCK",
      headVersion,
      headLocked: true,
    };
  }

  const headId = getRawHeadId(game);

  if (canPeek && headId) {
    return {
      nextEventId: headId,
      confidence: 1.0,
      source: "PEEK",
      headVersion,
      headLocked: false,
    };
  }

  const mem = me?.memory || me?.intelMemory || null;
  const memId = mem?.nextEventId ? String(mem.nextEventId) : null;
  const memV = Number(mem?.knownAtHeadVersion ?? NaN);
  const memC = Number(mem?.confidence ?? 0.85);

  if (memId && Number.isFinite(memV) && memV === headVersion) {
    return {
      nextEventId: memId,
      confidence: clamp01(memC),
      source: "MEMORY_VALID",
      headVersion,
      headLocked: false,
    };
  }

  if (memId) {
    return {
      nextEventId: memId,
      confidence: clamp01(memC * 0.5),
      source: "MEMORY_STALE",
      headVersion,
      headLocked: false,
    };
  }

  return { nextEventId: null, confidence: 0.0, source: "UNKNOWN", headVersion, headLocked: false };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
