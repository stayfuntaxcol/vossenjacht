<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8" />
  <title>Vossenjacht – Spelerscherm</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Globale stijl (incl. cards, kleuren, etc.) -->
  <link rel="stylesheet" href="./css/style.css" />

  <!-- Card renderer (voor later: echte kaarten voor hand/loot) -->
  <script type="module" src="./js/cardRenderer.js"></script>

  <!-- Extra styles voor tabs, profiel, log, popup en nieuwe Fox-dashboard layout -->
  <style>
    /* Algemeen */
    body.player-screen {
      padding-bottom: 72px;
    }

    .hidden {
      display: none !important;
    }

    main {
      padding-bottom: 0.75rem;
    }

    /* ==============================
       TABS
       ============================== */

    .vj-tab-panel {
      display: none;
    }
    .vj-tab-panel.active {
      display: block;
    }

    /* Onderste tabbar */
    .vj-tabbar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 50;
      padding: 0.35rem 0.6rem;
      background: linear-gradient(to top, #020617, #020617dd);
      border-top: 1px solid #111827;
      display: flex;
      justify-content: center;
    }

    .vj-tabbar-inner {
      width: 100%;
      max-width: 520px;
      display: flex;
      gap: 0.4rem;
    }

    .vj-tab-button {
      flex: 1;
      border: none;
      border-radius: 999px;
      background: #020617;
      color: #9ca3af;
      font-size: 0.75rem;
      padding: 0.3rem 0.4rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.1rem;
      cursor: pointer;
      transition: background 0.1s ease, color 0.1s ease, transform 0.08s ease;
    }

    .vj-tab-button-icon {
      font-size: 1rem;
      line-height: 1;
    }

    .vj-tab-button span {
      font-size: 0.7rem;
      line-height: 1.1;
    }

    .vj-tab-button.active {
      background: #4f46e5;
      color: #e5e7eb;
      transform: translateY(-1px);
    }

    /* ==============================
       FOX DASHBOARD – SPELVERLOOP TAB
       ============================== */

    .player-dashboard {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .player-top {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    @media (min-width: 720px) {
      .player-top {
        flex-direction: row;
        align-items: stretch;
      }
    }

    .player-top-left,
    .player-top-right {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .player-header-card {
      border-radius: 0.9rem;
      padding: 0.75rem 0.9rem;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(148, 163, 184, 0.6);
    }

    .player-header-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #9ca3af;
      margin-bottom: 0.25rem;
    }

    #playerInfo > div:first-child {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.1rem;
    }

    #playerInfo > div:nth-child(2) {
      font-size: 0.8rem;
      opacity: 0.85;
      margin-bottom: 0.1rem;
    }

    #playerInfo > div:nth-child(3) {
      font-size: 0.85rem;
      margin-top: 0.15rem;
    }

    .player-status-bar {
      border-radius: 0.9rem;
      padding: 0.75rem 0.9rem;
      background: radial-gradient(circle at top, #0f172a, #020617);
      border: 1px solid rgba(148, 163, 184, 0.6);
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      font-size: 0.85rem;
    }

    .player-status-topline {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #e5e7eb;
    }

    .player-status-phase {
      color: #facc15;
    }

    .player-status-round {
      color: #93c5fd;
    }

    .player-event-box {
      margin-top: 0.35rem;
      border-radius: 0.7rem;
      padding: 0.55rem 0.6rem;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(55, 65, 81, 0.9);
      font-size: 0.85rem;
    }

    .player-event-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9ca3af;
      margin-bottom: 0.15rem;
    }

    /* Midden: hand + knoppen + decision */

    .player-middle {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    @media (min-width: 720px) {
      .player-middle {
        flex-direction: row;
        align-items: flex-start;
      }
    }

    .player-hand-area {
      flex: 2;
      border-radius: 0.9rem;
      padding: 0.75rem 0.9rem;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(31, 41, 55, 0.95);
    }

    .player-hand-area h2 {
      margin-top: 0;
      font-size: 0.95rem;
    }

    .player-hand {
      margin-top: 0.35rem;
    }

    .player-ops-info {
      font-size: 0.8rem;
      opacity: 0.85;
      margin-top: 0.35rem;
    }

    .player-ops-buttons {
      margin-top: 0.4rem;
      display: flex;
      justify-content: flex-end;
    }

    .player-ops-buttons button {
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.7);
      background: #020617;
      color: #e5e7eb;
      font-size: 0.8rem;
      padding: 0.25rem 0.7rem;
      cursor: pointer;
    }

    .player-move-decision {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .player-move-block,
    .player-decision-block {
      border-radius: 0.9rem;
      padding: 0.7rem 0.8rem;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(31, 41, 55, 0.9);
      font-size: 0.85rem;
    }

    .player-move-block h3,
    .player-decision-block h3 {
      margin: 0 0 0.25rem 0;
      font-size: 0.9rem;
    }

    .player-move-buttons,
    .player-decision-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-top: 0.35rem;
    }

    .player-move-buttons button,
    .player-decision-buttons button {
      flex: 1 1 48%;
      border-radius: 999px;
      border: 1px solid rgba(51, 65, 85, 0.9);
      background: #020617;
      color: #e5e7eb;
      font-size: 0.78rem;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
    }

    #moveState,
    #decisionState,
    #actionFeedback {
      font-size: 0.8rem;
      opacity: 0.85;
      margin-top: 0.4rem;
    }

    /* Onder: loot + mini-log (laatste actie) */

    .player-bottom {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      margin-top: 0.25rem;
    }

    @media (min-width: 720px) {
      .player-bottom {
        flex-direction: row;
        align-items: stretch;
      }
    }

    .player-loot-block {
      flex: 2;
      border-radius: 0.9rem;
      padding: 0.7rem 0.8rem;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(31, 41, 55, 0.9);
      font-size: 0.85rem;
    }

    .player-loot-block h2 {
      margin-top: 0;
      font-size: 0.9rem;
    }

    .player-mini-log {
      flex: 1;
      border-radius: 0.9rem;
      padding: 0.7rem 0.8rem;
      background: radial-gradient(circle at top, #1e293b, #020617);
      border: 1px solid rgba(55, 65, 81, 0.9);
      font-size: 0.8rem;
      color: #e5e7eb;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.4rem;
    }

    .player-mini-log-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9ca3af;
    }

    .player-mini-log-body {
      font-size: 0.8rem;
      opacity: 0.9;
    }

    /* ==============================
       PROFIEL TAB
       ============================== */

    .vj-profile-layout {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    @media (min-width: 720px) {
      .vj-profile-layout {
        flex-direction: row;
        align-items: flex-start;
      }
    }

    .vj-profile-my,
    .vj-profile-others {
      flex: 1;
    }

    .vj-profile-card {
      border-radius: 0.75rem;
      padding: 0.8rem 0.9rem;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.3);
    }

    .vj-profile-card h3 {
      margin: 0 0 0.25rem 0;
      font-size: 1rem;
    }

    .vj-profile-tagline {
      font-size: 0.8rem;
      opacity: 0.8;
      margin-bottom: 0.4rem;
    }

    .vj-profile-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin-bottom: 0.4rem;
    }

    .vj-badge {
      font-size: 0.7rem;
      padding: 0.1rem 0.4rem;
      border-radius: 999px;
      background: rgba(30, 64, 175, 0.3);
      border: 1px solid rgba(129, 140, 248, 0.6);
      white-space: nowrap;
    }

    .vj-badge-danger {
      background: rgba(127, 29, 29, 0.4);
      border-color: rgba(239, 68, 68, 0.8);
    }

    .vj-badge-safe {
      background: rgba(22, 101, 52, 0.4);
      border-color: rgba(74, 222, 128, 0.8);
    }

    .vj-profile-stat {
      font-size: 0.85rem;
      opacity: 0.9;
      margin-bottom: 0.3rem;
    }

    .vj-profile-subtitle {
      font-size: 0.8rem;
      opacity: 0.8;
      margin-bottom: 0.25rem;
    }

    .vj-profile-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .vj-profile-list button {
      width: 100%;
      text-align: left;
      border-radius: 0.6rem;
      border: 1px solid rgba(31, 41, 55, 0.9);
      background: rgba(15, 23, 42, 0.9);
      color: #e5e7eb;
      font-size: 0.8rem;
      padding: 0.4rem 0.6rem;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .vj-profile-list button.active {
      border-color: rgba(129, 140, 248, 0.9);
      background: rgba(30, 64, 175, 0.7);
    }

    .vj-profile-list-name {
      font-weight: 500;
    }

    .vj-profile-list-meta {
      font-size: 0.75rem;
      opacity: 0.85;
    }

    /* ==============================
       COMMUNITY LOG TAB
       ============================== */

    .vj-log-filters {
      display: flex;
      gap: 0.3rem;
      margin-bottom: 0.4rem;
      flex-wrap: wrap;
    }

    .vj-log-filters button {
      border-radius: 999px;
      border: 1px solid rgba(31, 41, 55, 0.9);
      background: rgba(15, 23, 42, 0.9);
      color: #e5e7eb;
      font-size: 0.75rem;
      padding: 0.15rem 0.6rem;
      cursor: pointer;
    }

    .vj-log-filters button.active {
      border-color: rgba(129, 140, 248, 0.9);
      background: rgba(30, 64, 175, 0.7);
    }

    .vj-log-list {
      max-height: 320px;
      overflow-y: auto;
      font-size: 0.8rem;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .vj-log-entry {
      padding: 0.25rem 0.4rem;
      border-radius: 0.4rem;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(31, 41, 55, 0.9);
    }

    .vj-log-entry.me {
      border-color: rgba(129, 140, 248, 0.9);
      background: rgba(30, 64, 175, 0.55);
    }

    .vj-log-entry-header {
      font-size: 0.72rem;
      opacity: 0.9;
      margin-bottom: 0.1rem;
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .vj-log-entry-body {
      font-size: 0.8rem;
    }

    .vj-log-empty {
      font-size: 0.8rem;
      opacity: 0.75;
    }

    /* ==============================
       POPUP / MODAL VOOR ACTION CARDS
       (HTML staat al, JS haken we later in)
       ============================== */

    .vj-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 80;
      background: rgba(15, 23, 42, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .vj-modal {
      width: 100%;
      max-width: 420px;
      border-radius: 1rem;
      padding: 1rem 1.1rem;
      background: #020617;
      border: 1px solid rgba(129, 140, 248, 0.9);
      box-shadow: 0 25px 50px -12px rgba(15, 23, 42, 0.9);
    }

    .vj-modal h2 {
      margin: 0 0 0.4rem 0;
      font-size: 1rem;
    }

    .vj-modal-body {
      font-size: 0.85rem;
      opacity: 0.9;
    }

    .vj-modal-actions {
      display: flex;
      gap: 0.4rem;
      margin-top: 0.85rem;
    }

    .vj-modal-actions button {
      flex: 1;
      border-radius: 999px;
      border: 1px solid rgba(31, 41, 55, 0.9);
      background: rgba(15, 23, 42, 0.95);
      color: #e5e7eb;
      font-size: 0.8rem;
      padding: 0.35rem 0.6rem;
      cursor: pointer;
    }

    .vj-modal-actions button:nth-child(1) {
      background: #4f46e5;
      border-color: #6366f1;
    }

    .vj-modal-actions button:nth-child(3) {
      background: rgba(127, 29, 29, 0.8);
      border-color: rgba(248, 113, 113, 0.9);
    }
  </style>
</head>
<body class="screen player-screen">
  <header>
    <h1>Vossenjacht – Speler</h1>
    <div id="gameStatus" class="game-info"></div>
  </header>

  <main>
    <!-- TAB 1: SPEL-UITLEG -->
    <section id="tab-rules" class="vj-tab-panel">
      <section class="panel">
        <h2>Vossenjacht – Speluitleg</h2>
        <p style="font-size:0.9rem; opacity:0.85;">
          Je bent een tienervos in de Yard van de boerderij. ’s Nachts vallen jullie
          het kippenhok aan om eieren en kippen te stelen. Elke raid bestaat uit
          rondes met <strong>MOVE → ACTIONS → DECISION → REVEAL</strong>.
        </p>
        <ul style="font-size:0.85rem; opacity:0.85;">
          <li>Doel: eindig met de meeste buitpunten</li>
          <li>Egg = 1 punt · Hen = 2 punten · Prize Hen = 3 punten</li>
          <li>Blijf in de Yard voor meer buit, of DASH weg met wat je hebt</li>
        </ul>
      </section>

      <section class="panel">
        <h2>Ronde-flow</h2>
        <ol style="font-size:0.85rem; opacity:0.9;">
          <li><strong>MOVE</strong> – kies één actie (SNATCH, FORAGE, SCOUT of SHIFT)</li>
          <li><strong>ACTIONS</strong> – om de beurt Action Cards spelen of PASS</li>
          <li><strong>DECISION</strong> – LURK / BURROW / DASH kiezen</li>
          <li><strong>REVEAL</strong> – Event wordt onthuld en toegepast</li>
          <li><strong>Einde raid</strong> – o.a. na 3× Rooster Crow of laatste vos in de Yard</li>
        </ol>
        <p style="font-size:0.8rem; opacity:0.7; margin-top:0.5rem;">
          De Community Board op het grote scherm laat het volledige overzicht zien.
          Deze Game App helpt jou om je eigen keuzes helder te maken en uit te voeren.
        </p>
      </section>

      <section class="panel">
        <h2>Kaarten (kort overzicht)</h2>
        <p style="font-size:0.85rem; opacity:0.9; margin-bottom:0.4rem;">
          In een volgende stap vullen we hier alle Loot-, Event- en Action Cards in
          als mooie Game Cards. Voor nu is dit een beknopte uitleg van de basis.
        </p>
      </section>
    </section>

    <!-- TAB 2: PLAYER PROFILE -->
    <section id="tab-profile" class="vj-tab-panel">
      <section class="panel">
        <h2>Player Profile</h2>
        <div class="vj-profile-layout">
          <div class="vj-profile-my">
            <h3 style="margin-top:0;">Jouw vos</h3>
            <div id="profileMy"></div>
          </div>
          <div class="vj-profile-others">
            <h3 style="margin-top:0;">Overige spelers</h3>
            <p style="font-size:0.8rem; opacity:0.8; margin-bottom:0.3rem;">
              Tik een speler om zijn/haar kaart te bekijken.
            </p>
            <div id="profileOthersList" class="vj-profile-list"></div>
            <div id="profileOthersDetail" style="margin-top:0.6rem;"></div>
          </div>
        </div>
      </section>
    </section>

    <!-- TAB 3: FOX DASHBOARD – SPELVERLOOP -->
    <section id="tab-game" class="vj-tab-panel">
      <section class="panel player-dashboard">
        <!-- TOP: JIJ + STATUS/EVENT -->
        <div class="player-top">
          <div class="player-top-left">
            <div class="player-header-card">
              <div class="player-header-title">Jouw vos</div>
              <div id="playerInfo"></div>
            </div>
          </div>

          <div class="player-top-right">
            <div class="player-status-bar">
              <div class="player-status-topline">
                <span class="player-status-phase">
                  Fase: <span id="playerPhaseLabel">volgens bovenbalk</span>
                </span>
                <span class="player-status-round">
                  Ronde: <span id="playerRoundLabel">volgens bovenbalk</span>
                </span>
              </div>
              <div class="player-event-box">
                <div class="player-event-label">Event</div>
                <div id="eventInfo"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- MIDDLE: HAND + MOVE/DECISION -->
        <div class="player-middle">
          <!-- Hand + OPS -->
          <div class="player-hand-area">
            <h2>Action Cards</h2>
            <div id="handPanel" class="player-hand"></div>
            <p id="opsTurnInfo" class="player-ops-info"></p>
            <div class="player-ops-buttons">
              <button id="btnPass">PASS (geen kaart deze beurt)</button>
            </div>
          </div>

          <!-- MOVE & DECISION -->
          <div class="player-move-decision">
            <div class="player-move-block">
              <h3>MOVE – kies één actie</h3>
              <p id="moveHint" style="font-size:0.8rem; opacity:0.8;">
                In de MOVE-fase mag je precies één actie doen zolang je in de Yard staat.
              </p>
              <div class="player-move-buttons">
                <button id="btnSnatch">SNATCH – pak 1 loot van de Deck</button>
                <button id="btnForage">FORAGE – trek 2 Action Cards</button>
                <button id="btnScout">SCOUT – kijk vooruit op de Event Track</button>
                <button id="btnShift">SHIFT – wissel 2 Events</button>
              </div>
              <p id="moveState"></p>
            </div>

            <div class="player-decision-block">
              <h3>DECISION – Lurk / Burrow / Dash</h3>
              <p id="decisionHint" style="font-size:0.8rem; opacity:0.8;">
                In de DECISION-fase kies je hoe je deze event-ronde ingaat.
              </p>
              <div class="player-decision-buttons">
                <button id="btnLurk">LURK (blijven staan)</button>
                <button id="btnBurrow">BURROW (ondergronds)</button>
                <button id="btnDash">DASH (rennen met buit)</button>
              </div>
              <p id="decisionState"></p>
            </div>
          </div>
        </div>

        <!-- BOTTOM: LOOT + LAATSTE ACTIE -->
        <div class="player-bottom">
          <div class="player-loot-block">
            <h2>Jouw loot</h2>
            <div id="lootPanel"></div>
          </div>
          <div class="player-mini-log">
            <div class="player-mini-log-title">Laatste actie</div>
            <div id="actionFeedback" class="player-mini-log-body">
              Acties verschijnen hier zodra je MOVE / ACTION / DECISION doet.
            </div>
          </div>
        </div>
      </section>
    </section>

    <!-- TAB 4: COMMUNITY LOG -->
    <section id="tab-log" class="vj-tab-panel">
      <section class="panel">
        <h2>Community Log</h2>
        <div class="vj-log-filters">
          <button type="button" data-log-filter="all" class="active">Alles</button>
          <button type="button" data-log-filter="me">Alleen mijn acties</button>
        </div>
        <div id="communityLog" class="vj-log-list">
          <div class="vj-log-empty">Log wordt geladen…</div>
        </div>
      </section>
    </section>
  </main>

  <!-- Popup voor Action Cards (nog niet gekoppeld in JS) -->
  <div id="actionModalOverlay" class="vj-modal-overlay hidden">
    <div class="vj-modal">
      <h2 id="actionModalTitle">Action Card</h2>
      <p id="actionModalBody" class="vj-modal-body">
        Speel deze kaart nu, of wijzig je keuze als je een andere kaart wilt spelen.
      </p>
      <div class="vj-modal-actions">
        <button id="actionModalPlay">Spelen</button>
        <button id="actionModalChange">Wijzigen</button>
        <button id="actionModalSkip">Overslaan</button>
      </div>
    </div>
  </div>

  <!-- Onderaan: tab-navigatie -->
  <nav class="vj-tabbar">
    <div class="vj-tabbar-inner">
      <button class="vj-tab-button" data-tab-target="tab-rules">
        <div class="vj-tab-button-icon">📘</div>
        <span>Speluitleg</span>
      </button>
      <button class="vj-tab-button" data-tab-target="tab-profile">
        <div class="vj-tab-button-icon">🦊</div>
        <span>Profiel</span>
      </button>
      <button class="vj-tab-button" data-tab-target="tab-game">
        <div class="vj-tab-button-icon">🎮</div>
        <span>Spelverloop</span>
      </button>
      <button class="vj-tab-button" data-tab-target="tab-log">
        <div class="vj-tab-button-icon">📜</div>
        <span>Log</span>
      </button>
    </div>
  </nav>

  <!-- Simpele tab-logica -->
  <script>
    (function () {
      const panels = document.querySelectorAll(".vj-tab-panel");
      const buttons = document.querySelectorAll(".vj-tab-button");

      function setActiveTab(id) {
        panels.forEach((p) => {
          p.classList.toggle("active", p.id === id);
        });
        buttons.forEach((b) => {
          b.classList.toggle(
            "active",
            b.getAttribute("data-tab-target") === id
          );
        });
      }

      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = btn.getAttribute("data-tab-target");
          if (target) setActiveTab(target);
        });
      });

      // Standaard: Spelverloop actief
      setActiveTab("tab-game");
    })();
  </script>

  <!-- Bestaande game-logica -->
  <script type="module" src="./js/player.js"></script>
  <!-- Extra script voor Profiel + Community Log -->
  <script type="module" src="./js/player_profile_log.js"></script>
</body>
</html>
