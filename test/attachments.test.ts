import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AttachmentView,
  attachmentToken,
  isImagePath,
  pastedImagePath,
  summarizeAttachment,
  type AttachmentSummary,
} from "../src/attachments.ts";
import { QueuedMessage, SentMessage } from "../src/presentation.ts";

const image = (overrides: Record<string, unknown> = {}) => ({
  type: "image" as const,
  attachment: {
    attachmentId: "image-id" as never,
    mediaType: "image/png" as const,
    bytes: 128,
    width: 64,
    height: 32,
    ...overrides,
  },
});
const file = (overrides: Record<string, unknown> = {}) => ({
  type: "file" as const,
  attachment: {
    attachmentId: "file-id" as never,
    name: "notes.pdf",
    bytes: 2048,
    ...overrides,
  },
});
const view = (files: readonly AttachmentSummary[]) => {
  const component = new AttachmentView();
  component.setFiles(
    files.map((file, index) => ({ ...file, token: attachmentToken(file.kind, index + 1) })),
  );
  return component;
};

test("images and files summarize their display name, kind, size, and dimensions", () => {
  assert.deepEqual(summarizeAttachment(image({ name: "shot.png" })), {
    name: "shot.png",
    kind: "image",
    detail: "128 B · 64×32",
  });
  assert.deepEqual(summarizeAttachment(image()), {
    name: "image.png",
    kind: "image",
    detail: "128 B · 64×32",
  });
  assert.deepEqual(summarizeAttachment(file()), {
    name: "notes.pdf",
    kind: "file",
    detail: "2 KB",
  });
  assert.deepEqual(summarizeAttachment(file({ name: "  " })), {
    name: "file",
    kind: "file",
    detail: "2 KB",
  });
});

test("the pending attachment strip lists files and a removal hint", () => {
  const empty = new AttachmentView();
  assert.deepEqual(empty.render(80), []);

  assert.equal(attachmentToken("image", 1), "[Image #1]");
  assert.equal(attachmentToken("file", 2), "[File #2]");

  const single = view([summarizeAttachment(image({ name: "shot.png" }))]);
  let text = single.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(text, /^  \[Image #1\] shot\.png · 128 B · 64×32/);

  single.setFiles([]);
  assert.deepEqual(single.render(80), []);

  const many = view(
    Array.from({ length: 8 }, (_, index) =>
      summarizeAttachment(file({ name: `notes-${index}.pdf` })),
    ),
  );
  text = many.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(text, /\[File #1\] notes-0\.pdf/);
  assert.match(text, /… 2 more/);
  for (const width of [10, 30, 50, 80])
    assert.ok(many.render(width).every((line) => visibleWidth(line) <= width));
});

test("sent and queued messages show attachments above the prompt text", () => {
  const attachments = [
    summarizeAttachment(image({ name: "shot.png" })),
    summarizeAttachment(file()),
  ];
  const sent = new SentMessage("Review these files", { attachments });
  const sentText = sent.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(sentText, /shot\.png · image · 128 B · 64×32/);
  assert.match(sentText, /notes\.pdf · file · 2 KB/);
  assert.ok(sentText.indexOf("shot.png") < sentText.indexOf("Review these files"));
  for (const width of [1, 10, 40, 80])
    assert.ok(sent.render(width).every((line) => visibleWidth(line) <= width));

  const queued = new QueuedMessage("Send later", attachments);
  const queuedText = queued.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(queuedText, /shot\.png · image/);
  assert.match(queuedText, /Send later/);
  for (const width of [1, 10, 40, 80])
    assert.ok(queued.render(width).every((line) => visibleWidth(line) <= width));

  const tokenized = new SentMessage("[Image #1] describe this");
  assert.ok(tokenized.render(80).join("").includes("\x1b[38;2;77;107;254m[Image #1]"));
});

test("dragged image paths are recognized without swallowing other pastes", () => {
  for (const [value, expected] of [
    ["\x1b[200~/tmp/shot.png\x1b[201~", "/tmp/shot.png"],
    ["\x1b[200~'/tmp/a b.png'\x1b[201~", "/tmp/a b.png"],
    ['\x1b[200~"/tmp/a b.png"\x1b[201~', "/tmp/a b.png"],
    ["\x1b[200~/tmp/a\\ b.png\x1b[201~", "/tmp/a b.png"],
    ["\x1b[200~file:///tmp/shot.png\x1b[201~", "/tmp/shot.png"],
    ["\x1b[200~/tmp/notes.txt\x1b[201~", undefined],
    ["\x1b[200~/tmp/shot.png\n/tmp/two.png\x1b[201~", undefined],
    ["plain text", undefined],
  ] as const)
    assert.equal(pastedImagePath(value), expected, JSON.stringify(value));
  assert.ok(isImagePath("shot.PNG"));
  assert.ok(isImagePath("shot.jpeg"));
  assert.ok(isImagePath("shot.webp"));
  assert.ok(!isImagePath("shot.svg"));
  assert.ok(!isImagePath("path/to/folder"));
});
