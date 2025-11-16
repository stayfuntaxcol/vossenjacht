// js/player_profile_log.js
// Zorgt voor Tab 2 (Player Profile) en Tab 4 (Community Log)

import { initAuth } from "./firebase.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

const params = new URLSearchParams(window.location.search);
const gameId = params.get("game");
const playerId = params.get("player");

// DOM refs – PROFIEL
const profileMyDiv = document.getElementById("profileMy");
const profileOthersListDiv = document.getElementById("profileOthersList");
const profileOthersDetailDiv = document.getElementById("profileOthersDetail");

// DOM refs – LOG
const communityLogDiv = document.getElementById("communityLog");
const logFilterButtons = document.querySelectorAll("[data-log-filter]");

let allPlayersCache = [];
let logEntriesCache = [];
let currentLogFilter = "all";

// ====== Helpers ======

function renderPlayerProfileCard(player) {
  const colorKey = (player.color || "RED").toUpperCase();
  const img = PLAYER_CARD_IMAGES[colorKey] || PLAYER_CARD_IMAGES.RED;
  return createBaseCard({
    imageUrl: img,
    title: player.name || "Onbekende vos",
    subtitle: `Den: ${player.color || "n.n.b."}`,
    footer: `Loot: ${player.loot?.length || 0} kaarten`,
    variant: "player",
    size: "large",
  });
}


function sortPlayersByJoinOrder(players) {
  return [...players].sort((a, b) => {
    const aj = a.joinOrder ?? 0;
    const bj = b.joinOrder ?? 0;
    return aj - bj;
  });
}

function summarizeLoot(lootArray, scoreField) {
  let eggs = 0;
  let hens = 0;
  let prize = 0;
  let pointsFromLoot = 0;

  (Array.isArray(lootArray) ? lootArray : []).forEach((card) => {
    const label = (card.t || "").toLowerCase();
    const v = Number(card.v || 0);
    pointsFromLoot += v;

    if (label.includes("prize")) {
      prize += 1;
    } else if (label.includes("hen")) {
      hens += 1;
    } else if (label.includes("egg")) {
      eggs += 1;
    }
  });

  const totalPoints =
    typeof scoreField === "number" && !Number.isNaN(scoreField)
      ? scoreField
      : pointsFromLoot;

  return { eggs, hens, prize, pointsFromLoot, totalPoints };
}

function statusLabelForPlayer(p) {
  if (p.dashed) return "Dashed (weggerend)";
  if (p.inYard === false) return "Caught (gevangen)";
  return "In Yard";
}

function denLabel(p) {
  return p.denColor || p.color || "Onbekend";
}

// ====== PROFIEL RENDERING ======

function renderProfile(players) {
  allPlayersCache = players;
  if (!profileMyDiv) return;

  profileMyDiv.innerHTML = "";
  if (profileOthersListDiv) profileOthersListDiv.innerHTML = "";
  if (profileOthersDetailDiv) profileOthersDetailDiv.innerHTML = "";

  const sorted = sortPlayersByJoinOrder(players);
  const me = sorted.find((p) => p.id === playerId) || null;
  const others = sorted.filter((p) => p.id !== playerId);

  // Mijn kaart
  if (!me) {
    const msg = document.createElement("div");
    msg.textContent = "Speler niet gevonden in deze game.";
    msg.style.fontSize = "0.85rem";
    msg.style.opacity = "0.8";
    profileMyDiv.appendChild(msg);
  } else {
    const card = document.createElement("div");
    card.className = "vj-profile-card";

    const title = document.createElement("h3");
    title.textContent = me.name || "Onbekende vos";
    card.appendChild(title);

    const tagline = document.createElement("div");
    tagline.className = "vj-profile-tagline";
    tagline.textContent = `Den-kleur: ${denLabel(me)}`;
    card.appendChild(tagline);

    const badges = document.createElement("div");
    badges.className = "vj-profile-badges";

    const statusBadge = document.createElement("span");
    statusBadge.className = "vj-badge";
    statusBadge.textContent = statusLabelForPlayer(me);
    badges.appendChild(statusBadge);

    if (me.isLeadFox) {
      const leadBadge = document.createElement("span");
      leadBadge.className = "vj-badge vj-badge-safe";
      leadBadge.textContent = "Lead Fox";
      badges.appendChild(leadBadge);
    }

    if (me.burrowUsed) {
      const burrowBadge = document.createElement("span");
      burrowBadge.className = "vj-badge";
      burrowBadge.textContent = "Burrow gebruikt";
      badges.appendChild(burrowBadge);
    }

    card.appendChild(badges);

    const lootSummary = summarizeLoot(me.loot || [], me.score);
    const lootLine = document.createElement("div");
    lootLine.className = "vj-profile-stat";
    lootLine.textContent = `Buit: ${lootSummary.eggs}× Egg · ${lootSummary.hens}× Hen · ${lootSummary.prize}× Prize Hen`;
    card.appendChild(lootLine);

    const scoreLine = document.createElement("div");
    scoreLine.className = "vj-profile-stat";
    scoreLine.textContent = `Totaal punten (huidig): ${lootSummary.totalPoints}`;
    card.appendChild(scoreLine);

    profileMyDiv.appendChild(card);
  }

  // Overige spelers
  if (!profileOthersListDiv) return;

  if (!others.length) {
    const msg = document.createElement("div");
    msg.textContent = "Nog geen andere spelers in deze game.";
    msg.style.fontSize = "0.8rem";
    msg.style.opacity = "0.8";
    profileOthersListDiv.appendChild(msg);
    return;
  }

  const list = document.createElement("div");
  list.className = "vj-profile-list";

  others.forEach((p, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";

    const left = document.createElement("span");
    left.className = "vj-profile-list-name";
    left.textContent = p.name || "Speler";

    const right = document.createElement("span");
    right.className = "vj-profile-list-meta";
    right.textContent = `${denLabel(p)} · ${statusLabelForPlayer(p)}`;

    btn.appendChild(left);
    btn.appendChild(right);

    btn.addEventListener("click", () => {
      renderOtherDetail(p);
      // active highlight
      const siblings = list.querySelectorAll("button");
      siblings.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });

    if (idx === 0) {
      btn.classList.add("active");
    }

    list.appendChild(btn);
  });

  profileOthersListDiv.appendChild(list);

  // Detail van eerste speler tonen
  if (others[0]) {
    renderOtherDetail(others[0]);
  }
}

