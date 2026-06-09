import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getIdempotencyKey,
  getCachedResult,
  cacheResult,
  generateChatIdFromHistory,
  normalizeIdValue,
  isOpenWebUiMetaRequest,
  extractConversationHint,
  extractParentHint,
  shouldForceNewChat,
} from "../../src/api/chatSession.js";

describe("chatSession", () => {
  describe("normalizeIdValue", () => {
    it("returns null for falsy values", () => {
      assert.equal(normalizeIdValue(null), null);
      assert.equal(normalizeIdValue(undefined), null);
      assert.equal(normalizeIdValue(""), null);
    });

    it("trims string IDs", () => {
      const result = normalizeIdValue("  Chat_ABC  ");
      assert.ok(typeof result === "string");
      assert.ok(!result.includes(" "));
    });
  });

  describe("getIdempotencyKey", () => {
    it("generates consistent key for same messages and chatId", () => {
      const msgs = [{ role: "user", content: "test" }];
      const key1 = getIdempotencyKey(msgs, "chat-1");
      const key2 = getIdempotencyKey(msgs, "chat-1");
      assert.equal(key1, key2);
    });

    it("generates different keys for different chatIds", () => {
      const msgs = [{ role: "user", content: "test" }];
      const key1 = getIdempotencyKey(msgs, "chat-a");
      const key2 = getIdempotencyKey(msgs, "chat-b");
      assert.notEqual(key1, key2);
    });

    it("returns null for empty messages", () => {
      assert.equal(getIdempotencyKey([], "chat-1"), null);
      assert.equal(getIdempotencyKey(null, "chat-1"), null);
    });
  });

  describe("cacheResult / getCachedResult", () => {
    it("stores and retrieves cached result", () => {
      const key = "test-cache-key-" + Date.now();
      const data = { choices: [{ message: { content: "cached" } }] };
      cacheResult(key, data);
      const retrieved = getCachedResult(key);
      assert.deepEqual(retrieved, data);
    });

    it("returns null for missing key", () => {
      assert.equal(getCachedResult("nonexistent-key-xyz"), null);
    });
  });

  describe("generateChatIdFromHistory", () => {
    it("returns null for empty messages", () => {
      assert.equal(generateChatIdFromHistory([]), null);
    });

    it("generates chat ID from user messages", () => {
      const msgs = [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ];
      const id = generateChatIdFromHistory(msgs);
      assert.ok(id);
      assert.ok(id.startsWith("chat_"));
    });
  });

  describe("isOpenWebUiMetaRequest", () => {
    it("returns false for normal messages", () => {
      const msgs = [{ role: "user", content: "Hello" }];
      assert.equal(isOpenWebUiMetaRequest(msgs), false);
    });

    it("detects meta requests with ### Task:", () => {
      const msgs = [{ role: "user", content: "### Task: summarize history" }];
      assert.equal(isOpenWebUiMetaRequest(msgs), true);
    });
  });

  describe("extractConversationHint", () => {
    it("returns null when no hint present", () => {
      const req = { headers: {}, body: {} };
      assert.equal(extractConversationHint(req), null);
    });
  });

  describe("extractParentHint", () => {
    it("returns null when no parent hint", () => {
      const req = { headers: {}, body: {} };
      assert.equal(extractParentHint(req), null);
    });
  });

  describe("shouldForceNewChat", () => {
    it("returns false by default", () => {
      const req = { headers: {}, body: {} };
      assert.equal(shouldForceNewChat(req), false);
    });
  });
});
