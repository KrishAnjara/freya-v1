// Loaded before every test file (see the "test" script). Circuit-breaker cooldowns and the
// search cache are process-level state; without a reset, one test's simulated outage would
// silently skip a provider in the next test.
import { afterEach, beforeEach } from "node:test";
import { resetProviderHealthForTests } from "../lib/provider-health.ts";
import { clearSearchCacheForTests } from "../lib/search.ts";

function reset() {
  resetProviderHealthForTests();
  clearSearchCacheForTests();
}

beforeEach(reset);
afterEach(reset);
