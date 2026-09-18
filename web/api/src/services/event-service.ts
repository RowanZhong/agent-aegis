import type { SecurityEvent } from "@claw-aegis-web/shared";

const MAX_EVENTS = 1000;

export class EventService {
  private readonly events: SecurityEvent[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(event: SecurityEvent) => void>();

  addEvent(event: Omit<SecurityEvent, "id">): SecurityEvent {
    const full: SecurityEvent = {
      ...event,
      id: String(this.nextId++),
    };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const listener of this.listeners) {
      listener(full);
    }
    return full;
  }

  getEvents(params?: {
    limit?: number;
    offset?: number;
    defense?: string;
    result?: string;
    collapse?: boolean;
  }): { events: SecurityEvent[]; total: number; rawTotal: number } {
    let filtered = this.events;

    if (params?.defense) {
      filtered = filtered.filter((e) => e.defense === params.defense);
    }
    if (params?.result) {
      filtered = filtered.filter((e) => e.result === params.result);
    }

    const rawTotal = filtered.length;
    if (params?.collapse) {
      const groups = new Map<string, SecurityEvent>();
      filtered = filtered.reduce<SecurityEvent[]>((rows, event) => {
        const alertId = event.details?.alertId;
        // Only the runtime's bounded, session-scoped tool-result groups qualify.
        // Legacy events and blocked tool calls are always displayed individually.
        if (event.defense !== "tool_result_scan" || event.result !== "observed" ||
            typeof alertId !== "string" || !alertId) {
          rows.push(event);
          return rows;
        }
        const key = JSON.stringify([alertId, event.toolName, event.reason, event.details?.level]);
        const group = groups.get(key);
        if (group) {
          group.occurrences! += 1;
          group.firstTimestamp = Math.min(group.firstTimestamp!, event.timestamp);
          if (event.timestamp >= group.timestamp) {
            group.timestamp = event.timestamp;
            group.details = event.details;
          }
        } else {
          const row = { ...event, id: alertId, occurrences: 1, firstTimestamp: event.timestamp };
          groups.set(key, row);
          rows.push(row);
        }
        return rows;
      }, []);
    }
    const total = filtered.length;
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 50;

    // Return newest first
    const sorted = params?.collapse
      ? [...filtered].sort((a, b) => b.timestamp - a.timestamp)
      : [...filtered].reverse();
    const sliced = sorted.slice(offset, offset + limit);

    return { events: sliced, total, rawTotal };
  }

  onEvent(listener: (event: SecurityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
