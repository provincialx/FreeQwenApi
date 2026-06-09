import express from "express";
import adminRoutes from "./adminRoutes.js";
import fileRoutes from "./fileRoutes.js";
import { sendMessage, getApiKeys } from "./chat.js";
import {
  truncateForPrompt,
  compactJsonSchema,
  toolsToPrompt,
  toolsToLightPrompt,
  parseToolCallParts,
  normalizeToolCalls,
  applyToolPrompt,
} from "./toolUtils.js";
import { logInfo, logError, logWarn, logDebug } from "../logger/index.js";
import { getMappedModel } from "./modelMapping.js";
import { loadHistory, saveHistory } from "./chatHistory.js";
import crypto from "crypto";
import { ALLOW_UNSCOPED_SESSION_CHAT_RESTORE } from "../config.js";

// ─── Chat Session (idempotency, chat ID resolution, scoped sessions) ──────────
import {
  getIdempotencyKey,
  getCachedResult,
  cacheResult,
  generateChatIdFromHistory,
  normalizeIdValue,
  buildInternalChatIdFromHint,
  extractConversationHint,
  extractParentHint,
  shouldForceNewChat,
  invalidateModelDefaultChat,
  resolveQwenChatId,
  isOpenWebUiMetaRequest,
  getSavedChatId,
  getModelDefaultChats,
  TOOL_CALL_RESET_THRESHOLD,
  persistSessionState,
} from "./chatSession.js";

// ─── OpenAI Message Processing ─────────────────────────────────────────────
import {
  parseOpenAIMessages,
  buildCombinedTools,
  areAllToolsFailed,
  hasOpenAIToolState,
  prepareOpenAIMessageInput,
  getRepeatedToolCalls,
  getBlockedToolCalls,
} from "./openaiUtils.js";

// ─── Project Context (anti-hallucination) ───────────────────────────────────
import { buildProjectContext } from "./projectContext.js";

// ─── Response Builders (streaming, tool calls SSE) ─────────────────────────
import {
  buildOpenAIToolResponse,
  writeToolCallsSse,
} from "./responseBuilders.js";

const router = express.Router();

// ─── Mount sub-routers (before auth) ──────────────────────────────────────
router.use(adminRoutes);

// ─── Auth middleware ─────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logError("Отсутствует или некорректный заголовок авторизации");
    return res.status(401).json({ error: "Требуется авторизация" });
  }

  const token = authHeader.substring(7).trim();
  if (!apiKeys.includes(token)) {
    logError("Предоставлен недействительный API ключ");
    return res.status(401).json({ error: "Недействительный токен" });
  }
  next();
}

router.use(authMiddleware);
router.use((req, res, next) => {
  req.url = req.url.replace(/\/v[12](?=\/|$)/g, "").replace(/\/+/g, "/");
  next();
});

// ─── Mount protected sub-routers (after auth + URL normalization) ──────────────
router.use(fileRoutes);
// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/chat/completions", (req, res) => {
  res.status(405).json({
    error: "Метод не поддерживается",
    message: "Используйте POST /api/chat/completions",
  });
});

