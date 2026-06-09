import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  truncateForPrompt,
  compactJsonSchema,
  parseToolCallParts,
  normalizeToolCalls,
  applyToolPrompt,
  toolsToPrompt,
  toolsToLightPrompt,
} from "../../src/api/toolUtils.js";

describe("toolUtils", () => {
  describe("truncateForPrompt", () => {
    it("returns empty string for non-string input", () => {
      assert.equal(truncateForPrompt(null), "");
      assert.equal(truncateForPrompt(undefined), "");
      assert.equal(truncateForPrompt(123), "");
    });

    it("returns full text if within limit", () => {
      assert.equal(truncateForPrompt("hello", 10), "hello");
    });

    it("truncates long text with ellipsis", () => {
      const result = truncateForPrompt("a".repeat(200), 100);
      assert.ok(result.endsWith("..."));
      assert.ok(result.length <= 103);
    });
  });

  describe("compactJsonSchema", () => {
    it("returns null/undefined as-is", () => {
      assert.equal(compactJsonSchema(null), null);
      assert.equal(compactJsonSchema(undefined), undefined);
    });

    it("preserves type, enum, required, default", () => {
      const schema = {
        type: "object",
        description:
          "A very long description that should be truncated at some point when it exceeds the limit",
        properties: {
          name: { type: "string" },
        },
        extra: "should be removed",
      };
      const result = compactJsonSchema(schema);
      assert.equal(result.type, "object");
      assert.ok(result.description);
      assert.ok(result.properties);
      assert.equal(result.extra, undefined);
    });

    it("handles arrays by slicing to 20 items", () => {
      const arr = Array.from({ length: 30 }, (_, i) => ({
        type: "string",
        index: i,
      }));
      const result = compactJsonSchema(arr);
      assert.equal(result.length, 20);
    });
  });

  describe("parseToolCallParts", () => {
    it("returns object with null calls for non-string input", () => {
      const r1 = parseToolCallParts(null);
      assert.ok(r1 && typeof r1 === "object");
      assert.equal(r1.calls, null);

      const r2 = parseToolCallParts(123);
      assert.ok(r2 && typeof r2 === "object");
      assert.equal(r2.calls, null);
    });

    it("parses JSON tool call blocks", () => {
      const text =
        'Some text\n```json\n{"name": "test", "arguments": {"x": 1}}\n```\nmore';
      const result = parseToolCallParts(text);
      assert.ok(result && Array.isArray(result.calls));
    });

    it("returns visible text when no tool calls found", () => {
      const result = parseToolCallParts("Just a plain text answer");
      assert.ok(result);
      assert.equal(result.visible, "Just a plain text answer");
      assert.equal(result.calls, null);
    });
  });

  describe("normalizeToolCalls", () => {
    it("returns empty array for empty array input", () => {
      assert.deepEqual(normalizeToolCalls([]), []);
    });

    it("normalizes tool call objects with id and function", () => {
      const raw = [{ name: "get_weather", arguments: '{"city":"Moscow"}' }];
      const result = normalizeToolCalls(raw);
      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0);
      assert.ok(result[0].id);
      assert.equal(result[0].type, "function");
      assert.equal(result[0].function.name, "get_weather");
    });
  });

  describe("toolsToPrompt", () => {
    it("returns empty string for empty tools array", () => {
      assert.equal(toolsToPrompt([]), "");
    });

    it("generates prompt text for tools", () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "Get current time",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      const result = toolsToPrompt(tools);
      assert.ok(typeof result === "string");
      assert.ok(result.includes("get_time"));
    });
  });

  describe("toolsToLightPrompt", () => {
    it("returns empty string for empty tools array", () => {
      assert.equal(toolsToLightPrompt([]), "");
    });

    it("generates lighter prompt for agent loop", () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        },
      ];
      const result = toolsToLightPrompt(tools);
      assert.ok(typeof result === "string");
      assert.ok(result.includes("search"));
    });
  });

  describe("applyToolPrompt", () => {
    it("appends tool instructions to system message", () => {
      const tools = [
        {
          type: "function",
          function: {
            name: "calc",
            description: "Calculator",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
      const result = applyToolPrompt("You are helpful.", tools);
      assert.ok(result.includes("You are helpful."));
      assert.ok(result.includes("calc"));
    });

    it("returns original message when no tools", () => {
      const result = applyToolPrompt("System msg", []);
      assert.equal(result, "System msg");
    });
  });
});
