import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTiming, expectedTiming, normalizeTimings, recordTiming, typingLeadMs, typingStartsAt } from "../lib/model-timing.ts";
import { homeTimeReply, lostThreadReply, noSearchReply, timeReply, unknownZoneReply } from "../lib/plain-replies.ts";
import { herStatusLine } from "../lib/her-day.ts";

test("each voice's speed is a running average, and one wild reply can't wreck it", () => {
  let timings = recordTiming({}, "Server", { firstMs: 10_000, totalMs: 14_000, chars: 120 }, 1);
  timings = recordTiming(timings, "server", { firstMs: 20_000, totalMs: 26_000, chars: 200 }, 2);
  assert.equal(timings.server.samples, 2);
  assert.equal(Math.round(timings.server.firstMs), 13_000, "recent replies count for 30%");
  timings = recordTiming(timings, "groq", { firstMs: 900, totalMs: 1500, chars: 90 }, 3);
  assert.equal(expectedTiming(timings, "server").firstMs, timings.server.firstMs);
  assert.equal(expectedTiming(timings).samples, 1, "unknown voice: the most recent one");
  assert.equal(expectedTiming({}), null);
  assert.equal(recordTiming(timings, "groq", { firstMs: 5, totalMs: 1, chars: 1 }), timings, "nonsense is ignored");
  const capped = recordTiming({}, "laptop", { firstMs: 3_600_000, totalMs: 3_600_000, chars: 10 });
  assert.equal(capped.laptop.firstMs, 600_000);
  assert.match(describeTiming(timings.groq), /0\.9 s to start/);
});

test("a slow voice: she reads, pauses, and types for a believable stretch before the reply is due", () => {
  const sentAt = 1000;
  const readEnd = 4000;
  assert.equal(typingStartsAt(readEnd, sentAt, null), readEnd, "nothing measured yet: types straight after reading");
  const fast = { firstMs: 1200, totalMs: 2000, chars: 100, samples: 3, at: 1 };
  assert.equal(typingStartsAt(readEnd, sentAt, fast), readEnd);
  const slow = { firstMs: 40_000, totalMs: 48_000, chars: 150, samples: 3, at: 1 };
  const starts = typingStartsAt(readEnd, sentAt, slow);
  assert.equal(starts, sentAt + 40_000 - typingLeadMs(150), "typing begins a typing-length before it's due");
  assert.ok(starts > readEnd + 20_000, "not a minute of 'typing…'");
  assert.equal(typingLeadMs(10), 2500);
  assert.equal(typingLeadMs(5000), 9000);
});

test("stored timings are checked before use", () => {
  assert.deepEqual(normalizeTimings({ "bad name!": { firstMs: 1, totalMs: 1, chars: 1, samples: 1, at: 1 }, groq: { firstMs: "fast" } }), {});
  assert.equal(normalizeTimings({ groq: { firstMs: 1, totalMs: 2, chars: 3, samples: 4, at: 5 } }).groq.samples, 4);
  assert.deepEqual(normalizeTimings("nope"), {});
});

test("the route's fixed answers sound like her, vary by turn, and never guess at news", () => {
  const at = new Date("2026-11-04T10:00:00Z");
  const tokyo = timeReply("Asia/Tokyo", 1, at);
  assert.match(tokyo, /7:00 pm/);
  assert.match(tokyo, /3½ hours ahead of me/);
  assert.notEqual(timeReply("Asia/Tokyo", 0, at), timeReply("Asia/Tokyo", 1, at));
  assert.match(timeReply("America/New_York", 1, at), /New York/);
  assert.match(timeReply("America/New_York", 1, at), /behind me/);
  assert.doesNotMatch(timeReply("Europe/London", 2, at), /UTC offset|IANA/);
  assert.match(homeTimeReply(0, at), /3:30 pm/);
  assert.match(unknownZoneReply("Narnia", 0), /Narnia/);
  for (let turn = 0; turn < 4; turn += 1) {
    assert.match(noSearchReply("asked", turn), /won't guess/);
    assert.match(noSearchReply("failed", turn), /won't guess/);
    assert.doesNotMatch(noSearchReply("off", turn), /Enable web search|reliable, up-to-date/);
  }
  assert.match(lostThreadReply(0), /lost my train of thought/);
  assert.notEqual(lostThreadReply(1), lostThreadReply(2), "the same line doesn't come straight back");
});

test("an empty chat shows where she is, not suggested messages", () => {
  assert.match(herStatusLine(new Date("2026-11-02T10:00:00+05:30")), /lecture/);
  assert.match(herStatusLine(new Date("2026-11-02T05:00:00+05:30")), /asleep/);
});
