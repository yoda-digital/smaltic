import { BaseSequencer, type WorkspaceSpec } from "vitest/node";
import { defineConfig } from "vitest/config";

/**
 * Files share one seeded repository and run one at a time, in name order: `writeClient.test.ts`
 * publishes the migration release (which also holds the seeded draft), so it must run last.
 */
class ByName extends BaseSequencer {
  async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    globalSetup: ["./globalSetup.ts"],
    fileParallelism: false,
    sequence: { sequencer: ByName },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
