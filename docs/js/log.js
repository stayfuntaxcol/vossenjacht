// /log.js
// Centrale logger voor Vossenjacht (Firestore)
// - Backwards compatible met je huidige entries
// - Voeg optioneel: type, actorId, payload, clientAt toe
// - Houdt het simpel: géén extra writes, alleen rijkere logregels

import "./firebase.js"; // zorgt dat initializeApp wordt uitgevoerd

import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

/**
 * Voeg een logregel toe aan games/{gameId}/log.
 *
 * entry (backwards compatible):
 *  - round: number
 *  - phase: "MOVE" | "ACTIONS" | "DECISION" | "REVEAL" | "RESOLVE"
 *  - kind: "SYSTEM" | "EVENT" | "DECISION" | "SCORE" | "ACTION_CARD"
 *  - message: string
 *  - optioneel: playerId, playerName, cardId, details
 *
 * Nieuwe (aanrader) velden:
 *  - type: string (bijv. "MOVE_CHOSEN" | "OPS_PLAYED" | "DECISION_CHOSEN" | "EVENT_REVEALED")
 *  - actorId: string (player/bot id; fallback = playerId)
 *  - payload: object (gestructureerde data voor Advisor/Bots)
 *  - move: string (snelle index)
 *  - decision: string (snelle index)
 *  - clientAt: number (Date.now(); handig als createdAt nog null is)
 */
export async function addLog(gameId, entry = {}) {
  if (!gameId) throw new Error("addLog: missing gameId");

  // OFF | BUFFER | FIRESTORE
  const mode = (() => {
    try {
      const w = typeof window !== "undefined" ? window : null;
      return String(w?.__VJ_LOG_MODE__ || "OFF").toUpperCase();
    } catch {
      return "OFF";
    }
  })();

  if (mode === "OFF") return; // ✅ geen writes, engine blijft werken

  const e = entry || {};
  const actorId = e.actorId || e.playerId || null;

  const message =
    typeof e.message === "string"
      ? e.message
      : (e.message == null ? "" : String(e.message));

  const payload = e.payload && typeof e.payload === "object" ? e.payload : null;
  const details = e.details && typeof e.details === "object" ? e.details : (e.details ?? null);

  const docData = {
    createdAt: mode === "FIRESTORE" ? serverTimestamp() : null, // sentinel alleen als we echt schrijven
    clientAt: typeof e.clientAt === "number" ? e.clientAt : Date.now(),

    round: Number.isFinite(Number(e.round)) ? Number(e.round) : null,
    phase: e.phase ?? null,
    kind: e.kind ?? "SYSTEM",

    type: e.type ?? null,
    actorId,
    choice: e.choice ?? null,

    playerId: e.playerId ?? null,
    playerName: e.playerName ?? null,
    cardId: e.cardId ?? null,

    move: e.move ?? null,
    decision: e.decision ?? null,

    payload,
    message,
    details,
  };

  if (mode === "BUFFER") {
    const w = typeof window !== "undefined" ? window : null;
    if (!w) return;
    if (!Array.isArray(w.__VJ_LOG_BUFFER__)) w.__VJ_LOG_BUFFER__ = [];
    w.__VJ_LOG_BUFFER__.push({ gameId, ...docData });
    // cap buffer
    if (w.__VJ_LOG_BUFFER__.length > 500) w.__VJ_LOG_BUFFER__.splice(0, w.__VJ_LOG_BUFFER__.length - 500);
    return;
  }

  // FIRESTORE
  const logCol = collection(db, "games", gameId, "log");
  await addDoc(logCol, docData);
}

// --- Optionele helpers (geen Firestore reads/writes) ---

export const LOG_TYPES = Object.freeze({
  MOVE_CHOSEN: "MOVE_CHOSEN",
  OPS_PLAYED: "OPS_PLAYED",
  OPS_PASSED: "OPS_PASSED",
  DECISION_CHOSEN: "DECISION_CHOSEN",
  EVENT_REVEALED: "EVENT_REVEALED",
  FLAG_SET: "FLAG_SET",
  FLAG_CLEARED: "FLAG_CLEARED",
  PLAYER_CAUGHT: "PLAYER_CAUGHT",
  SACK_CHANGED: "SACK_CHANGED",
});

export function mkLog({
  round,
  phase,
  kind = "SYSTEM",
  type = null,
  actorId = null,
  playerId = null,
  playerName = null,
  cardId = null,
  move = null,
  decision = null,
  payload = null,
  message = "",
  details = null,
} = {}) {
  return {
    round,
    phase,
    kind,
    type,
    actorId: actorId || playerId || null,
    playerId,
    playerName,
    cardId,
    move,
    decision,
    payload,
    message,
    details,
  };
}

/**
 * Korte formatter voor UI-tekst (optioneel).
 * Als je zelf overal message bouwt, hoef je dit niet te gebruiken.
 */
export function formatLogMessage(e = {}) {
  const p = e.playerName ? `${e.playerName}: ` : "";
  const t = e.type ? `[${e.type}] ` : "";
  return `${t}${p}${e.message || ""}`.trim();
}
