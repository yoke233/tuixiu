import { describe, expect, it } from "vitest";

import { summarizeContentBlocks } from "./contentBlocks";

describe("summarizeContentBlocks", () => {
  it("summarizes mixed blocks", () => {
    const text = summarizeContentBlocks([
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", uri: "/runs/r1/attachments/a1" },
      { type: "resource_link", uri: "/f", name: "f" },
    ]);
    expect(text).toContain("hello");
    expect(text).toContain("[image image/png");
    expect(text).toContain("[resource_link f");
  });
});

