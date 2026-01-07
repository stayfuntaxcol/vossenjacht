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

  const logCol = collection(db, "games", gameId, "log");

  const e = entry || {};
  const actorId = e.actorId || e.playerId || null;

  // Minimal sanity: message string
  const message =
    typeof e.message === "string"
      ? e.message
      : (e.message == null ? "" : String(e.message));

  // Zorg dat payload/ details geen functies bevatten (Firestore faalt daarop)
  const payload =
    e.payload && typeof e.payload === "object" ? e.payload : null;

  const details =
    e.details && typeof e.details === "object" ? e.details : (e.details ?? null);

  const docData = {
    createdAt: serverTimestamp(),
    clientAt: typeof e.clientAt === "number" ? e.clientAt : Date.now(),

    round: Number.isFinite(Number(e.round)) ? Number(e.round) : null,
    phase: e.phase ?? null,
    kind: e.kind ?? "SYSTEM",

    // nieuw (machine-friendly)
    type: e.type ?? null,
    actorId,
    choice: e.choice ?? null,
    
    // legacy / UI friendly
    playerId: e.playerId ?? null,
    playerName: e.playerName ?? null,
    cardId: e.cardId ?? null,

    // snelle velden (optioneel, maar handig voor filteren)
    move: e.move ?? null,
    decision: e.decision ?? null,

    payload,
    message,
    details,
  };

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
