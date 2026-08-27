import type { LeadAgentEvent } from "./orchestration.ts";
import { TaskLedger } from "./task-ledger.ts";

export type OrchestrationEventHandler = (
  event: LeadAgentEvent,
) => Promise<boolean | void>;

/** Event-driven coordinator for durable Lead Agent protocol events. */
export class OrchestrationCoordinator {
  private readonly ledger: TaskLedger;
  private readonly handle: OrchestrationEventHandler;
  private serial: Promise<void> = Promise.resolve();

  constructor(ledger: TaskLedger, handle: OrchestrationEventHandler) {
    this.ledger = ledger;
    this.handle = handle;
  }

  async emit(event: LeadAgentEvent): Promise<{ readonly duplicate: boolean }> {
    return this.exclusive(async () => {
      const appended = await this.ledger.append(event);
      if (appended.duplicate) {
        if (appended.record.acknowledgedAt === undefined)
          await this.process(event);
        return { duplicate: true };
      }
      await this.process(event);
      return { duplicate: false };
    });
  }

  async replay(): Promise<number> {
    return this.exclusive(async () => {
      let processed = 0;
      for (const record of this.ledger.pendingEvents()) {
        await this.process(record.event);
        processed++;
      }
      return processed;
    });
  }

  private async process(event: LeadAgentEvent) {
    const handled = await this.handle(event);
    if (handled !== false) await this.ledger.acknowledgeEvent(event.eventId);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