function renderOtherDetail(p) {
  if (!profileOthersDetailDiv) return;
  profileOthersDetailDiv.innerHTML = "";

  const card = document.createElement("div");
  card.className = "vj-profile-card";

  const title = document.createElement("h3");
  title.textContent = p.name || "Speler";
  card.appendChild(title);

  const tagline = document.createElement("div");
  tagline.className = "vj-profile-tagline";
  tagline.textContent = `Den-kleur: ${denLabel(p)}`;
  card.appendChild(tagline);

  const badges = document.createElement("div");
  badges.className = "vj-profile-badges";

  const statusBadge = document.createElement("span");
  statusBadge.className = "vj-badge";
  statusBadge.textContent = statusLabelForPlayer(p);
  badges.appendChild(statusBadge);

  if (p.isLeadFox) {
    const leadBadge = document.createElement("span");
    leadBadge.className = "vj-badge vj-badge-safe";
    leadBadge.textContent = "Lead Fox";
    badges.appendChild(leadBadge);
  }

  if (p.burrowUsed) {
    const burrowBadge = document.createElement("span");
    burrowBadge.className = "vj-badge";
    burrowBadge.textContent = "Burrow gebruikt";
    badges.appendChild(burrowBadge);
  }

  card.appendChild(badges);

  const lootSummary = summarizeLoot(p.loot || [], p.score);
  const lootLine = document.createElement("div");
  lootLine.className = "vj-profile-stat";
  lootLine.textContent = `Buit: ${lootSummary.eggs}× Egg · ${lootSummary.hens}× Hen · ${lootSummary.prize}× Prize Hen`;
  card.appendChild(lootLine);

  const scoreLine = document.createElement("div");
  scoreLine.className = "vj-profile-stat";
  scoreLine.textContent = `Totaal punten (huidig): ${lootSummary.totalPoints}`;
  card.appendChild(scoreLine);

  profileOthersDetailDiv.appendChild(card);
}

// ====== LOG RENDERING ======

function applyLogFilter(filter) {
  currentLogFilter = filter;
  if (!communityLogDiv) return;

  communityLogDiv.innerHTML = "";

  const entries = logEntriesCache.filter((e) => {
    if (filter === "me") {
      return e.playerId === playerId;
    }
    return true;
  });

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "vj-log-empty";
    empty.textContent = "Nog geen logregels voor deze selectie.";
    communityLogDiv.appendChild(empty);
    return;
  }

  entries.forEach((e) => {
    const item = document.createElement("div");
    item.className = "vj-log-entry";
    if (e.playerId === playerId) {
      item.classList.add("me");
    }

    const header = document.createElement("div");
    header.className = "vj-log-entry-header";

    const left = document.createElement("span");
    const r = e.round ?? "?";
    const phase = e.phase ?? "?";
    const kind = e.kind ?? "";
    left.textContent = `[R${r} – ${phase}${kind ? " – " + kind : ""}]`;

    const right = document.createElement("span");
    right.textContent = e.playerName || "";
    right.style.opacity = "0.85";

    header.appendChild(left);
    header.appendChild(right);

    const body = document.createElement("div");
    body.className = "vj-log-entry-body";
    body.textContent = e.message || "";

    item.appendChild(header);
    item.appendChild(body);
    communityLogDiv.appendChild(item);
  });
}

function renderLog(entries) {
  logEntriesCache = entries;
  applyLogFilter(currentLogFilter);
}

// ====== INIT SNAPSHOTS ======

initAuth(() => {
  if (!gameId) return;

  // Players -> Profiel tab
  if (profileMyDiv || profileOthersListDiv || profileOthersDetailDiv) {
    const playersCol = collection(db, "games", gameId, "players");
    onSnapshot(playersCol, (snap) => {
      const players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderProfile(players);
    });
  }

  // Log -> Community Log tab
  if (communityLogDiv) {
    const logCol = collection(db, "games", gameId, "log");
    const logQuery = query(logCol, orderBy("createdAt", "desc"), limit(50));

    onSnapshot(logQuery, (snap) => {
      const entries = [];
      snap.forEach((docSnap) =>
        entries.push({ id: docSnap.id, ...docSnap.data() })
      );
      entries.reverse(); // meest recente onderaan
      renderLog(entries);
    });
  }

  // Filter-knoppen
  if (logFilterButtons && logFilterButtons.length) {
    logFilterButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const filter = btn.getAttribute("data-log-filter") || "all";
        logFilterButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyLogFilter(filter);
      });
    });
  }
});
