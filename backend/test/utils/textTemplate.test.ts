import { describe, expect, it } from "vitest";

import { normalizeTemplateText, renderTextTemplate } from "../../src/utils/textTemplate.js";

describe("textTemplate", () => {
  it("replaces placeholders", () => {
    expect(renderTextTemplate("a {{x}} b", { x: "1" })).toBe("a 1 b");
    expect(renderTextTemplate("{{missing}}", {})).toBe("");
  });

  it("supports {{#if}} blocks", () => {
    const tpl = "a{{#if x}}X{{/if}}b";
    expect(renderTextTemplate(tpl, { x: "" })).toBe("ab");
    expect(renderTextTemplate(tpl, { x: "1" })).toBe("aXb");
  });

  it("supports nested {{#if}} blocks", () => {
    const tpl = "{{#if a}}A{{#if b}}B{{/if}}C{{/if}}";
    expect(renderTextTemplate(tpl, { a: "1", b: "1" })).toBe("ABC");
    expect(renderTextTemplate(tpl, { a: "1", b: "" })).toBe("AC");
  });

  it("normalizes CRLF and trims", () => {
    expect(normalizeTemplateText("a\r\nb\r\n")).toBe("a\nb");
  });
});

