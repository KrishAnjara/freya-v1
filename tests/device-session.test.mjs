import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, deviceLabel, pendingRequest, PENDING_TTL_MS, STALE_MS } from "../lib/device-session.ts";

const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const live = { session_id: "A", last_seen: iso(NOW - 10_000) };

test("the device in use keeps it; a new device asks instead of taking over", () => {
  assert.equal(decide(live, "A", NOW), "current");
  assert.equal(decide(live, "B", NOW), "replaced", "a sign-in elsewhere doesn't just take over");
  assert.equal(decide(null, "B", NOW), "unclaimed", "nobody using it: straight in");
  assert.equal(decide({ ...live, last_seen: iso(NOW - STALE_MS - 1) }, "B", NOW), "stale", "the device in use went quiet: nobody to ask");
});

test("a request to switch is waited on, then allowed, refused or left to lapse", () => {
  const asked = { ...live, pending_id: "B", pending_label: "Chrome on Android", pending_at: iso(NOW - 5000) };
  assert.equal(decide(asked, "B", NOW), "waiting");
  assert.deepEqual(pendingRequest(asked, "A", NOW), { id: "B", label: "Chrome on Android" }, "the device in use is asked");
  assert.equal(pendingRequest(asked, "B", NOW), null, "only the device in use answers");
  assert.equal(decide({ ...asked, session_id: "B" }, "B", NOW), "current", "allowed: it's this device's now");
  assert.equal(decide({ ...asked, session_id: "B" }, "A", NOW), "replaced", "and the old one steps aside");
  assert.equal(decide({ ...asked, decision: "denied" }, "B", NOW), "denied");
  assert.equal(pendingRequest({ ...asked, decision: "denied" }, "A", NOW), null, "asked once");
  assert.equal(decide({ ...asked, pending_at: iso(NOW - PENDING_TTL_MS - 1) }, "B", NOW), "expired");
  assert.equal(decide({ ...asked, last_seen: iso(NOW - STALE_MS - 1) }, "B", NOW), "stale", "the device that would answer closed: get in");
});

test("devices are named so you can tell them apart, and no more", () => {
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"), "Chrome on Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"), "Chrome on Android");
});
