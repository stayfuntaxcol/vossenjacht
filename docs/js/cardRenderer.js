// cardRenderer.js
// Centrale renderer voor alle kaart-achtige elementen in Vossenjacht.

import {
  CARD_BACK,
  getEventById,
  getActionDefByName,
  getLootImageForType,
  getPlayerProfileById,
  getActivityById,
} from "./cards.js";

// ==========================================
//  VASTE ART PER SPELER-NAAM
//  (maak deze bestanden in /assets)
// ==========================================

const PLAYER_NAME_ART = {
  jafeth: "./assets/card_player_jafeth.png",
  seth: "./assets/card_player_seth.png",
  larah: "./assets/card_player_larah.png",
  steve: "./assets/card_player_steve.png",
  meerjam: "./assets/card_player_meerjam.png",
  bill: "./assets/card_player_bill.png",
  cary: "./assets/card_player_cary.png",
  logan: "./assets/card_player_logan.png",
  mirjam: "./assets/card_player_meerjam.png",
  wim: "./assets/card_player_bill.png",
  hans: "./assets/card_player_hans.png",
  stephan: "./assets/card_player_steve.png",
  quintin: "./assets/card_player_meerjam.png",
  yannick: "./assets/card_player_bill.png", 
  teun: "./assets/card_player_teun.png",
  dirk: "./assets/card_player_dirk.png",
  janjacob: "./assets/card_player_jj.png",
  steun: "./assets/card_player_steun.png",
  jochem: "./assets/card_player_jochem.png",
  lieke: "./assets/card_player_lieke.png",
  gj: "./assets/card_player_gj.png",
  johanna: "./assets/card_player_johanna.png",
  matthias: "./assets/card_player_matthias.png",
  vis: "./assets/card_player_vis.png",
  hut: "./assets/card_player_hut.png",
  joh: "./assets/card_player_joh.png",
  mat: "./assets/card_player_mat.png",
  mitch: "./assets/card_player_mitch.png",
  teagon: "./assets/card_player_teagon.png",
  
};

// Fallback art per seat / joinOrder (zoals je nu al gebruikt)
const PLAYER_SLOT_ART = [
  "./assets/card_player1.png",
  "./assets/card_player2.png",
  "./assets/card_player3.png",
  "./assets/card_player4.png",
  "./assets/card_player5.png",
];

// ==========================================
//  HELPER: veilige achtergrond zetten
// ==========================================

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

// ==========================================
//  GENERIEKE KAART-FACTORY
// ==========================================

/**
 * Maakt een basiskaart-div:
 * - variant: "event" | "action" | "loot" | "player" | "activity"
 * - size: "small" | "medium" | "large"
 * - extraClasses: extra CSS-klassen (bv. vj-card--den-red, vj-card--lead)
 * - noOverlay: true → alleen full-art image, geen tekst-overlay
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

  const classes = ["vj-card"];
  if (variant) classes.push(`vj-card--${variant}`);
  if (size) classes.push(`vj-card--${size}`);
  card.className = classes.join(" ");

  // veilige achtergrond met fallback
  applySafeBackground(card, imageUrl);

  // Tekst-overlay alleen als noOverlay === false
  if (!noOverlay) {
    const overlay = document.createElement("div");
    overlay.className = "vj-card__overlay";

    const top = document.createElement("div");
    top.className = "vj-card__overlay-top";

    const titleEl = document.createElement("div");
    titleEl.className = "vj-card__title";
    titleEl.textContent = title || "";
    top.appendChild(titleEl);

    if (subtitle) {
      const subEl = document.createElement("div");
      subEl.className = "vj-card__subtitle";
      subEl.textContent = subtitle;
      top.appendChild(subEl);
    }

    const bottom = document.createElement("div");
    bottom.className = "vj-card__overlay-bottom";

    if (footer) {
      const footerEl = document.createElement("div");
      footerEl.className = "vj-card__footer";
      footerEl.textContent = footer;
      bottom.appendChild(footerEl);
    }

    overlay.appendChild(top);
    overlay.appendChild(bottom);
    card.appendChild(overlay);
  }

  // extra klassen (bv. glow per Den-kleur, lead indicator)
  extraClasses.forEach((cls) => {
    if (cls) card.classList.add(cls);
  });

  return card;
}

// ==========================================
//  EVENT CARDS
// ==========================================

/**
 * Render een Event Card op basis van eventId.
 * Gebruikt EVENT_DEFS via getEventById.
 */
export function renderEventCard(eventId, opts = {}) {
  const ev = getEventById(eventId);
  if (!ev) return null;

  return createBaseCard({
    imageUrl: ev.imageFront || CARD_BACK,
    title: ev.title,
    subtitle: ev.text || "",
    footer: opts.footer || "Event",
    variant: "event",
    size: opts.size || "large",
    extraClasses: opts.extraClasses || [],
    noOverlay: !!opts.noOverlay,
  });
}

// ==========================================
//  ACTION CARDS (HAND)
// ==========================================

/**
 * Render een Action Card uit de hand.
 * actionCard = { id, name, ... } (zoals in Firestore)
 */
