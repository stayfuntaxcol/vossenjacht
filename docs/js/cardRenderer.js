import {
  CARD_BACK,
  getEventById,
  getActionDefByName,
  getLootImageForType,
  getPlayerProfileById,
  getActivityById,
} from "./cards.js";

// Kaartframes voor spelers per Den-kleur
const PLAYER_CARD_IMAGES = {
  RED: "./assets/card_player1.png",
  BLUE: "./assets/card_player2.png",
  GREEN: "./assets/card_player3.png",
  YELLOW: "./assets/card_player4.png",
  LEAD: "./assets/card_player5.png", // speciale frame voor Lead Fox (optioneel)
};

/**
 * Zet veilig een achtergrondafbeelding op een kaart.
 * Als de image niet bestaat of niet laadt, valt hij terug op CARD_BACK.
 */
function applySafeBackground(cardElem, imageUrl) {
  const url = imageUrl || CARD_BACK;
  const img = new Image();
  img.onload = () => {
    cardElem.style.backgroundImage = `url(${url})`;
  };
  img.onerror = () => {
    cardElem.style.backgroundImage = `url(${CARD_BACK})`;
  };
  img.src = url;
}

/**
 * Basiskaart: gedeelde layout voor alle kaarttypen (event, action, loot, player, activity).
 * - variant: "event" | "action" | "loot" | "player" | "activity" | etc.
 * - size: "small" | "medium" | "large"
 * - extraClasses: extra CSS-klassen, bv. ["vj-card--lead"]
 * - noOverlay: als true → geen tekst-overlay (alleen full-art image + rand)
 */
function createBaseCard({
  imageUrl,
  title,
  subtitle,
  footer,
  variant = "",
  size = "medium",
  extraClasses = [],
  noOverlay = false,
}) {
  const card = document.createElement("div");
  card.className = `vj-card vj-card--${variant} vj-card--${size}`;

  // veilige background met fallback
  applySafeBackground(card, imageUrl);

  // Tekst-overlay alleen als noOverlay === false
  if (!noOverlay) {
    const overlay = document.createElement("div");
    overlay.className = "vj-card__overlay";

    const top = document.createElement("div");
    const t = document.createElement("div");
    t.className = "vj-card__title";
    t.textContent = title || "";
    top.appendChild(t);

    if (subtitle) {
      const s = document.createElement("div");
      s.className = "vj-card__subtitle";
      s.textContent = subtitle;
      top.appendChild(s);
    }

    const bottom = document.createElement("div");
    if (footer) {
      const f = document.createElement("div");
      f.className = "vj-card__footer";
      f.textContent = footer;
      bottom.appendChild(f);
    }

    overlay.appendChild(top);
    overlay.appendChild(bottom);
    card.appendChild(overlay);
  }

  // optionele extra klassen (bv. neon rand voor Lead Fox / Den-kleur)
  extraClasses.forEach((cls) => {
    if (cls) card.classList.add(cls);
  });

  return card;
}

// =========================
// EVENT CARDS
// =========================

/**
 * Render een Event Card op basis van eventId (DEN_RED, ROOSTER_CROW, etc.).
 * Gebruikt de data uit EVENT_DEFS (cards.js).
 */
export function renderEventCard(eventId, opts = {}) {
  const ev = getEventById(eventId);
  if (!ev) return null;

  const size = opts.size || "large";
  const footer = opts.footer || "Event – toegepast in REVEAL";

  return createBaseCard({
    imageUrl: ev.imageFront || CARD_BACK,
    title: ev.title,
    subtitle: ev.text,
    footer,
    variant: "event",
    size,
  });
}

// =========================
// ACTION CARDS (hand)
// =========================

/**
 * Render een Action Card uit de hand.
 * actionCard = { id, name, ... } (bijv. uit Firestore)
 */
