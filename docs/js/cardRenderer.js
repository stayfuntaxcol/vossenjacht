import {
  CARD_BACK,
  getEventById,
  getActionDefByName,
  getLootImageForType,
} from "./cards.js";

// Kaartframes voor spelers per Den-kleur
const PLAYER_CARD_IMAGES = {
  RED: "./assets/card_player1.png",
  BLUE: "./assets/card_player2.png",
  GREEN: "./assets/card_player3.png",
  YELLOW: "./assets/card_player4.png",
  LEAD: "./assets/card_player5.png", // speciale frame voor Lead Fox
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
 * Basiskaart: gedeelde layout voor alle kaarttypen (event, action, loot, player).
 * - variant: "event" | "action" | "loot" | "player" | etc.
 * - size: "small" | "medium" | "large"
 */
function createBaseCard({
  imageUrl,
  title,
  subtitle,
  footer,
  variant = "",
  size = "medium",
  extraClasses = [],
}) {
  const card = document.createElement("div");
  card.className = `vj-card vj-card--${variant} vj-card--${size}`;

  // veilige background met fallback
  applySafeBackground(card, imageUrl);

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

  // optionele extra klassen (bv. neon rand voor Lead Fox)
  extraClasses.forEach((cls) => {
    if (cls) card.classList.add(cls);
  });

  return card;
}

// =========================
// EVENT CARDS
// =========================

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

export function renderActionCard(actionCard, opts = {}) {
  if (!actionCard) return null;

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

export function renderLootCard(lootCard, opts = {}) {
  if (!lootCard) return null;

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
 * player = { name, color, ... }
 */
export function renderPlayerSlotCard(player, opts = {}) {
  if (!player) return null;

  // Firestore gebruikt "color" (RED/BLUE/GREEN/YELLOW)
  const denColorRaw = player.denColor || player.den || player.color || "";
  const denColor = denColorRaw.toUpperCase();
  const isLead = Boolean(player.isLead || opts.isLead);

  // Kies frame op basis van Den-kleur en Lead-status
  let imageUrl = PLAYER_CARD_IMAGES[denColor] || CARD_BACK;
  if (isLead && PLAYER_CARD_IMAGES.LEAD) {
    imageUrl = PLAYER_CARD_IMAGES.LEAD;
  }

  const title = player.name || "Fox";
  const subtitle =
    opts.subtitle ||
    (denColor ? `Den: ${denColor}` : "");
  const footer = isLead ? (opts.footer || "Lead Fox") : (opts.footer || "Player");

  const extraClasses = [];
  if (isLead) extraClasses.push("vj-card--lead");

  return createBaseCard({
    imageUrl,
    title,
    subtitle,
    footer,
    variant: "player",
    size: opts.size || "medium",
    extraClasses,
  });
}
