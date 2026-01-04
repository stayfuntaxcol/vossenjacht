// /bots/core/eventIntel.js
// Leest Event tags direct uit cards.js (EVENT_DEFS) → single source of truth.

import { getEventById } from "../../cards.js"; // pad: /bots/core -> /cards.js

function safeArr(a) {
  return Array.isArray(a) ? a : [];
}

function normTag(x) {
  return String(x || "").trim().toUpperCase();
}

function buildTagSet(tags) {
  const set = new Set();
  for (const t of safeArr(tags)) {
    const raw = String(t || "").trim();
    if (!raw) continue;
    set.add(raw);              // originele tag
    set.add(normTag(raw));     // uppercase variant
  }
  return set;
}

export function getUpcomingEvents(view, horizon = 2) {
  const track = safeArr(view?.eventTrack);
  const cursor = Math.max(0, Number(view?.eventCursor || 0));

  const upcoming = [];
  for (let i = 0; i < horizon; i++) {
    const id = track[cursor + i];
    if (!id) continue;

    const ev = getEventById(id);
    const tags = safeArr(ev?.tags);

    upcoming.push({
      id,
      title: ev?.title || id,
      category: ev?.category || null,
      denColor: ev?.denColor || null,
      tags,
      _tagSet: buildTagSet(tags), // intern: snelle lookup
    });
  }
  return upcoming;
}

export function hasTag(upcoming, tag) {
  const needle = normTag(tag);
  return safeArr(upcoming).some((e) => {
    const set =
      e?._tagSet instanceof Set ? e._tagSet : buildTagSet(e?.tags);
    return set.has(tag) || set.has(needle);
  });
}
