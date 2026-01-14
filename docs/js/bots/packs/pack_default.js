type PackResult = {
  addToActionTotal: Record<string, number>;
  denyActionIds: string[];
  debug?: any;
};

export function applyPack(ctx: Ctx, comboInfo: ComboInfo): PackResult;
