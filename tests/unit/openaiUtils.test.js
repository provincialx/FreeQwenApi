import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenAIMessages,
  buildCombinedTools,
  hasOpenAIToolState,
  prepareOpenAIMessageInput,
  getRepeatedToolCalls,
  getBlockedToolCalls,
} from "../../src/api/openaiUtils.js";

describe("openaiUtils", () => {
  describe("parseOpenAIMessages", () => {
    it("extracts system message and last user content", () => {
      const messages = [
        { role: "system", content: "You are a bot" },
        { role: "user", content: "Hello" },
      ];
      const result = parseOpenAIMessages(messages);
      assert.equal(result.systemMessage, "You are a bot");
      assert.ok(result.messageContent);
    });

    it("handles missing system message", () => {
      const messages = [{ role: "user", content: "Hi" }];
      const result = parseOpenAIMessages(messages);
      assert.equal(result.systemMessage, null);
    });

    it("handles content array format", () => {
      const messages = [
        {
          role: "user",
          content: [{ type: "text", text: "Describe this" }],
        },
      ];
      const result = parseOpenAIMessages(messages);
      assert.ok(result.messageContent);
    });
  });

  describe("buildCombinedTools", () => {
    it("uses tools when provided, ignores functions", () => {
      const tools = [{ type: "function", function: { name: "a" } }];
      const functions = [{ name: "b", parameters: {} }];
      const result = buildCombinedTools(tools, functions);
      assert.equal(result.combinedTools.length, 1);
      assert.equal(result.combinedTools[0].function.name, "a");
    });

    it("converts functions to tools format when no tools", () => {
      const functions = [{ name: "b", parameters: {} }];
      const result = buildCombinedTools(null, functions);
      assert.equal(result.combinedTools.length, 1);
      assert.equal(result.combinedTools[0].type, "function");
      assert.equal(result.combinedTools[0].function.name, "b");
    });

    it("returns null combinedTools when neither tools nor functions", () => {
      const result = buildCombinedTools(null, null);
      assert.equal(result.combinedTools, null);
    });
  });

  describe("hasOpenAIToolState", () => {
    it("returns false for empty messages", () => {
      assert.equal(hasOpenAIToolState([]), false);
    });

    it("detects tool role in messages", () => {
      const messages = [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ];
      assert.equal(hasOpenAIToolState(messages), true);
    });
  });

  describe("prepareOpenAIMessageInput", () => {
    it("returns missingUser flag when no user message", () => {
      const messages = [{ role: "system", content: "sys" }];
      const result = prepareOpenAIMessageInput(messages, [], null, "model");
      assert.equal(result.missingUser, true);
    });

    it("prepares input correctly with user message", () => {
      const messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ];
      const result = prepareOpenAIMessageInput(messages, [], null, "model");
      assert.equal(result.missingUser, false);
      assert.ok(result.messageContent);
    });
  });

  describe("getRepeatedToolCalls", () => {
    it("returns empty array for empty input", () => {
      assert.deepEqual(getRepeatedToolCalls([], []), []);
    });
  });

  describe("getBlockedToolCalls", () => {
    it("returns empty array for empty input", () => {
      assert.deepEqual(getBlockedToolCalls([], []), []);
    });
  });
});
