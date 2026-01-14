type CorePolicyResult = {
  // action economy gates
  maxActionsAllowedThisTurn: number;     // 1 or 2
  reserveTarget: number;                // min hand to keep
  denySecondAction: boolean;            // true unless combo strong or hail-mary

  // risk/cashout
  dangerEffective: number;              // nextDanger + roosterBonus (timed)
  cashoutBias: number;                  // + means prefer DASH, - means continue

  // penalties/bonuses applied on action totals
  addToActionTotal: Record<string, number>;  // actionId -> deltaTotal (negative = penalty)
  denyActionIds: string[];                   // hard deny from core (rare)

  // debug
  debug?: any;
};

type CorePolicyConfig = {
  COMBO_THRESHOLD: number;
  COMBO_THRESHOLD_HAILMARY: number;
  SAVE_THRESHOLD: number;

  RESERVE_EARLY: number;
  RESERVE_LATE: number;

  DUP_ROUND_PENALTY: number;
  DUP_WINDOW_PENALTY: number;
  DUP_TRIPLE_PENALTY: number;

  DANGER_DASH_MIN: number;
  HAILMARY_BEHIND: number;

  // carry tier thresholds
  CARRY_HIGH: number;
  CARRY_EXTREME: number;

  // rooster bonus parameters
  ROOSTER_BONUS: number;               // how much danger increases post-rooster2
};

export function evaluateCorePolicy(
  ctx: Ctx,
  comboInfo: ComboInfo,
  config: CorePolicyConfig
): CorePolicyResult;
