import express from "express";
import { getStsToken, uploadFileToQwen } from "./fileUpload.js";
import fs from "fs";

const router = express.Router();

/**
 * File upload routes: STS token retrieval and OSS upload.
 * Extracted from routes.js for modularity (Session 12).
 */

router.post("/files/getstsToken", async (req, res) => {
  try {
    const fileInfo = req.body;
    if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
      return res.status(400).json({ error: "Некорректные данные о файле" });
    }
    res.json(await getStsToken(fileInfo));
  } catch (error) {
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.post("/files/upload", async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Файл не был загружен" });
    }

    const result = await uploadFileToQwen(req.file.path);

    // Clean up local file after OSS upload attempt
    try {
      fs.unlinkSync(req.file.path);
    } catch {
      /* file already removed or inaccessible */
    }

    if (result.success) {
      res.json({
        success: true,
        file: {
          name: result.fileName,
          url: result.url,
          size: req.file.size,
          type: req.file.mimetype,
        },
      });
    } else {
      res.status(500).json({ error: "Ошибка при загрузке файла" });
    }
  } catch (error) {
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
    }
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/**
 * Chat history routes (Open WebUI compatibility)
 */

router.post("/chats/:chatId/history", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "История сообщений должна быть массивом" });
    }

    res.json({
      success: true,
      chatId,
      messagesCount: messages.length,
    });
  } catch (error) {
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

router.get("/chats/:chatId/history", async (req, res) => {
  try {
    const { chatId } = req.params;

    res.json({
      success: true,
      chatId,
      messages: [],
    });
  } catch (error) {
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export default router;