router.post("/chat/completions", async (req, res) => {
  try {
    const { messages, model, stream, tools, functions, tool_choice, chatId } =
      req.body;
    const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
    const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
    const explicitParentId = extractParentHint(req);
    const conversationHint = extractConversationHint(req);
    const conversationScope = conversationHint
      ? `conversation:${conversationHint}`
      : null;
    const forceNewChat = shouldForceNewChat(req);
    logInfo(`Получен OpenAI-совместимый запрос${stream ? " (stream)" : ""}`);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      logError("Запрос без сообщений");
      return res.status(400).json({ error: "Сообщения не указаны" });
    }

    const isMeta = isOpenWebUiMetaRequest(messages);

    // Используем переданный chatId ИЛИ восстанавливаем из сессии
    let effectiveChatId = explicitChatId;
    let effectiveParentId = explicitParentId;

    if (forceNewChat && !explicitChatId && !isMeta) {
      effectiveChatId = `chat_${crypto.randomBytes(8).toString("hex")}`;
      effectiveParentId = null;
      logInfo(
        `Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`,
      );
    }

    if (!effectiveChatId && !isMeta) {
      if (conversationHint) {
        const scopedSession = forceNewChat
          ? null
          : getSavedChatId(req, conversationScope);
        if (scopedSession?.chatId) {
          effectiveChatId = scopedSession.chatId;
          if (!effectiveParentId && scopedSession.parentId) {
            effectiveParentId = scopedSession.parentId;
          }
          logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
        } else {
          effectiveChatId = buildInternalChatIdFromHint(conversationHint);
          logInfo(`Using client conversation-id key: ${effectiveChatId}`);
        }
      } else if (ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
        const savedSession = forceNewChat ? null : getSavedChatId(req);
        if (savedSession?.chatId) {
          effectiveChatId = savedSession.chatId;
          if (!effectiveParentId && savedSession.parentId) {
            effectiveParentId = savedSession.parentId;
          }
          logInfo(`Restored chatId from session: ${effectiveChatId}`);
        }

        if (!effectiveChatId) {
          const generatedId = generateChatIdFromHistory(messages);
          if (generatedId) {
            effectiveChatId = generatedId;
            logInfo(`Created new chatId for session: ${effectiveChatId}`);
          }
        }
      } else {
        logDebug(
          "chatId/conversation_id не переданы, unscoped session fallback отключён",
        );
      }
    }

    // Извлекаем system message если есть
    const systemMsg = messages.find((msg) => msg.role === "system");
    const systemMessage = systemMsg ? systemMsg.content : null;
    const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

    const preparedInput = prepareOpenAIMessageInput(
      messages,
      combinedTools,
      effectiveChatId,
      model,
    );
    if (preparedInput.missingUser) {
      logError("В запросе нет сообщений от пользователя");
      return res
        .status(400)
        .json({ error: "В запросе нет сообщений от пользователя" });
    }

    let messageContent = preparedInput.messageContent;

    // Преобразуем OpenAI format content array во внутренний формат
    if (Array.isArray(messageContent)) {
      messageContent = messageContent.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        } else if (item.type === "image_url" && item.image_url) {
          // OpenAI format: image_url: { url: '...' }
          return { type: "image", image: item.image_url.url };
        } else if (item.type === "image") {
          // Уже во внутреннем формате
          return { type: "image", image: item.image };
        }
        return item;
      });
    }

    const files = preparedInput.files || []; // ← ИЗВЛЕКАЕМ FILES
    if (preparedInput.folded) {
      logInfo(
        "OpenAI transcript folded into single user message for context/tool-result preservation",
      );
    }

    if (isMeta) {
      effectiveChatId = null;
      effectiveParentId = null;
      logDebug(
        "OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)",
      );
    }

    let mappedModel = model ? getMappedModel(model) : "qwen-max-latest";
    if (model && mappedModel !== model) {
      logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
    }
    logInfo(`Используется модель: ${mappedModel}`);
    if (systemMessage)
      logInfo(
        `System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? "..." : ""}`,
      );

    // Detect agent-loop: history has tool results — use lightweight prompt to prevent infinite tool loops.
    // When Qwen already executed tools and got results, aggressive "CALL A TOOL" rules make it call
    // more tools instead of synthesizing a text answer. Light prompt keeps parsing ability but drops coercive rules.
    const inAgentLoop = hasOpenAIToolState(messages);

    // When every tool call failed ("does not exist", etc.), skip injection entirely
    // — Qwen mirrors error text creating hallucination loop. Let it answer naturally instead.
    const allFailed = areAllToolsFailed(messages);
    if (allFailed) {
      logInfo(
        `🗑 All tools failed in history — skipping tool prompt to break hallucination loop`,
      );
    } else if (inAgentLoop) {
      logInfo(
        `🔁 Agent-loop detected — tool history present, using light tool prompt`,
      );
    }

    const qwenTools = null; // Qwen Chat web API не умеет OpenAI tool schemas

    // Use SAME prompt variant for both system_message AND content prefix.
    // Mixing verbose + light creates conflicting instructions that confuse Qwen
    // into generating plain text instead of JSON tool_calls.
    let zedToolsPrompt = "";
    if (
      !allFailed &&
      Array.isArray(combinedTools) &&
      combinedTools.length > 0
    ) {
      zedToolsPrompt = inAgentLoop
        ? toolsToLightPrompt(combinedTools)
        : toolsToPrompt(combinedTools);
    }

    // Inject Zed tool protocol into the user message content.
    // Qwen Chat API ignores system_message when continuing existing chats,
    // so instructions MUST be in the user-facing message text to take effect.
    if (zedToolsPrompt) {
      const prefix =
        zedToolsPrompt + "\n\nПользовательский запрос / текущий контекст:\n";
      if (typeof messageContent === "string") {
        messageContent = prefix + messageContent;
      } else if (Array.isArray(messageContent)) {
        let inserted = false;
        const updated = messageContent.map((item) => {
          if (!inserted && typeof item === "object" && item?.type === "text") {
            const newItem = { ...item, text: prefix + String(item.text || "") };
            inserted = true;
            return newItem;
          }
          return item;
        });
        if (!inserted) {
          updated.unshift({ type: "text", text: prefix.trimEnd() });
        }
        messageContent = updated;
      }
    }

    let finalSystemMessage = allFailed
      ? systemMessage
      : applyToolPrompt(systemMessage, combinedTools, inAgentLoop);

    // Anti-hallucination: inject project context ONCE into system message.
    const projectContext = buildProjectContext();
    if (projectContext) {
      finalSystemMessage = `${finalSystemMessage || ""}\n\n${projectContext}`;
    }

    // Сворачиваем историю, чтобы не превращать консоль в "потрошное месиво" при agent-loop (tool_calls)
    const roleCounts = {};
    messages.forEach((m) => {
      if (m?.role) roleCounts[m.role] = (roleCounts[m.role] || 0) + 1;
    });
    logInfo(
      `История: ${messages.length} сообщений (${Object.entries(roleCounts)
        .map(([r, c]) => `${c}${c > 1 ? "x" : ""} ${r}`)
        .join(", ")})`,
    );
    if (effectiveChatId) {
      logInfo(
        `Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || "null"}`,
      );
    }

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Transfer-Encoding", "chunked");

      const writeSse = (payload) => {
        res.write("data: " + JSON.stringify(payload) + "\n\n");
      };

      try {
        const qwenChatId = await resolveQwenChatId(
          effectiveChatId,
          mappedModel,
        );

        // Setup streaming callback if stream=true
        let streamingCallback = null;
        let hasStreamedChunks = false;
        const captureToolCalls =
          Array.isArray(combinedTools) && combinedTools.length > 0;
        if (stream && !captureToolCalls) {
          streamingCallback = (chunk) => {
            hasStreamedChunks = true;
            writeSse({
              id: "chatcmpl-stream",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: mappedModel || "qwen-max-latest",
              choices: [
                { index: 0, delta: { content: chunk }, finish_reason: null },
              ],
            });
          };
        }

        // Keep Zed alive during tool-capture wait — send thinking placeholder so client doesn't timeout
        if (stream && captureToolCalls) {
          writeSse({
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: mappedModel || "qwen-max-latest",
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          });
          logDebug("Thinking placeholder sent (tool-capture mode)");
        }

        // Idempotency check: prevent Qwen from receiving duplicate tool calls/messages when Zed retries
        const idemKey = getIdempotencyKey(messages, effectiveChatId);
        const cachedResult = getCachedResult(idemKey);
        if (cachedResult) {
          logInfo(`⚡️ Returning deduplicated response for streaming request`);
          writeSse({
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: mappedModel || "qwen-max-latest",
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          });
          const cachedContent = cachedResult.choices?.[0]?.message?.content;
          if (cachedContent)
            writeSse({
              id: "chatcmpl-stream",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: mappedModel || "qwen-max-latest",
              choices: [
                {
                  index: 0,
                  delta: { content: cachedContent },
                  finish_reason: null,
                },
              ],
            });
          writeSse({
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: mappedModel || "qwen-max-latest",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
          res.write("data: [DONE]\\n\\n");
          res.end();
          return;
        }

        const result = await sendMessage(
          messageContent,
          mappedModel,
          qwenChatId,
          effectiveParentId,
          files,
          qwenTools,
          tool_choice,
          finalSystemMessage,
          streamingCallback,
        );

        // Parse tool calls — always capture the parsed result for fallback use.
        // When Qwen returns text like "Привет" + {"tool_calls":[]}, we need
        // parts.visible (stripped of JSON marker) instead of raw content.
        let parts = null;
        if (captureToolCalls) {
          parts = parseToolCallParts(result?.choices?.[0]?.message?.content);
          const rawCalls = parts.calls || [];
          const toolCalls = normalizeToolCalls(rawCalls);

          // Anti-loop: detect repeated/blocked tool calls (from Python fork)
          if (toolCalls && toolCalls.length > 0) {
            const repeated = getRepeatedToolCalls(toolCalls, messages);
            const blocked = getBlockedToolCalls(toolCalls, messages);

            if (repeated.length > 0) {
              logInfo(
                `🔁 Anti-loop guard: ${repeated.join(", ")} уже выполнялись`,
              );
              const fallbackContent =
                parts?.visible ||
                "Останавливаю повторные вызовы инструментов. Модель получила результат — перейди к следующему шагу.";
              writeSse({
                id: "chatcmpl-stream",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: mappedModel || "qwen-max-latest",
                choices: [
                  {
                    index: 0,
                    delta: { content: fallbackContent },
                    finish_reason: null,
                  },
                ],
              });
              writeSse({
                id: "chatcmpl-stream",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: mappedModel || "qwen-max-latest",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              });
              res.write("data: [DONE]\n\n");
              res.end();

              persistSessionState(
                result,
                qwenChatId,
                isMeta,
                effectiveChatId,
                conversationScope,
                mappedModel,
                req,
                effectiveParentId,
              );
              return;
            }
          }

          if (toolCalls && toolCalls.length > 0) {
            writeToolCallsSse(
              res,
              mappedModel,
              result,
              toolCalls,
              parts.visible,
            );

            // Persist session AFTER writeToolCallsSse — captureToolCalls path
            // skips this by returning early, so scoped+default caches need explicit save.
            persistSessionState(
              result,
              qwenChatId,
              isMeta,
              effectiveChatId,
              conversationScope,
              mappedModel,
              req,
              effectiveParentId,
            );

            // Auto-reset: инкремент toolCallCount, но НЕ сбрасываем СРЕДИ agent loop.
            // Qwen теряет контекст предыдущего assistant.tool_calls в свежем чате →
            // пишет объяснительный текст вместо continuation.
            const defChat = getModelDefaultChats().get(mappedModel);
            if (defChat && !explicitChatId) {
              defChat.toolCallCount = (defChat.toolCallCount || 0) + 1;
              defChat.inAgentLoop = true; // mark loop active — defer reset
            }
            return;
          }
        }

        persistSessionState(
          result,
          qwenChatId,
          isMeta,
          effectiveChatId,
          conversationScope,
          mappedModel,
          req,
          effectiveParentId,
        );

        // Auto-reset: применяем ТОЛЬКО когда agent loop завершён (модель
        // написала текст без tool_calls). Mid-loop invalidation ломает Qwen —
        // свежий чат не имеет внутреннего контекста assistant.tool_calls и
        // модель отвечает объяснительным текстом вместо continuation.
        {
          const dc = getModelDefaultChats().get(mappedModel);
          if (dc && !explicitChatId) {
            if (
              dc.inAgentLoop &&
              dc.toolCallCount >= TOOL_CALL_RESET_THRESHOLD
            ) {
              logInfo(
                `♻️ Agent loop ended. Auto-reset: достигнут лимит ${TOOL_CALL_RESET_THRESHOLD} tool calls для ${mappedModel}`,
              );
              invalidateModelDefaultChat(mappedModel);
            }
            dc.inAgentLoop = false;
          }
        }

        // Warn: модель получила инструменты но не использовала
        if (
          Array.isArray(combinedTools) &&
          combinedTools.length > 0 &&
          !result.error &&
          result.choices?.[0]?.message &&
          !result.choices[0].message.tool_calls &&
          result.choices[0].message.content
        ) {
          logWarn(
            `Модель не использовала инструменты. Предоставлено: ${combinedTools.length}. Ответ: ${String(result.choices[0].message.content).substring(0, 120)}...`,
          );
        }

        if (result.error) {
          writeSse({
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: mappedModel || "qwen-max-latest",
            choices: [
              {
                index: 0,
                delta: { content: `Ошибка: ${result.error}` },
                finish_reason: null,
              },
            ],
          });
        } else if (
          !hasStreamedChunks &&
          result.choices &&
          result.choices[0] &&
          result.choices[0].message &&
          result.choices[0].message.content
        ) {
          // Qwen вернул JSON/обычный ответ вместо SSE - отправляем контент одним чанком.
          // When we parsed tool calls and got visible text (stripped of JSON marker),
          // use that to prevent leaking {"tool_calls":[]} into the user-visible response.
          let content = result.choices[0].message.content;
          if (
            parts &&
            typeof parts === "object" &&
            parts.visible !== undefined
          ) {
            content = parts.visible || content;
          }
          logDebug(`JSON response content length: ${content.length}`);
          if (typeof streamingCallback === "function") {
            streamingCallback(content);
          } else {
            writeSse({
              id: "chatcmpl-stream",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: mappedModel || "qwen-max-latest",
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            });
          }
        } else {
          logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
        }
        // Чанки уже были отправлены через streamingCallback, не дублируем!

        writeSse({
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: mappedModel || "qwen-max-latest",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (error) {
        logError("Ошибка при обработке потокового запроса", error);
        writeSse({
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: mappedModel || "qwen-max-latest",
          choices: [
            {
              index: 0,
              delta: { content: "Internal server error" },
              finish_reason: "stop",
            },
          ],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);
      const result = await sendMessage(
        messageContent,
        mappedModel,
        qwenChatId,
        effectiveParentId,
        null, // files
        qwenTools,
        tool_choice,
        finalSystemMessage,
      );

      persistSessionState(
        result,
        qwenChatId,
        isMeta,
        effectiveChatId,
        conversationScope,
        mappedModel,
        req,
        effectiveParentId,
      );

      if (result.error) {
        return res.status(500).json({
          error: { message: result.error, type: "server_error" },
        });
      }

      let parts = null;
      if (Array.isArray(combinedTools) && combinedTools.length > 0) {
        // When tools are present, parse to strip empty {"tool_calls":[]} markers
        parts = parseToolCallParts(result?.choices?.[0]?.message?.content);
      }
      const rawCalls = parts ? parts.calls || [] : [];
      const toolCalls = normalizeToolCalls(rawCalls);

      // Auto-reset: increment on tool_calls, defer until loop ends.
      // Same logic as streaming path — mid-loop invalidation breaks Qwen context.
      {
        const ndc = getModelDefaultChats().get(mappedModel);
        if (ndc && !explicitChatId) {
          ndc.toolCallCount = (ndc.toolCallCount || 0) + 1;
          ndc.inAgentLoop = true;
        }
      }

      if (toolCalls && toolCalls.length > 0) {
        return res.json(
          buildOpenAIToolResponse(
            result,
            mappedModel,
            toolCalls,
            parts.visible,
          ),
        );
      }

      // Auto-reset: apply deferred reset when loop naturally ends (text response)
      {
        const nrdc = getModelDefaultChats().get(mappedModel);
        if (nrdc && !explicitChatId) {
          if (
            nrdc.inAgentLoop &&
            nrdc.toolCallCount >= TOOL_CALL_RESET_THRESHOLD
          ) {
            logInfo(
              `♻️ Agent loop ended. Non-stream auto-reset: достигнут лимит ${TOOL_CALL_RESET_THRESHOLD} tool calls для ${mappedModel}`,
            );
            invalidateModelDefaultChat(mappedModel);
          }
          nrdc.inAgentLoop = false;
        }
      }

      // Use stripped content when we parsed tool call markers but got empty array
      let responseContent = result.choices?.[0]?.message?.content || "";
      if (parts?.visible !== null && parts.visible !== undefined) {
        responseContent = parts.visible || responseContent;
      }

      const openaiResponse = {
        id: result.id || "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || "qwen-max-latest",
        choices:
          result.choices?.[0]?.message?.content === responseContent
            ? result.choices
            : [
                {
                  index: 0,
                  message: { role: "assistant", content: responseContent },
                  finish_reason: "stop",
                },
              ],
        usage: result.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        chatId: result.chatId,
        parentId: result.parentId,
      };

      // Сохраняем историю чата
      if (result.chatId) {
        try {
          const currentChat = loadHistory(result.chatId);
          const responseMessage = {
            role: "assistant",
            content: openaiResponse.choices[0].message.content,
          };
          const updatedMessages = messages.concat([responseMessage]);
          saveHistory(result.chatId, {
            ...currentChat,
            messages: updatedMessages,
          });
        } catch (e) {
          logDebug(`Не удалось сохранить историю: ${e.message}`);
        }
      }

      res.json(openaiResponse);
    }
  } catch (error) {
    logError("Ошибка при обработке запроса", error);
    res.status(500).json({
      error: { message: "Внутренняя ошибка сервера", type: "server_error" },
    });
  }
});

// ─── Export ──────────────────────────────────────────────────────────────────

export default router;
