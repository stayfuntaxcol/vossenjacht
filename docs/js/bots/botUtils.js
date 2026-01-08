// docs/js/bots/botUtils.js
import { addLog, LOG_TYPES } from "../log.js";

const normPhase = (p) => (p === "OPS" ? "ACTIONS" : p);

export async function logBotChoice({ gameId, game, me, type, kind="SYSTEM", choice, payload=null, message="" }) {
  return addLog(gameId, {
    round: game.round ?? null,
    phase: normPhase(game.phase),
    kind,
    type,
    actorId: me.id,
    playerId: me.id,
    playerName: me.name || me.playerName || "BOT",
    cardId: choice?.cardId ?? null,
    choice,
    payload,
    message,
  });
}

export async function logBotBlocked({ gameId, game, me, reason, intent=null, extra=null }) {
  return addLog(gameId, {
    round: game.round ?? null,
    phase: normPhase(game.phase),
    kind: "SYSTEM",
    type: "BOT_BLOCKED_ILLEGAL_ACTION",
    actorId: me.id,
    playerId: me.id,
    playerName: me.name || me.playerName || "BOT",
    choice: { intent, reason },
    payload: extra || null,
    message: `BOT_BLOCKED: ${reason}`,
  });
}

export { LOG_TYPES };
