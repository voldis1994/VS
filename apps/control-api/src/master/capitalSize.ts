/**
 * Capital.com deal size helpers — ported from VS-System- broker-adapters/capital-size.ts.
 * Prevents invalid / zero size and RISK_CHECK from bad lot steps.
 */

export type CapitalDealRules = {
  minSize: number;
  maxSize: number;
  step: number;
};

export function volumePrecisionForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  if (step >= 0.001) return 3;
  return 4;
}

export function capitalDealRulesFallback(epic: string): CapitalDealRules {
  const s = String(epic ?? '').toUpperCase();
  if (
    /US100|UST100|USTECH|USX|US500|US30|NDX|SPX|DJI|GER40|DE40|UK100|FTSE|FRA40|EU50|ESP35|JP225|AUS200|HK50|NASDAQ|DOW/.test(
      s
    )
  ) {
    return { minSize: 0.001, maxSize: 500, step: 0.001 };
  }
  if (/BTC|ETH|CRYPTO|BITCOIN|ETHER/.test(s)) {
    return { minSize: 0.001, maxSize: 100, step: 0.001 };
  }
  if (/XAU|GOLD|XAG|SILVER/.test(s)) {
    return { minSize: 0.01, maxSize: 500, step: 0.01 };
  }
  if (/^[A-Z]{6}$/.test(s) || /EURUSD|GBPUSD|USDJPY|AUDUSD/.test(s)) {
    return { minSize: 0.01, maxSize: 500, step: 0.01 };
  }
  return { minSize: 0.01, maxSize: 500, step: 0.01 };
}

export function sanitizeCapitalDealRules(
  epic: string,
  rules: CapitalDealRules
): CapitalDealRules {
  const fb = capitalDealRulesFallback(epic);
  if (rules.minSize > fb.minSize * 10 + 1e-12 || rules.step > fb.step * 10 + 1e-12) {
    return fb;
  }
  let step = rules.step > 0 ? rules.step : rules.minSize;
  if (step > rules.minSize + 1e-12) step = rules.minSize;
  return {
    minSize: rules.minSize,
    maxSize: rules.maxSize > rules.minSize ? rules.maxSize : fb.maxSize,
    step,
  };
}

export function normalizeCapitalDealSize(
  raw: number,
  rules: CapitalDealRules
): { size: number; adjusted: boolean; reason?: string } {
  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      size: rules.minSize,
      adjusted: true,
      reason: `size≤0 → min ${rules.minSize}`,
    };
  }
  const step = rules.step > 0 ? rules.step : rules.minSize;
  const steps = Math.ceil((raw - 1e-12) / step);
  let size = Math.max(steps * step, rules.minSize);
  size = Math.round(size / step) * step;
  const prec = volumePrecisionForStep(step);
  size = Number(size.toFixed(Math.max(prec, 8)));
  if (size < rules.minSize) size = rules.minSize;
  if (size > rules.maxSize) size = rules.maxSize;
  const adjusted = Math.abs(size - raw) > 1e-12;
  return {
    size,
    adjusted,
    reason: adjusted
      ? `lot ${raw} → ${size} (min ${rules.minSize}, step ${step})`
      : undefined,
  };
}

export function isCapitalSizeError(message: string): boolean {
  return /error\.positive\.createpositionrequest\.size|invalid.*size|minDealSize|deal size|CAPITAL_SIZE_INVALID/i.test(
    message
  );
}

export function isCapitalRiskCheckError(message: string): boolean {
  return /RISK_CHECK|INSUFFICIENT_FUNDS|AVAILABLE_TO_DEAL|insufficient.?funds|not enough.*(margin|fund)|exposure.?limit/i.test(
    String(message ?? '')
  );
}

/** Normalize size for epic using fallback dealing rules (no market details required). */
export function normalizeSizeForEpic(
  epic: string,
  raw: number
): { size: number; adjusted: boolean; reason?: string; rules: CapitalDealRules } {
  const rules = capitalDealRulesFallback(epic);
  const n = normalizeCapitalDealSize(raw, rules);
  return { ...n, rules };
}
