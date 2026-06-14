import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs tests inside workerd via @cloudflare/vitest-pool-workers, reading the
// Durable Object binding and `vars` straight from wrangler.jsonc so the test
// environment matches production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // Worker tests only. The client module's tests are plain Node ESM
    // (test/client/*.test.mjs) and run via `node --test`, not in workerd.
    include: ["test/**/*.test.ts"],
  },
});
