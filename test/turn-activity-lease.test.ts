import { describe, expect, it } from 'vitest';
import { TurnActivityRegistry } from '../src/main/browser-recovery/activity-registry.js';
import { extendActivityLeaseDeadline, type TurnActivityLease } from '../src/main/browser-recovery/turn-activity-lease.js';

describe('turn activity lease', () => {
  it('moves a scheduling deadline without changing the semantic generation or mutating the captured lease', () => {
    const lease: TurnActivityLease = {
      leaseId: 7,
      phase: 'failed-view-listening',
      sessionId: 'session-one',
      turnId: 'turn-one',
      model: 'non-pro',
      observedAt: 100,
      listenUntil: 200
    };
    const extended = extendActivityLeaseDeadline(lease, 500);

    expect(extended).not.toBe(lease);
    expect(extended).toMatchObject({ leaseId: 7, listenUntil: 500 });
    expect(lease.listenUntil).toBe(200);
  });

  it('owns semantic generations while deadline deferral preserves the current generation', () => {
    const registry = new TurnActivityRegistry();
    const first = registry.publish('conversation', {
      phase: 'active',
      sessionId: 'session-one',
      turnId: 'turn-one',
      model: 'non-pro',
      evidence: 'native',
      evidenceAt: 100,
      expiresAt: 200
    });

    expect(registry.current('conversation', first)).toBe(true);
    expect(registry.deferDeadline('conversation', first, 500)).toBe(true);
    expect(registry.get('conversation')).toMatchObject({ leaseId: first.leaseId, expiresAt: 500 });

    const second = registry.publish('conversation', {
      phase: 'active',
      sessionId: 'session-one',
      turnId: 'turn-two',
      model: 'non-pro',
      evidence: 'native',
      evidenceAt: 600,
      expiresAt: 700
    });
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(registry.current('conversation', first)).toBe(false);
    expect(registry.deferDeadline('conversation', first, 900)).toBe(false);
    expect(registry.get('conversation')).toBe(second);
  });
});
