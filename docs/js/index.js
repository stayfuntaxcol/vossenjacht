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

// simpele code-generator, bv. ABCD of J5K9
function generateCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

initAuth((user) => {
  const hostBtn      = document.getElementById("hostGameBtn");
  const joinBtn      = document.getElementById("joinGameBtn");
  const boardOnlyBtn = document.getElementById("boardOnlyBtn"); // NIEUW
  const nameInput    = document.getElementById("playerName");
  const codeInput    = document.getElementById("joinCode");

  // Safety-check: als de knoppen/inputs ontbreken, gewoon stoppen
  if (!hostBtn || !joinBtn || !nameInput || !codeInput) {
    console.warn("Join/host UI elementen niet gevonden op deze pagina.");
    return;
  }

  // --- code uit URL (voor QR) uitlezen en invullen ---
  try {
    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = params.get("code");
    if (codeFromUrl) {
      codeInput.value = codeFromUrl.toUpperCase();
      // Handig: cursor direct in naamveld
      nameInput.focus();
    }
  } catch (e) {
    console.warn("Kon querystring niet parsen:", e);
  }
  // --- EINDE URL-code ---

  // 1) HOST SPEELT MEE ALS VOS
  hostBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      alert("Vul je naam in");
      return;
    }

    const code = generateCode();

    // nieuw spel (raid nog NIET geïnitialiseerd)
    const gameRef = await addDoc(collection(db, "games"), {
      code,
      status: "lobby",
      phase: "MOVE",
      round: 0,
      currentEventId: null,
      createdAt: serverTimestamp(),
      hostUid: user.uid,
      raidStarted: false,
      raidEndedByRooster: false,
      roosterSeen: 0,
    });

    // host als eerste speler (EggRun-statevelden alvast klaarzetten)
    await addDoc(collection(db, "games", gameRef.id, "players"), {
      name,
      uid: user.uid,
      isHost: true,
      score: 0,
      joinedAt: serverTimestamp(),
      joinOrder: null,
      color: null,
      inYard: true,
      dashed: false,
      burrowUsed: false,
      decision: null,
      hand: [],
      loot: [],
    });

    // naar host-scherm met gameId in "host"-modus
    window.location.href = `host.html?game=${gameRef.id}&mode=host`;
  });

  // 2) ALLEEN COMMUNITY BOARD (GEEN HOST-SPELER)
  if (boardOnlyBtn) {
    boardOnlyBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        alert("Vul je naam in (voor de host)");
        return;
      }

      const code = generateCode();

      const gameRef = await addDoc(collection(db, "games"), {
        code,
        status: "lobby",
        phase: "MOVE",
        round: 0,
        currentEventId: null,
        createdAt: serverTimestamp(),
        hostUid: user.uid,
        raidStarted: false,
        raidEndedByRooster: false,
        roosterSeen: 0,
      });

      // LET OP: GEEN players-doc aanmaken hier!

      // Community Board zonder host-speler
      window.location.href = `host.html?game=${gameRef.id}&mode=board`;
    });
  }

  // 3) NORMAAL JOINEN ALS SPELER
  joinBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const inputCode = codeInput.value.trim().toUpperCase();

    if (!name || !inputCode) {
      alert("Naam én code invullen");
      return;
    }

    // zoek spel met deze code
    const q = query(collection(db, "games"), where("code", "==", inputCode));
    const snap = await getDocs(q);

    if (snap.empty) {
      alert("Geen spel gevonden met deze code");
      return;
    }

    const gameDoc = snap.docs[0];

    // speler toevoegen met EggRun-velden
    const playerRef = await addDoc(
      collection(db, "games", gameDoc.id, "players"),
      {
        name,
        uid: user.uid,
        isHost: false,
        score: 0,
        joinedAt: serverTimestamp(),
        joinOrder: null,
        color: null,
        inYard: true,
        dashed: false,
        burrowUsed: false,
        decision: null,
        hand: [],
        loot: [],
      }
    );

    // naar speler-scherm met game + player id
    window.location.href = `player.html?game=${gameDoc.id}&player=${playerRef.id}`;
  });
});
