import { describe, expect, it } from "vitest";

import { acpPromptSchema, summarizeAcpContentBlocks, tryParseAcpContentBlocks } from "../src/modules/acp/acpContent.js";

describe("acpContent", () => {
  it("parses prompt blocks", () => {
    const blocks = acpPromptSchema.parse([
      { type: "text", text: "hi" },
      { type: "resource_link", uri: "file:///tmp/a.txt", name: "a.txt", mimeType: "text/plain", size: 3 },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
      { type: "resource", resource: { uri: "tuixiu://context", mimeType: "text/markdown", text: "ctx" } },
    ]);

    expect(blocks).toHaveLength(5);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[1]?.type).toBe("resource_link");
    expect(blocks[2]?.type).toBe("image");
    expect(blocks[3]?.type).toBe("audio");
    expect(blocks[4]?.type).toBe("resource");
  });

  it("rejects unknown content block types", () => {
    expect(() =>
      acpPromptSchema.parse([
        {
          type: "video",
          url: "https://example.com/video.mp4",
        } as any,
      ]),
    ).toThrow();
  });

  it("tryParseAcpContentBlocks returns null on invalid input", () => {
    expect(tryParseAcpContentBlocks([{ type: "text" }])).toBeNull();
  });

  it("summarizes mixed blocks", () => {
    const text = summarizeAcpContentBlocks([
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", data: "xxx", uri: "file:///tmp/a.png" },
      { type: "resource_link", uri: "file:///tmp/a.txt", name: "a.txt" },
      { type: "resource", resource: { uri: "tuixiu://context", mimeType: "text/plain", text: "abc" } },
    ]);

    expect(text).toContain("hello");
    expect(text).toContain("[image image/png");
    expect(text).toContain("[resource_link a.txt");
    expect(text).toContain("[resource tuixiu://context");
  });
});
