import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Real filesystem, real child processes and a real HTTP server, so the
    // defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite also drives the real Windows capture helper and contains durable-store stress
    // cases. Letting a high-core workstation spawn one worker per core makes those tests fight
    // over native capture/IO and can turn a 6-second 8,400-event case into a 60-second timeout.
    maxWorkers: 4,
    env: {
      // Never let a test bind — or worse, fall through to — the shipped bridge range.
      // The developer's own installed app is usually listening on 8765 while the suite
      // runs, and a test that lost the bind race used to talk to it with a test token.
      CLF_BRIDGE_PORTS: '0',
      // In-process evidence arrives in microseconds or never; the production windows only
      // exist for a real browser that is seconds late. Without this the suite spent minutes
      // waiting out fifteen-second timeouts to prove calls stay unattributed.
      CLF_EVIDENCE_MS: '1500'
    }
  }
});