export function renderActionCard(actionCard, opts = {}) {
  const key = actionCard.name || actionCard.id;
  const def = getActionDefByName(key);

  const imageUrl =
    (def && def.imageFront) ||
    (def && def.fallbackFront) ||
    CARD_BACK;

  const size = opts.size || "medium";
  const subtitle = opts.subtitle || def?.description || "";
  const footer = opts.footer || "Action Card";

  return createBaseCard({
    imageUrl,
    title: def?.name || key,
    subtitle,
    footer,
    variant: "action",
    size,
  });
}

// =========================
// LOOT CARDS
// =========================

/**
 * Render een Loot Card.
 * lootCard = { t: "Egg"|"Hen"|"Prize Hen", v: 1|3|5 }
 */
export function renderLootCard(lootCard, opts = {}) {
  const img = getLootImageForType(lootCard.t);
  const title = lootCard.t || "Loot";
  const value = lootCard.v ?? "?";
  const footer = opts.footer || `Waarde: ${value} pt`;

  return createBaseCard({
    imageUrl: img,
    title,
    subtitle: opts.subtitle || "",
    footer,
    variant: "loot",
    size: opts.size || "small",
  });
}

// =========================
// PLAYER SLOT CARDS
// =========================

/**
 * Render een spelerkaart voor het scoreboard / community board.
 * player = Firestore player-doc (met .color / .denColor / .den)
 * - Geen tekst-overlay
 * - Glow rand in Den-kleur
 * - 🦊 icoon rechtsboven als Lead Fox
 */
export function renderPlayerSlotCard(player, opts = {}) {
  if (!player) return null;

  // Den-kleur bepalen: eerst .color (uit game), anders .denColor / .den
  let denColor = "";
  if (player.color) {
    denColor = String(player.color).toUpperCase();
  } else if (player.denColor) {
    denColor = String(player.denColor).toUpperCase();
  } else if (player.den) {
    denColor = String(player.den).toUpperCase();
  }

  const isLead = Boolean(player.isLead || opts.isLead);

  // Kies frame op basis van Den-kleur
  let imageUrl = CARD_BACK;
  if (denColor && PLAYER_CARD_IMAGES[denColor]) {
    imageUrl = PLAYER_CARD_IMAGES[denColor];
  }

  const extraClasses = [];
  if (denColor) {
    extraClasses.push("vj-card--den-" + denColor.toLowerCase());
  }
  if (isLead) {
    extraClasses.push("vj-card--lead");
  }

  // Geen tekst-overlay meer: alleen full-art kaart + glow/icoontje
  return createBaseCard({
    imageUrl,
    title: "",
    subtitle: "",
    footer: "",
    variant: "player",
    size: opts.size || "medium",
    extraClasses,
    noOverlay: true,
  });
}

// =========================
// PLAYER PROFILE CARDS
// =========================

/**
 * Render een Player Profile Card (lange-termijn rol/ability).
 * profileId = "SCOUT" | "MUSCLE" | "TRICKSTER" | ...
 */
export function renderPlayerProfileCard(profileId, opts = {}) {
  const profile = getPlayerProfileById(profileId);
  if (!profile) return null;

  const size = opts.size || "medium";
  const footer = opts.footer || "Player Profile";

  return createBaseCard({
    imageUrl: profile.imageFront || CARD_BACK,
    title: profile.title,
    subtitle: profile.text,
    footer,
    variant: "player",
    size,
  });
}

// =========================
// ACTIVITY CARDS
// =========================

/**
 * Render een Special Activity Card.
 * activityId = "CAMPFIRE_STORY" | "TRAINING_DRILL" | "NIGHT_RECON" | ...
 */
export function renderActivityCard(activityId, opts = {}) {
  const activity = getActivityById(activityId);
  if (!activity) return null;

  const size = opts.size || "medium";
  const footer =
    opts.footer ||
    (activity.phase === "pre_raid"
      ? "Pre-Raid Activity"
      : activity.phase === "post_raid"
      ? "Post-Raid Activity"
      : "Activity");

  return createBaseCard({
    imageUrl: activity.imageFront || CARD_BACK,
    title: activity.title,
    subtitle: activity.text,
    footer,
    variant: "activity",
    size,
  });
}
