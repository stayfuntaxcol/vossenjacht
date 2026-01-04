// ./bots/botProfiles.js

export const BOT_PROFILES = {
  GREEDY: {
    moveWeights: { SNATCH: 55, FORAGE: 15, SCOUT: 10, SHIFT: 20 },
    decision(ctx) {
      const lootCount = Array.isArray(ctx.me.loot) ? ctx.me.loot.length : 0;
      const rooster = Number(ctx.game.roosterSeen || 0);
      if (lootCount >= 3) return "DASH";
      if (rooster >= 2 && lootCount >= 2) return "DASH";
      return "LURK";
    },
    actionPlayChance: 0.75,
  },

  CAUTIOUS: {
    moveWeights: { SNATCH: 20, FORAGE: 20, SCOUT: 35, SHIFT: 25 },
    decision(ctx) {
      const lootCount = Array.isArray(ctx.me.loot) ? ctx.me.loot.length : 0;
      const rooster = Number(ctx.game.roosterSeen || 0);
      if (rooster >= 2 && lootCount >= 1) return "DASH";
      if (lootCount >= 4) return "DASH";
      return !ctx.me.burrowUsed ? "BURROW" : "LURK";
    },
    actionPlayChance: 0.55,
  },

  BALANCED: {
    moveWeights: { SNATCH: 35, FORAGE: 25, SCOUT: 20, SHIFT: 20 },
    decision(ctx) {
      const lootCount = Array.isArray(ctx.me.loot) ? ctx.me.loot.length : 0;
      const rooster = Number(ctx.game.roosterSeen || 0);
      if (lootCount >= 3 && rooster >= 1) return "DASH";
      if (!ctx.me.burrowUsed && rooster >= 2) return "BURROW";
      return "LURK";
    },
    actionPlayChance: 0.65,
  },
};

export function pickProfile(name) {
  return BOT_PROFILES[name] || BOT_PROFILES.BALANCED;
}

export function weightedPick(weights) {
  const entries = Object.entries(weights || {});
  const total = entries.reduce((s, [, w]) => s + Math.max(0, Number(w) || 0), 0);
  if (!total) return entries[0]?.[0] || null;

  let r = Math.random() * total;
  for (const [k, wRaw] of entries) {
    const w = Math.max(0, Number(wRaw) || 0);
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1]?.[0] || null;
}
