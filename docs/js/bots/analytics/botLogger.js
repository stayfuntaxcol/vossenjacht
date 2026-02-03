/**
 * Bot Logger Module for Vossenjacht
 * Captures bot decisions, hands, and strategic reasoning
 * Usage: Import and call BotLogger.logDecision() from botRunner.js
 */
const BotLogger = (function() {
  let sessionLog = [];
  let sessionId = null;
  let gameStartTime = null;
  function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  function startSession(gameConfig = {}) {
    sessionId = generateSessionId();
    gameStartTime = new Date().toISOString();
    sessionLog = [];
    
    sessionLog.push({
      type: 'SESSION_START',
      sessionId,
      timestamp: gameStartTime,
      gameConfig: {
        players: gameConfig.players || [],
        mapType: gameConfig.mapType || 'unknown',
        difficulty: gameConfig.difficulty || 'normal'
      }
    });
    
    console.log(`[BotLogger] Session started: ${sessionId}`);
    return sessionId;
  }
  function logDecision(data) {
    const entry = {
      type: 'DECISION',
      timestamp: new Date().toISOString(),
      sessionId,
      turn: data.turn || 0,
      round: data.round || 0,
      phase: data.phase || 'OPS', // OPS or DECISION
      botId: data.botId,
      botColor: data.botColor,
      discProfile: data.discProfile,
      
      // Current hand (hidden cards revealed for analysis)
      hand: (data.hand || []).map(card => ({
        id: card.id,
        name: card.name,
        tag: card.tag,
        type: card.type
      })),
      
      // Scoring breakdown for each card considered
      cardScores: (data.cardScores || []).map(score => ({
        cardId: score.cardId,
        cardName: score.cardName,
        controlScore: score.controlScore || 0,
        infoScore: score.infoScore || 0,
        riskScore: score.riskScore || 0,
        tempoScore: score.tempoScore || 0,
        situationalBonus: score.situationalBonus || 0,
        totalScore: score.totalScore || 0,
        meetsThreshold: score.meetsThreshold || false
      })),
      
      // Final decision
      decision: {
        action: data.decision?.action || 'PASS',
        cardPlayed: data.decision?.cardPlayed || null,
        reasoning: data.decision?.reasoning || '',
        threshold: data.decision?.threshold || 0
      },
      
      // Game context at decision time
      gameState: {
        dangerLevel: data.gameState?.dangerLevel || 0,
        nearbyHunters: data.gameState?.nearbyHunters || 0,
        knownFoxLocations: data.gameState?.knownFoxLocations || 0,
        roundProgress: data.gameState?.roundProgress || 0,
        currentScore: data.gameState?.currentScore || { foxes: 0, hunters: 0 }
      }
    };
    
    sessionLog.push(entry);
    console.log(`[BotLogger] Decision logged for ${data.botColor} bot`);
    return entry;
  }
  function logMovement(data) {
    const entry = {
      type: 'MOVEMENT',
      timestamp: new Date().toISOString(),
      sessionId,
      turn: data.turn,
      botId: data.botId,
      botColor: data.botColor,
      moveType: data.moveType, // DASH, BURROW, LURK
      fromPosition: data.fromPosition,
      toPosition: data.toPosition,
      reasoning: data.reasoning || ''
    };
    
    sessionLog.push(entry);
    return entry;
  }
  function logEvent(data) {
    const entry = {
      type: 'EVENT',
      timestamp: new Date().toISOString(),
      sessionId,
      turn: data.turn,
      eventType: data.eventType,
      eventCard: data.eventCard,
      affectedBots: data.affectedBots || [],
      outcome: data.outcome || ''
    };
    
    sessionLog.push(entry);
    return entry;
  }
  function endSession(finalScore = {}) {
    const endEntry = {
      type: 'SESSION_END',
      timestamp: new Date().toISOString(),
      sessionId,
      duration: gameStartTime ? 
        (new Date() - new Date(gameStartTime)) / 1000 : 0,
      finalScore,
      totalDecisions: sessionLog.filter(e => e.type === 'DECISION').length
    };
    
    sessionLog.push(endEntry);
    console.log(`[BotLogger] Session ended: ${sessionId}`);
    return getSessionData();
  }
  function getSessionData() {
    return {
      sessionId,
      startTime: gameStartTime,
      entries: [...sessionLog],
      summary: generateSummary()
    };
  }
  function generateSummary() {
    const decisions = sessionLog.filter(e => e.type === 'DECISION');
    const byBot = {};
    const cardPlayFrequency = {};
    
    decisions.forEach(d => {
      // Group by bot
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
      mostPlayedCard: Object.entries(cardPlayFrequency)
        .sort((a, b) => b[1] - a[1])[0] || ['None', 0]
    };
  }
  function exportToJSON() {
    const data = getSessionData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vossenjacht-log-${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function exportToCSV() {
    const decisions = sessionLog.filter(e => e.type === 'DECISION');
    const headers = [
      'timestamp', 'turn', 'round', 'phase', 'botColor', 'discProfile',
      'handSize', 'action', 'cardPlayed', 'totalScore', 'threshold',
      'dangerLevel', 'nearbyHunters', 'reasoning'
    ];
    
    const rows = decisions.map(d => [
      d.timestamp,
      d.turn,
      d.round,
      d.phase,
      d.botColor,
      d.discProfile,
      d.hand.length,
      d.decision.action,
      d.decision.cardPlayed?.name || '',
      d.cardScores.find(s => s.cardId === d.decision.cardPlayed?.id)?.totalScore || 0,
      d.decision.threshold,
      d.gameState.dangerLevel,
      d.gameState.nearbyHunters,
      d.decision.reasoning
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vossenjacht-log-${sessionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  // Public API
  return {
    startSession,
    logDecision,
    logMovement,
    logEvent,
    endSession,
    getSessionData,
    exportToJSON,
    exportToCSV
  };
})();
// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BotLogger;
}

// Make available to ES modules
try { globalThis.BotLogger = BotLogger; } catch (e) {}