export function renderActionCard(actionCard, opts = {}) {
  if (!actionCard) return null;

  const key = actionCard.name || actionCard.id || "Action";
  const def = getActionDefByName(key);

  const imageUrl =
    (def && (def.imageFront || def.fallbackFront)) || CARD_BACK;

  const title = def?.name || key;
  const subtitle =
    opts.subtitle || def?.description || def?.text || "";
  const footer = opts.footer || "Action Card";

  return createBaseCard({
    imageUrl,
    title,
    subtitle,
    footer,
    variant: "action",
    size: opts.size || "medium",
    extraClasses: opts.extraClasses || [],
    noOverlay: !!opts.noOverlay,
  });
}

// ==========================================
//  LOOT CARDS
// ==========================================

/**
 * Render een Loot Card.
 * lootCard = { t: "Egg"|"Hen"|"Prize Hen", v: 1|2|3, ... }
 */
export function renderLootCard(lootCard, opts = {}) {
  if (!lootCard) return null;

  const type = lootCard.t || lootCard.type || "Loot";
  const value = lootCard.v ?? "?";

  const img = getLootImageForType(type) || CARD_BACK;

  return createBaseCard({
    imageUrl: img,
    title: type,
    subtitle: opts.subtitle || "",
    footer: opts.footer || `Waarde: ${value}`,
    variant: "loot",
    size: opts.size || "small",
    extraClasses: opts.extraClasses || [],
    noOverlay: !!opts.noOverlay,
  });
}

// ==========================================
//  PLAYER SLOT CARDS (COMMUNITY BOARD, ETC.)
// ==========================================

/**
 * Render een spelerkaart voor scoreboard / community board.
 * Regels:
 * 1. Als player.name matcht met een entry in PLAYER_NAME_ART:
 *    → gebruik die afbeelding (blijft constant hele game).
 * 2. Anders: fallback naar PLAYER_SLOT_ART op basis van slotIndex/joinOrder.
 * 3. Den-kleur beïnvloedt alleen CSS-glow (vj-card--den-red, etc.), niet de art.
 * 4. Lead Fox krijgt extra class vj-card--lead (neon).
 */
export function renderPlayerSlotCard(player, opts = {}) {
  if (!player) return null;

  // --- 1) Probeer eerst art op basis van spelernaam ---
  let imageUrl = CARD_BACK;

  const rawName = (player.name || "").trim();
  const nameKey = rawName.toLowerCase();

  if (nameKey && PLAYER_NAME_ART[nameKey]) {
    imageUrl = PLAYER_NAME_ART[nameKey];
  } else {
    // --- 2) Fallback: seat / joinOrder art ---
    let slotIndex = 0;

    if (typeof opts.slotIndex === "number") {
      slotIndex = opts.slotIndex;
    } else if (typeof player.joinOrder === "number") {
      slotIndex = player.joinOrder;
    }

    if (!Number.isFinite(slotIndex)) slotIndex = 0;
    if (slotIndex < 0) slotIndex = Math.abs(slotIndex);

    const hasArtList = PLAYER_SLOT_ART && PLAYER_SLOT_ART.length > 0;
    const artIndex = hasArtList ? slotIndex % PLAYER_SLOT_ART.length : 0;

    imageUrl =
      (hasArtList && PLAYER_SLOT_ART[artIndex]) || CARD_BACK;
  }

  // --- 3) Den-kleur → alleen CSS-classes (glow) ---
  let denColor = "";
  if (player.color) {
    denColor = String(player.color).toUpperCase();
  } else if (player.denColor) {
    denColor = String(player.denColor).toUpperCase();
  } else if (player.den) {
    denColor = String(player.den).toUpperCase();
  }

  const isLead = Boolean(player.isLead || opts.isLead);

  const extraClasses = opts.extraClasses
    ? [...opts.extraClasses]
    : [];

  if (denColor) {
    extraClasses.push("vj-card--den-" + denColor.toLowerCase());
  }
  if (isLead) {
    extraClasses.push("vj-card--lead");
  }

  // Geen tekst-overlay: alleen full-art + glow/icoon
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

// ==========================================
//  PLAYER PROFILE CARDS
// ==========================================

/**
 * Lange-termijn rol / ability kaart.
 * profileId = "SCOUT" | "MUSCLE" | "TRICKSTER" | ...
 */
export function renderPlayerProfileCard(profileId, opts = {}) {
  const profile = getPlayerProfileById(profileId);
  if (!profile) return null;

  return createBaseCard({
    imageUrl: profile.imageFront || CARD_BACK,
    title: profile.title,
    subtitle: profile.text || "",
    footer: opts.footer || "Player Profile",
    variant: "player",
    size: opts.size || "medium",
    extraClasses: opts.extraClasses || [],
  });
}

// ==========================================
//  SPECIAL ACTIVITY CARDS
// ==========================================

/**
 * Special Activity Card.
 * activityId = "CAMPFIRE_STORY" | "TRAINING_DRILL" | ...
 */
export function renderActivityCard(activityId, opts = {}) {
  const activity = getActivityById(activityId);
  if (!activity) return null;

  let defaultFooter = "Activity";
  if (activity.phase === "pre_raid") defaultFooter = "Pre-Raid Activity";
  else if (activity.phase === "post_raid") defaultFooter = "Post-Raid Activity";

  return createBaseCard({
    imageUrl: activity.imageFront || CARD_BACK,
    title: activity.title,
    subtitle: activity.text || "",
    footer: opts.footer || defaultFooter,
    variant: "activity",
    size: opts.size || "medium",
    extraClasses: opts.extraClasses || [],
  });
}
