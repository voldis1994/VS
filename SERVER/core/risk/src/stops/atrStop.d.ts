/** ATR / structure stops — explicit inputs only; no invented prices. */
export declare function atrStop(input: {
    direction: 'LONG' | 'SHORT';
    entry: number;
    atr: number;
    multiplier: number;
    minDistance?: number;
}): {
    stop: number;
    distance: number;
} | {
    error: string;
};
export declare function riskRewardTarget(input: {
    direction: 'LONG' | 'SHORT';
    entry: number;
    stop: number;
    rewardMultiple: number;
}): {
    target: number;
} | {
    error: string;
};
export declare function positionSize(input: {
    equity: number;
    riskFraction: number;
    entry: number;
    stop: number;
    direction: 'LONG' | 'SHORT';
}): {
    size: number;
} | {
    error: string;
};
