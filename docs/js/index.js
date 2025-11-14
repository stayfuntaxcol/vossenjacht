import { initAuth } from "./firebase.js";
import {
  getFirestore,
  addDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const db = getFirestore();

function generateCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

initAuth((user) => {
  const hostBtn = document.getElementById("hostGameBtn");
  const joinBtn = document.getElementById("joinGameBtn");
  const nameInput = document.getElementById("playerName");
  const codeInput = document.getElementById("joinCode");

  hostBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      alert("Vul je naam in");
      return;
    }

    const code = generateCode();

    // Nieuw spel
    const gameRef = await addDoc(collection(db, "games"), {
      code,
      status: "lobby",
      round: 0,
      phase: "MOVE",
      currentEventId: null,
      createdAt: serverTimestamp(),
      hostUid: user.uid,
    });

    // Host als eerste speler
    await addDoc(collection(db, "games", gameRef.id, "players"), {
      name,
      uid: user.uid,
      isHost: true,
      score: 0,
      joinedAt: serverTimestamp(),
    });

    window.location.href = `host.html?game=${gameRef.id}`;
  });

  joinBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const inputCode = codeInput.value.trim().toUpperCase();

    if (!name || !inputCode) {
      alert("Naam én code invullen");
      return;
    }

    const q = query(collection(db, "games"), where("code", "==", inputCode));
    const snap = await getDocs(q);

    if (snap.empty) {
      alert("Geen spel gevonden met deze code");
      return;
    }

    const gameDoc = snap.docs[0];

    const playerRef = await addDoc(
      collection(db, "games", gameDoc.id, "players"),
      {
        name,
        uid: user.uid,
        isHost: false,
        score: 0,
        joinedAt: serverTimestamp(),
      }
    );

    window.location.href = `player.html?game=${gameDoc.id}&player=${playerRef.id}`;
  });
});
