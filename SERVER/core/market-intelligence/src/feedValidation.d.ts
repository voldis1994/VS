/**
 * Multi-feed validation — never merges providers into a fake single feed.
 * Primary trading price requires agreement / quality gates.
 */
import type { FeedValidationReport, RawTickEvent } from './types.js';
export type ValidateFeedsInput = {
    instrument: string;
    ticks: RawTickEvent[];
    nowMs?: number;
    /** Absolute mid deviation vs median that counts as disagreement (price units). */
    maxDisagreement?: number;
    /** Relative disagreement = maxDeviation / median. Default 0.001 (0.1%). */
    maxRelativeDisagreement?: number;
    maxStaleMs?: number;
    expectedProviders?: string[];
};
/**
 * Validate multi-provider ticks for one instrument at one decision time.
 * Does not invent missing providers' prices.
 */
export declare function validateMultiFeed(input: ValidateFeedsInput): FeedValidationReport;
export declare function rawTickFromParts(input: {
    provider: string;
    instrument: string;
    bid: number;
    ask: number;
    timestamp_source: string;
    timestamp_receive?: string;
    sequence_id?: number | null;
    source_quality?: RawTickEvent['source_quality'];
}): RawTickEvent | null;
