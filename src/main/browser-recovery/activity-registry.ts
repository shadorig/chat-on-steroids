import {
  extendActivityLeaseDeadline,
  type NewTurnActivityLease,
  type TurnActivityLease
} from './turn-activity-lease.js';

/**
 * Process-lifetime owner of turn-liveness generations.
 *
 * Replacing a conversation's lease mints a new generation. Moving only its scheduling deadline
 * preserves that generation, so async recovery work can cheaply reject stale results.
 */
export class TurnActivityRegistry implements Iterable<[string, TurnActivityLease]> {
  readonly #byConversation = new Map<string, TurnActivityLease>();
  #nextLeaseId = 1;

  get size(): number { return this.#byConversation.size; }

  get(conversationId: string): TurnActivityLease | undefined {
    return this.#byConversation.get(conversationId);
  }

  has(conversationId: string): boolean {
    return this.#byConversation.has(conversationId);
  }

  values(): IterableIterator<TurnActivityLease> {
    return this.#byConversation.values();
  }

  [Symbol.iterator](): IterableIterator<[string, TurnActivityLease]> {
    return this.#byConversation[Symbol.iterator]();
  }

  publish(conversationId: string, lease: NewTurnActivityLease): TurnActivityLease {
    const published = { ...lease, leaseId: this.#nextLeaseId++ } as TurnActivityLease;
    this.#byConversation.set(conversationId, published);
    return published;
  }

  current(conversationId: string, lease: TurnActivityLease): boolean {
    return this.#byConversation.get(conversationId)?.leaseId === lease.leaseId;
  }

  deferDeadline(conversationId: string, lease: TurnActivityLease, until: number): boolean {
    if (!this.current(conversationId, lease)) return false;
    this.#byConversation.set(conversationId, extendActivityLeaseDeadline(lease, until));
    return true;
  }

  delete(conversationId: string): boolean {
    return this.#byConversation.delete(conversationId);
  }

  clear(): void {
    this.#byConversation.clear();
  }

  resetForTests(): void {
    this.#byConversation.clear();
    this.#nextLeaseId = 1;
  }
}
