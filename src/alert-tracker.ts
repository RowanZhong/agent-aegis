import { randomUUID } from "node:crypto";

export type AlertOccurrence = {
  alertId: string;
  occurrenceCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
};

type Entry = AlertOccurrence & {
  sessionKey: string;
  toolName?: string;
  level: "info" | "warn";
  reportedCount: number;
};

// Notification aggregation only: never cache a security decision or skip an audit write.
export class ToolResultAlertTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: {
    now: () => number;
    onSummary: (summary: AlertOccurrence & { sessionKey: string; toolName?: string; level: string }) => void;
    windowMs?: number;
    maxEntries?: number;
  }) {}

  private summarize(entry: Entry): void {
    if (entry.occurrenceCount > entry.reportedCount) {
      const { reportedCount: _, ...summary } = entry;
      this.options.onSummary(summary);
      entry.reportedCount = entry.occurrenceCount;
    }
  }

  record(sessionKey: string, signature: string, level: "info" | "warn", toolName?: string): AlertOccurrence {
    const now = this.options.now();
    // Fixed window: repeated input cannot suppress a fresh warning indefinitely.
    for (const [key, entry] of this.entries) {
      if (now - entry.firstTimestamp >= (this.options.windowMs ?? 300_000)) {
        this.summarize(entry);
        this.entries.delete(key);
      }
    }
    const key = JSON.stringify([sessionKey, toolName, level, signature]);
    let entry = this.entries.get(key);
    if (entry) {
      entry.occurrenceCount += 1;
      entry.lastTimestamp = now;
    } else {
      if (this.entries.size >= (this.options.maxEntries ?? 256)) {
        const oldest = this.entries.entries().next().value;
        if (oldest) {
          this.summarize(oldest[1]);
          this.entries.delete(oldest[0]);
        }
      }
      entry = { sessionKey, toolName, level, alertId: randomUUID(), occurrenceCount: 1,
        firstTimestamp: now, lastTimestamp: now, reportedCount: 1 };
      this.entries.set(key, entry);
    }
    return { alertId: entry.alertId, occurrenceCount: entry.occurrenceCount,
      firstTimestamp: entry.firstTimestamp, lastTimestamp: entry.lastTimestamp };
  }

  finishTurn(sessionKey: string): void {
    for (const entry of this.entries.values()) {
      if (entry.sessionKey === sessionKey) this.summarize(entry);
    }
  }

  endSession(sessionKey: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionKey === sessionKey) {
        this.summarize(entry);
        this.entries.delete(key);
      }
    }
  }
}
