type PresetKey = "RED" | "GREEN" | "YELLOW" | "BLUE";

type BotWeights = { risk: number; loot: number; info: number; control: number; tempo: number };

type BotPreset = {
  key: PresetKey;
  weights: BotWeights;

  // preset thresholds override core defaults (optional)
  coreOverride?: Partial<CorePolicyConfig>;

  // tagBias for base score
  tagBias?: Record<string, number>;
};

export function presetFromDenColor(denColor: string): PresetKey;
export function getPreset(presetKey: PresetKey): BotPreset;
