type StrategyCondition =
  | { op: "eq"; field: string; value: any }
  | { op: "neq"; field: string; value: any }
  | { op: "gte"; field: string; value: number }
  | { op: "lte"; field: string; value: number }
  | { op: "in"; field: string; value: any[] }
  | { op: "notIn"; field: string; value: any[] }
  | { op: "truthy"; field: string }
  | { op: "falsy"; field: string };

type StrategyRule = {
  ifAll?: StrategyCondition[];
  ifAny?: StrategyCondition[];
  thenAddTotal?: number;          // add to total score
  thenDeny?: boolean;             // deny this action
  thenPrefer?: boolean;           // soft prefer (small bonus)
  thenSave?: boolean;             // adds save bonus (penalty to play now)
  note?: string;
};

type ActionStrategy = {
  actionId: string;
  rules: StrategyRule[];
  // optional: default tuning
  baseAddTotal?: number;
};

type StrategyResult = {
  addToActionTotal: Record<string, number>; // actionId -> delta
  denyActionIds: string[];
  saveBiasByActionId: Record<string, number>; // actionId -> extra penalty to play now
  debug?: any;
};

export function applyActionStrategies(
  ctx: Ctx,
  comboInfo: ComboInfo
): StrategyResult;
