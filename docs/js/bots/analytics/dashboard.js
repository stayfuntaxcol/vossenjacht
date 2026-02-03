/**
 * Vossenjacht Bot Analytics Dashboard
 * Visualizes bot decision logs for analysis and improvement
 */
(function() {
  // State
  let logData = null;
  let filteredEntries = [];
  let selectedBot = null;
  let selectedEntry = null;
  // Card icons mapping
  const CARD_ICONS = {
    'Den Signal': '🏠',
    'Scatter': '💨',
    'Hold Still': '🛑',
    'Pack Tinker': '🔧',
    'Night Eyes': '👁️',
    'Quick Paws': '🐾',
    'Dig Deep': '⛏️',
    'Fox Cry': '🦊',
    'Decoy': '🎭',
    'Ambush': '⚔️',
    'default': '🃏'
  };
  // DOM Elements
  const elements = {
    logFileInput: document.getElementById('logFileInput'),
    logFileInputLarge: document.getElementById('logFileInputLarge'),
    exportJsonBtn: document.getElementById('exportJsonBtn'),
    exportCsvBtn: document.getElementById('exportCsvBtn'),
    noDataState: document.getElementById('noDataState'),
    mainContent: document.getElementById('mainContent'),
    totalDecisions: document.getElementById('totalDecisions'),
    cardsPlayed: document.getElementById('cardsPlayed'),
    passRate: document.getElementById('passRate'),
    mostPlayedCard: document.getElementById('mostPlayedCard'),
    botGrid: document.getElementById('botGrid'),
    botFilter: document.getElementById('botFilter'),
    phaseFilter: document.getElementById('phaseFilter'),
    actionFilter: document.getElementById('actionFilter'),
    timelineContainer: document.getElementById('timelineContainer'),
    cardFrequencyChart: document.getElementById('cardFrequencyChart'),
    scoreDistributionChart: document.getElementById('scoreDistributionChart'),
    handViewerModal: document.getElementById('handViewerModal'),
    modalBotName: document.getElementById('modalBotName'),
    handDisplay: document.getElementById('handDisplay'),
    scoreBreakdown: document.getElementById('scoreBreakdown'),
    closeModal: document.getElementById('closeModal')
  };
  // Initialize
  function init() {
    // File input handlers
    elements.logFileInput.addEventListener('change', handleFileUpload);
    elements.logFileInputLarge.addEventListener('change', handleFileUpload);
    
    // Export handlers
    elements.exportJsonBtn.addEventListener('click', exportJSON);
    elements.exportCsvBtn.addEventListener('click', exportCSV);
    
    // Filter handlers
    elements.botFilter.addEventListener('change', applyFilters);
    elements.phaseFilter.addEventListener('change', applyFilters);
    elements.actionFilter.addEventListener('change', applyFilters);
    
    // Modal handlers
    elements.closeModal.addEventListener('click', closeModal);
    elements.handViewerModal.addEventListener('click', (e) => {
      if (e.target === elements.handViewerModal) closeModal();
    });
  }
  // File Upload Handler
  function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        logData = JSON.parse(e.target.result);
        processLogData();
      } catch (err) {
        alert('Fout bij laden van bestand: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ===== Import normalizer =====
  // Supports:
  // 1) BotLogger format: { entries: [...] }
  // 2) Firestore export (your games/{gameId}/actions + optional players): we detect and convert it
  function normalizeAnyLog(raw) {
    try {
      if (!raw) return null;
      if (raw.entries && Array.isArray(raw.entries)) return raw;
      if (raw.data && raw.data.entries && Array.isArray(raw.data.entries)) return raw.data;

      const actions = findBestArray(raw, scoreActionDoc);
      if (!actions || !actions.length) return null;

      const players = findBestArray(raw, scorePlayerDoc) || [];
      const playerColorById = buildPlayerColorById(players);

      const sessionId = String(raw.sessionId || raw.gameId || `import_${Date.now()}`);
      const entries = [];
      const sorted = [...actions].sort((a, b) => getDocTime(a) - getDocTime(b));

      let turnCounter = 1;

      for (const doc of sorted) {
        const kind = String(doc?.kind || "").toUpperCase();
        const phase = String(doc?.phase || "").toUpperCase();
        const choiceRaw = doc?.choice ?? doc?.action ?? doc?.move ?? "";
        const choice = String(choiceRaw || "").toUpperCase();

        const botId = String(doc?.playerId || doc?.botId || doc?.by || doc?.actorId || "");
        const botColor =
          String(
            doc?.botColor ||
            playerColorById[botId] ||
            doc?.metrics?.intel?.denColor ||
            doc?.metrics?.intel?.den ||
            doc?.denColor ||
            doc?.color ||
            ""
          ).toUpperCase() || "UNKNOWN";

        const t = getDocTime(doc);
        const ts = Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();

        // OPS: action card selection (PASS or PLAY)
        if (kind === "BOT_OPS" || phase === "ACTIONS" || phase === "OPS") {
          const isPass = choice === "ACTION_PASS" || choice === "PASS";
          const cardKey = !isPass ? stripPrefix(choice, "ACTION_") : null;

          entries.push({
            type: "DECISION",
            timestamp: ts,
            sessionId,
            turn: Number(doc?.turn || doc?.opsTurn || turnCounter++),
            round: Number(doc?.round || 0),
            phase: "OPS",
            botId,
            botColor,
            discProfile: discFromColor(botColor),

            hand: normalizeHand(doc?.hand || doc?.handSnapshot || doc?.metrics?.hand || doc?.metrics?.handSnapshot || doc?.metrics?.handActionKeys || doc?.metrics?.handNames),

            cardScores: normalizeCardScores(doc?.cardScores || doc?.metrics?.cardScores || doc?.scores || []),

            decision: {
              action: isPass ? "PASS" : "PLAY",
              cardPlayed: cardKey ? { id: cardKey, name: prettyCardName(cardKey) } : null,
              reasoning: String(doc?.message || doc?.reason || ""),
              threshold: Number(doc?.threshold || doc?.metrics?.threshold || 0)
            },

            gameState: {
              dangerLevel: Number(doc?.metrics?.dangerEffective ?? doc?.metrics?.dangerStay ?? doc?.metrics?.dangerPeak ?? 0),
              nearbyHunters: Number(doc?.metrics?.intel?.nearbyHunters ?? 0),
              knownFoxLocations: Number(doc?.metrics?.intel?.knownFoxLocations ?? 0),
              roundProgress: 0,
              currentScore: doc?.metrics?.intel?.currentScore || { foxes: 0, hunters: 0 }
            }
          });

          continue;
        }

        // DECISION: movement choice (optional)
        if (kind === "BOT_DECISION" || phase === "DECISION") {
          const mv = stripPrefix(choice, "DECISION_") || choice || "UNKNOWN";
          entries.push({
            type: "MOVEMENT",
            timestamp: ts,
            sessionId,
            turn: Number(doc?.turn || doc?.opsTurn || turnCounter++),
            botId,
            botColor,
            moveType: mv,
            reasoning: String(doc?.message || doc?.reason || "")
          });
          continue;
        }

        // MOVE: movement execution (optional)
        if (kind === "BOT_MOVE" || phase === "MOVE") {
          const mv = stripPrefix(choice, "MOVE_") || choice || "UNKNOWN";
          entries.push({
            type: "MOVEMENT",
            timestamp: ts,
            sessionId,
            turn: Number(doc?.turn || doc?.opsTurn || turnCounter++),
            botId,
            botColor,
            moveType: mv,
            reasoning: String(doc?.message || doc?.reason || "")
          });
          continue;
        }
      }

      const opsDecisions = entries.filter(e => e.type === "DECISION" && String(e.phase || "").toUpperCase() === "OPS");

      return {
        sessionId,
        startTime: entries[0]?.timestamp || null,
        entries,
        summary: calculateSummary(opsDecisions)
      };
    } catch (e) {
      console.warn("[dashboard] normalizeAnyLog failed", e);
      return null;
    }
  }

  function stripPrefix(s, prefix) {
    const str = String(s || "");
    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
  }

  function prettyCardName(key) {
    const s = String(key || "").replace(/_/g, " ").trim();
    return s.split(/\s+/).map(w => w ? (w.charAt(0) + w.slice(1).toLowerCase()) : "").join(" ");
  }

  function discFromColor(botColor) {
    const c = String(botColor || "").toUpperCase();
    if (c === "RED") return "D";
    if (c === "YELLOW") return "I";
    if (c === "GREEN") return "S";
    if (c === "BLUE") return "C";
    return "DISC";
  }

  function normalizeHand(h) {
    if (!h) return [];
    if (Array.isArray(h)) {
      return h.map((c) => {
        if (typeof c === "string") return { id: c, name: prettyCardName(c), tag: "ACTION", type: "ACTION" };
        const name = String(c?.name || c?.id || c?.uid || c?.key || "UNKNOWN");
        const id = String(c?.id || c?.uid || c?.actionId || c?.key || name);
        return { id, name, tag: c?.tag || "ACTION", type: c?.type || "ACTION" };
      });
    }
    if (typeof h === "string") {
      return h.split(",").map(s => s.trim()).filter(Boolean).map(x => ({ id: x, name: prettyCardName(x), tag: "ACTION", type: "ACTION" }));
    }
    return [];
  }

  function normalizeCardScores(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(s => ({
      cardId: s?.cardId || s?.id || null,
      cardName: s?.cardName || s?.name || "Unknown",
      controlScore: Number(s?.controlScore || 0),
      infoScore: Number(s?.infoScore || 0),
      riskScore: Number(s?.riskScore || 0),
      tempoScore: Number(s?.tempoScore || 0),
      situationalBonus: Number(s?.situationalBonus || 0),
      totalScore: Number(s?.totalScore || 0),
      meetsThreshold: Boolean(s?.meetsThreshold || false)
    }));
  }

  function getDocTime(doc) {
    if (!doc) return NaN;
    // numeric
    if (Number.isFinite(Number(doc.at))) return Number(doc.at);
    if (Number.isFinite(Number(doc.timestamp))) return Number(doc.timestamp);

    // Firestore Timestamp object
    const ts = doc.createdAt || doc.updatedAt;
    if (ts && typeof ts === "object") {
      const sec = Number(ts.seconds);
      const ns = Number(ts.nanoseconds);
      if (Number.isFinite(sec)) return sec * 1000 + (Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0);
    }

    // ISO string
    const s = doc.timestamp || doc.createdAt;
    if (typeof s === "string") {
      const t = Date.parse(s);
      if (Number.isFinite(t)) return t;
    }

    return NaN;
  }

  function buildPlayerColorById(players) {
    const out = {};
    if (!Array.isArray(players)) return out;
    players.forEach(p => {
      const id = String(p?.id || p?.playerId || p?.uid || "");
      const color = String(p?.color || p?.den || p?.denColor || p?.team || "");
      if (id && color) out[id] = color.toUpperCase();
    });
    return out;
  }

  function scoreActionDoc(obj) {
    if (!obj || typeof obj !== "object") return 0;
    let s = 0;
    if ("kind" in obj) s += 2;
    if ("phase" in obj) s += 2;
    if ("choice" in obj || "action" in obj) s += 2;
    if ("playerId" in obj || "botId" in obj || "by" in obj) s += 2;
    if ("metrics" in obj) s += 1;
    if ("round" in obj) s += 1;
    return s;
  }

  function scorePlayerDoc(obj) {
    if (!obj || typeof obj !== "object") return 0;
    let s = 0;
    if ("color" in obj || "den" in obj || "denColor" in obj) s += 3;
    if ("id" in obj || "playerId" in obj || "uid" in obj) s += 2;
    if ("isBot" in obj || "bot" in obj) s += 1;
    return s;
  }

  function findBestArray(root, scorer) {
    const seen = new Set();
    const q = [root];
    let best = null;
    let bestScore = 0;

    while (q.length) {
      const cur = q.shift();
      if (!cur || typeof cur !== "object") continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        const sample = cur.slice(0, 30);
        const score = sample.reduce((acc, x) => acc + scorer(x), 0) / (sample.length || 1);
        if (score > bestScore) {
          bestScore = score;
          best = cur;
        }
        // also traverse elements
        sample.forEach(x => { if (x && typeof x === "object") q.push(x); });
        continue;
      }

      Object.values(cur).forEach(v => {
        if (v && typeof v === "object") q.push(v);
      });
    }
    return best;
  }

  // Process Log Data
  function processLogData() {
    if (!logData) {
      alert('Geen data geladen');
      return;
    }
    if (!logData.entries) {
      const normalized = normalizeAnyLog(logData);
      if (!normalized || !normalized.entries) {
        alert('Ongeldig log bestand formaat (verwacht BotLogger-log of Firestore export met actions)');
        return;
      }
      logData = normalized;
    }
    // Show main content
    elements.noDataState.style.display = 'none';
    elements.mainContent.style.display = 'block';
    elements.exportJsonBtn.disabled = false;
    elements.exportCsvBtn.disabled = false;
    // Calculate summary (kaart-analytics = OPS entries)
    const allDecisions = logData.entries.filter(e => e.type === 'DECISION');
    const opsDecisions = allDecisions.filter(d => String(d.phase || '').toUpperCase() === 'OPS');
    const played = opsDecisions.filter(d => d.decision.action !== 'PASS');
    const summary = logData.summary || calculateSummary(opsDecisions);
    // Update summary cards
    elements.totalDecisions.textContent = opsDecisions.length;
    elements.cardsPlayed.textContent = played.length;
    elements.passRate.textContent = opsDecisions.length > 0 
      ? Math.round((1 - played.length / opsDecisions.length) * 100) + '%' 
      : '0%';
    elements.mostPlayedCard.textContent = summary.mostPlayedCard?.[0] || '-';
    // Populate bot filter
    const bots = [...new Set(allDecisions.map(d => d.botColor))];
    elements.botFilter.innerHTML = '<option value="all">Alle Bots</option>';
    bots.forEach(bot => {
      const option = document.createElement('option');
      option.value = bot;
      option.textContent = bot.charAt(0).toUpperCase() + bot.slice(1) + ' Bot';
      elements.botFilter.appendChild(option);
    });
    // Render components
    renderBotGrid(allDecisions, summary.byBot);
    renderTimeline(allDecisions);
    renderCharts(summary);
    filteredEntries = allDecisions;
  }
  // Calculate Summary
  function calculateSummary(decisions) {
    const byBot = {};
    const cardPlayFrequency = {};
    decisions.forEach(d => {
      if (!byBot[d.botColor]) {
        byBot[d.botColor] = { total: 0, passed: 0, played: 0, cards: {} };
      }
      byBot[d.botColor].total++;
      if (d.decision.action === 'PASS') {
        byBot[d.botColor].passed++;
      } else {
        byBot[d.botColor].played++;
        const cardName = d.decision.cardPlayed?.name || 'Unknown';
        byBot[d.botColor].cards[cardName] = (byBot[d.botColor].cards[cardName] || 0) + 1;
        cardPlayFrequency[cardName] = (cardPlayFrequency[cardName] || 0) + 1;
      }
    });
    return {
      totalDecisions: decisions.length,
      byBot,
      cardPlayFrequency,
      mostPlayedCard: Object.entries(cardPlayFrequency).sort((a, b) => b[1] - a[1])[0] || ['None', 0]
    };
  }
  // Render Bot Grid
  function renderBotGrid(decisions, byBot) {
    elements.botGrid.innerHTML = '';
    Object.entries(byBot || {}).forEach(([color, stats]) => {
      const lastDecision = [...decisions].reverse().find(d => d.botColor === color);
      const card = document.createElement('div');
      card.className = `bot-card ${color.toLowerCase()}`;
      
      card.innerHTML = `
        <div class="bot-card-header">
          <span class="bot-name">${color.charAt(0).toUpperCase() + color.slice(1)} Bot</span>
          <span class="bot-profile">${lastDecision?.discProfile || 'DISC'}</span>
        </div>
        <div class="bot-stats">
          <div class="bot-stat">
            <span class="bot-stat-value">${stats.total}</span>
            <span class="bot-stat-label">Beslissingen</span>
          </div>
          <div class="bot-stat">
            <span class="bot-stat-value">${stats.played}</span>
            <span class="bot-stat-label">Gespeeld</span>
          </div>
          <div class="bot-stat">
            <span class="bot-stat-value">${Math.round((stats.passed / stats.total) * 100)}%</span>
            <span class="bot-stat-label">Pass Rate</span>
          </div>
        </div>
        <div class="bot-hand-preview">
          ${(lastDecision?.hand || []).slice(0, 5).map(c => 
            `<div class="mini-card" title="${c.name}">${getCardIcon(c.name)}</div>`
          ).join('')}
        </div>
        <button class="view-hand-btn" data-bot="${color}">👁️ Bekijk Details</button>
      `;
      card.querySelector('.view-hand-btn').addEventListener('click', () => {
        openHandViewer(color, lastDecision);
      });
      elements.botGrid.appendChild(card);
    });
  }
  // Render Timeline
  function renderTimeline(decisions) {
    elements.timelineContainer.innerHTML = '';
    decisions.forEach((entry, index) => {
      const isPlay = entry.decision.action !== 'PASS';
      const div = document.createElement('div');
      div.className = `timeline-entry ${isPlay ? 'play' : 'pass'}`;
      div.dataset.index = index;
      const topScore = entry.cardScores?.length > 0 
        ? Math.max(...entry.cardScores.map(s => s.totalScore)).toFixed(1)
        : '0.0';
      div.innerHTML = `
        <div class="timeline-entry-header">
          <div class="timeline-meta">
            <span class="timeline-turn">Turn ${entry.turn}</span>
            <span class="timeline-phase">${entry.phase}</span>
            <span class="timeline-bot" style="color: var(--bot-${entry.botColor?.toLowerCase() || 'blue'})">${entry.botColor || 'Unknown'}</span>
          </div>
          <span class="timeline-action ${isPlay ? 'play' : 'pass'}">
            ${isPlay ? `▶ ${entry.decision.cardPlayed?.name || 'Kaart'}` : '⏭️ PASS'}
          </span>
        </div>
        <div class="timeline-scores">
          <span class="timeline-score ${parseFloat(topScore) > 0 ? 'positive' : 'negative'}">
            Top Score: ${topScore}
          </span>
          <span class="timeline-score">Threshold: ${entry.decision.threshold}</span>
          <span class="timeline-score">Danger: ${entry.gameState?.dangerLevel || 0}</span>
        </div>
        ${entry.decision.reasoning ? `<div class="timeline-reasoning">"${entry.decision.reasoning}"</div>` : ''}
      `;
      div.addEventListener('click', () => openEntryDetail(entry));
      elements.timelineContainer.appendChild(div);
    });
  }
  // Render Charts
  function renderCharts(summary) {
    // Card Frequency Chart
    const cardFreq = Object.entries(summary.cardPlayFrequency || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const maxFreq = cardFreq.length > 0 ? cardFreq[0][1] : 1;
    elements.cardFrequencyChart.innerHTML = cardFreq.map(([name, count]) => `
      <div class="chart-bar">
        <span class="chart-label">${getCardIcon(name)} ${name}</span>
        <div class="chart-bar-bg">
          <div class="chart-bar-fill" style="width: ${(count / maxFreq) * 100}%">
            <span class="chart-bar-value">${count}x</span>
          </div>
        </div>
      </div>
    `).join('') || '<p style="color: var(--text-secondary); text-align: center;">Geen kaarten gespeeld</p>';
    // Score Distribution (average by card)
    const allDecisions = logData.entries.filter(e => e.type === 'DECISION');
    const cardScoreAverages = {};
    allDecisions.forEach(d => {
      (d.cardScores || []).forEach(score => {
        if (!cardScoreAverages[score.cardName]) {
          cardScoreAverages[score.cardName] = { sum: 0, count: 0 };
        }
        cardScoreAverages[score.cardName].sum += score.totalScore;
        cardScoreAverages[score.cardName].count++;
      });
    });
    const avgScores = Object.entries(cardScoreAverages)
      .map(([name, data]) => [name, data.sum / data.count])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const maxAvg = avgScores.length > 0 ? Math.max(...avgScores.map(s => Math.abs(s[1]))) : 1;
    elements.scoreDistributionChart.innerHTML = avgScores.map(([name, avg]) => `
      <div class="chart-bar">
        <span class="chart-label">${getCardIcon(name)} ${name}</span>
        <div class="chart-bar-bg">
          <div class="chart-bar-fill" style="width: ${(Math.abs(avg) / maxAvg) * 100}%; background: ${avg >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
            <span class="chart-bar-value">${avg.toFixed(1)}</span>
          </div>
        </div>
      </div>
    `).join('') || '<p style="color: var(--text-secondary); text-align: center;">Geen score data</p>';
  }
  // Apply Filters
  function applyFilters() {
    const botFilter = elements.botFilter.value;
    const phaseFilter = elements.phaseFilter.value;
    const actionFilter = elements.actionFilter.value;
    const decisions = logData.entries.filter(e => e.type === 'DECISION');
    
    filteredEntries = decisions.filter(d => {
      if (botFilter !== 'all' && d.botColor !== botFilter) return false;
      if (phaseFilter !== 'all' && d.phase !== phaseFilter) return false;
      if (actionFilter === 'PLAY' && d.decision.action === 'PASS') return false;
      if (actionFilter === 'PASS' && d.decision.action !== 'PASS') return false;
      return true;
    });
    renderTimeline(filteredEntries);
  }
  // Open Hand Viewer Modal
  function openHandViewer(botColor, decision) {
    if (!decision) return;
    elements.modalBotName.textContent = `${botColor} Bot - Turn ${decision.turn}`;
    
    // Render hand
    const playedCardId = decision.decision.cardPlayed?.id;
    elements.handDisplay.innerHTML = (decision.hand || []).map(card => `
      <div class="card-item ${card.id === playedCardId ? 'played' : ''}">
        <div class="card-icon">${getCardIcon(card.name)}</div>
        <div class="card-name">${card.name}</div>
        <div class="card-tag">${card.tag || 'ACTION'}</div>
      </div>
    `).join('');
    // Render score breakdown
    elements.scoreBreakdown.innerHTML = `
      <h4>Score Breakdown</h4>
      <table class="score-table">
        <thead>
          <tr>
            <th>Kaart</th>
            <th>Control</th>
            <th>Info</th>
            <th>Risk</th>
            <th>Bonus</th>
            <th>Totaal</th>
          </tr>
        </thead>
        <tbody>
          ${(decision.cardScores || []).map(score => `
            <tr>
              <td>${score.cardName}</td>
              <td class="score-positive">+${score.controlScore}</td>
              <td class="score-positive">+${score.infoScore}</td>
              <td class="score-negative">-${score.riskScore}</td>
              <td class="${score.situationalBonus >= 0 ? 'score-positive' : 'score-negative'}">${score.situationalBonus >= 0 ? '+' : ''}${score.situationalBonus}</td>
              <td><strong>${score.totalScore.toFixed(1)}</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="margin-top: 1rem; color: var(--text-secondary);">
        <strong>Threshold:</strong> ${decision.decision.threshold} | 
        <strong>Beslissing:</strong> ${decision.decision.action === 'PASS' ? 'PASS' : 'PLAY ' + decision.decision.cardPlayed?.name}
      </p>
    `;
    elements.handViewerModal.classList.add('active');
  }
  // Open Entry Detail (same as hand viewer)
  function openEntryDetail(entry) {
    openHandViewer(entry.botColor, entry);
  }
  // Close Modal
  function closeModal() {
    elements.handViewerModal.classList.remove('active');
  }
  // Get Card Icon
  function getCardIcon(cardName) {
    return CARD_ICONS[cardName] || CARD_ICONS.default;
  }
  // Export Functions
  function exportJSON() {
    if (!logData) return;
    const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `vossenjacht-analysis-${Date.now()}.json`);
  }
  function exportCSV() {
    if (!logData) return;
    const decisions = logData.entries.filter(e => e.type === 'DECISION');
    
    const headers = ['timestamp', 'turn', 'round', 'phase', 'botColor', 'discProfile', 'action', 'cardPlayed', 'topScore', 'threshold', 'dangerLevel', 'reasoning'];
    const rows = decisions.map(d => [
      d.timestamp,
      d.turn,
      d.round,
      d.phase,
      d.botColor,
      d.discProfile,
      d.decision.action,
      d.decision.cardPlayed?.name || '',
      d.cardScores?.length > 0 ? Math.max(...d.cardScores.map(s => s.totalScore)).toFixed(1) : 0,
      d.decision.threshold,
      d.gameState?.dangerLevel || 0,
      d.decision.reasoning || ''
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    downloadBlob(blob, `vossenjacht-analysis-${Date.now()}.csv`);
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  // Initialize on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();