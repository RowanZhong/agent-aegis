export type AlertOccurrence = {
    alertId: string;
    occurrenceCount: number;
    firstTimestamp: number;
    lastTimestamp: number;
};
export declare class ToolResultAlertTracker {
    private readonly options;
    private readonly entries;
    constructor(options: {
        now: () => number;
        onSummary: (summary: AlertOccurrence & {
            sessionKey: string;
            toolName?: string;
            level: string;
        }) => void;
        windowMs?: number;
        maxEntries?: number;
    });
    private summarize;
    record(sessionKey: string, signature: string, level: "info" | "warn", toolName?: string): AlertOccurrence;
    finishTurn(sessionKey: string): void;
    endSession(sessionKey: string): void;
}
