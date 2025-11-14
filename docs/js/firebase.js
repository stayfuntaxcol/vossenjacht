console.log("firebase.js geladen");

// vervang 10.12.4 door de versie uit je Firebase CDN-snippet indien anders
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyB_u6nKuM0JUv6lLksiAmExiEB3_wrCthA",
  authDomain: "vossenjacht-7b5b8.firebaseapp.com",
  projectId: "vossenjacht-7b5b8",
  storageBucket: "vossenjacht-7b5b8.firebasestorage.app",
  messagingSenderId: "562443901152",
  appId: "1:562443901152:web:b951cc10fb540bbae05885",
  measurementId: "G-Y2SWPY1QZE"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export function initAuth(onReady) {
  signInAnonymously(auth).catch((err) => {
    console.error("Anon sign-in fout:", err);
  });

  onAuthStateChanged(auth, (user) => {
    if (user) {
      console.log("Ingelogd als", user.uid);
      onReady(user);
    }
  });
}
