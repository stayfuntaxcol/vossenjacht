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
 * entry:
 *  - round: nummer
 *  - phase: "MOVE" | "ACTIONS" | "DECISION" | "REVEAL"
 *  - kind: "SYSTEM" | "EVENT" | "DECISION" | "SCORE" | "ACTION_CARD"
 *  - message: string
 *  - optioneel: playerId, playerName, cardId, details
 */
export async function addLog(gameId, entry) {
  const logCol = collection(db, "games", gameId, "log");
  await addDoc(logCol, {
    createdAt: serverTimestamp(),
    ...entry,
  });
}
