// Loaded before every test file (see the "test" script). Circuit-breaker cooldowns and the
// search cache are process-level state; without a reset, one test's simulated outage would
// silently skip a provider in the next test.
import { afterEach, beforeEach } from "node:test";
// Tests set their own switches: flipping one in freya.config.json mustn't change what they check.
process.env.FREYA_CONFIG_PATH = "freya.config.not-in-tests.json";
// Her memory store lives in memory during tests, never in data/, and starts empty each test.
process.env.FREYA_MEMORY_PATH = ":memory:";
import { resetProviderHealthForTests } from "../lib/provider-health.ts";
import { clearSearchCacheForTests } from "../lib/search.ts";
import { resetMemoryStoreForTests } from "../lib/memory-store.ts";
import { resetVisionForTests } from "../lib/vision.ts";

function reset() {
  resetProviderHealthForTests();
  clearSearchCacheForTests();
  resetMemoryStoreForTests();
  resetVisionForTests();
}

beforeEach(reset);
afterEach(reset);
