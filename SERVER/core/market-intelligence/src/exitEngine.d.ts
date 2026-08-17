/**
 * Position management measurements — MFE/MAE/peak/giveback.
 * Exit decisions use only information available at timestamp (no look-ahead).
 */
export type PositionExcursion = {
    entry: number;
    direction: 'LONG' | 'SHORT';
    current: number;
    peak_price: number;
    peak_profit: number;
    current_profit: number;
    mfe: number;
    mae: number;
    giveback: number;
    giveback_ratio: number | null;
    peak_profit_pct: number;
    distance_from_peak: number;
};
export declare function updateExcursion(input: {
    entry: number;
    direction: 'LONG' | 'SHORT';
    current: number;
    peak_price: number;
    mfe: number;
    mae: number;
}): PositionExcursion;
export type ExitCandidate = 'HOLD' | 'PARTIAL_EXIT' | 'MOVE_SL' | 'TRAIL' | 'FULL_EXIT';
/**
 * Best-outcome exit ranking using only current evidence (no future prices).
 */
export declare function rankExitCandidates(input: {
    excursion: PositionExcursion;
    momentum_score: number | null;
    structure_deteriorating: boolean;
    spread_deteriorating: boolean;
    giveback_ratio_threshold?: number;
}): Array<{
    action: ExitCandidate;
    score: number;
    reason: string;
}>;
