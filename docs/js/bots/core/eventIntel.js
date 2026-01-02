// Map jouw event IDs naar tags. Begin klein en breid uit.
// Voorbeeld IDs die jij eerder noemde:
const EVENT_TAGS = {
  SHEEPDOG_PATROL: ["CATCH_DASHERS"],
  BURROW_BEACON: ["LOCK_EVENTS"],
  FINAL_ROOSTER_CROW: ["CATCH_ALL_YARD"],
  // voeg hier jouw echte IDs toe
};

export function getUpcomingEvents(view, horizon = 2) {
  const track = view.eventTrack || [];
  const cursor = Math.max(0, view.eventCursor || 0);
  const upcoming = [];
  for (let i = 0; i < horizon; i++) {
    const id = track[cursor + i];
    if (!id) continue;
    upcoming.push({
      id,
      tags: EVENT_TAGS[id] || [],
    });
  }
  return upcoming;
}

export function hasTag(upcoming, tag) {
  return upcoming.some((e) => (e.tags || []).includes(tag));
}
