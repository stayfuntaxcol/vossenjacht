import { CARD_BACK, getEventById, getActionDefByName, getLootImageForType } from "./cards.js";

function createBaseCard({ imageUrl, title, subtitle, footer, variant = "", size = "medium" }) {
  const card = document.createElement("div");
  card.className = `vj-card vj-card--${variant} vj-card--${size}`;
  card.style.backgroundImage = `url(${imageUrl || CARD_BACK})`;

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

const PLAYER_CARD_IMAGES = {
  RED: "./assets/card_player1.png",
  BLUE: "./assets/card_player2.png",
  GREEN: "./assets/card_player3.png",
  YELLOW: "./assets/card_player4.png",
  LEAD: "./assets/card_player5.png", // bijv. speciale frame voor Lead Fox
};
  
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

  return card;
}

// Event card
export function renderEventCard(eventId, opts = {}) {
  const ev = getEventById(eventId);
  if (!ev) return null;
  return createBaseCard({
    imageUrl: ev.imageFront || CARD_BACK,
    title: ev.title,
    subtitle: ev.text,
    footer: "Event – toegepast in REVEAL",
    variant: "event",
    size: opts.size || "large",
  });
}

// Action card (hand)
export function renderActionCard(actionCard, opts = {}) {
  // actionCard = { id, name, ... } uit Firestore
  const def = getActionDefByName(actionCard.name || actionCard.id);
  const imageUrl =
    (def && def.imageFront) ||
    (def && def.fallbackFront) ||
    CARD_BACK;

  return createBaseCard({
    imageUrl,
    title: def?.name || actionCard.name || actionCard.id,
    subtitle: opts.subtitle || "",
    footer: "Action Card",
    variant: "action",
    size: opts.size || "medium",
  });
}

// Loot card
export function renderLootCard(lootCard, opts = {}) {
  // lootCard = { t: "Egg"|"Hen"|"Prize Hen", v: 1|2|3 }
  const img = getLootImageForType(lootCard.t);
  const title = lootCard.t || "Loot";
  const footer = `Waarde: ${lootCard.v ?? "?"} pt`;

  return createBaseCard({
    imageUrl: img,
    title,
    subtitle: "",
    footer,
    variant: "loot",
    size: opts.size || "small",
  });
}
