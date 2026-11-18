import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { formatBytes, formatDuration } from "../src/format.ts";

test("durations use days, hours, minutes and seconds across boundaries", () => {
  for (const [seconds, expected] of [
    [0, "0s"],
    [59, "59s"],
    [60, "1m 0s"],
    [65.9, "1m 5s"],
    [3605, "1h 5s"],
    [90061, "1d 1h 1m 1s"],
    [810549, "9d 9h 9m 9s"],
  ] as const)
    assert.equal(formatDuration(seconds), expected);
});

test("byte sizes use compact binary units", () => {
  for (const [bytes, expected] of [
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [10240, "10 KB"],
    [1024 * 1024, "1 MB"],
    [2.4 * 1024 * 1024, "2.4 MB"],
    [20 * 1024 * 1024, "20 MB"],
    [-1, "?"],
    [Number.NaN, "?"],
  ] as const)
    assert.equal(formatBytes(bytes), expected);
});
