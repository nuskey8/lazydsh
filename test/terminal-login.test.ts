import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import open from "open";
import { openAuthUrl } from "../src/open-url.ts";

vi.mock("open", () => ({ default: vi.fn() }));

test("authentication opens only HTTP URLs and tolerates missing browser support", async () => {
  const launch = vi.mocked(open);
  for (const url of [undefined, "/tmp/file", "file:///tmp/file", "javascript:alert(1)"])
    await openAuthUrl(url);
  assert.equal(launch.mock.calls.length, 0);
  await openAuthUrl("https://example.invalid/login");
  assert.deepEqual(launch.mock.calls, [["https://example.invalid/login"]]);
  launch.mockRejectedValueOnce(new Error("No browser available"));
  await assert.doesNotReject(openAuthUrl("http://localhost:1234/login"));
});
