import os
import json
import time
import uuid
import asyncio
import sys
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime
from typing import List, Optional, Dict, Any, Union

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from playwright.async_api import async_playwright
from pydantic import BaseModel
from dotenv import load_dotenv

# Загружаем переменные окружения из .env
load_dotenv()

# =================================================================
# CONFIGURATION & CONSTANTS
# =================================================================
PORT = int(os.environ.get("PORT", 3264))
HOST = os.environ.get("HOST", "0.0.0.0")
QWEN_BASE_URL = "https://chat.qwen.ai"
CHAT_PAGE_URL = f"{QWEN_BASE_URL}/"
CHAT_API_URL = f"{QWEN_BASE_URL}/api/v2/chat/completions"
CREATE_CHAT_URL = f"{QWEN_BASE_URL}/api/v2/chats/new"
SESSION_DIR = "session"
TOKENS_FILE = os.path.join(SESSION_DIR, "tokens.json")
DEFAULT_MODEL = "qwen-max-latest"
AVAILABLE_MODELS_FILE = os.path.join("src", "AvailableModels.txt")

# Глобальная переменная для переиспользования чата
_last_chat_id: str | None = None
_last_parent_id: str | None = None
_chat_account_map: Dict[str, str] = {}  # chat_id → account_id

# =================================================================
# MODEL MAPPING (Embedded for standalone usage)
# =================================================================
MODEL_MAPPING = {
    "qwen3.5": "qwen3.5-plus",
    "qwen-max": "qwen3-max",
    "qwen-vl": "qwen3-vl-plus",
    "qwen-coder": "qwen3-coder-plus",
    "qwen3": "qwen3-235b-a22b",
    "qwq": "qwq-32b",
    "qvq": "qvq-72b-preview-0310",
    # ... more mappings can be added here
}

def get_mapped_model(model_name: str) -> str:
    return MODEL_MAPPING.get(model_name.lower(), model_name)

def load_available_models() -> List[str]:
    models = set(MODEL_MAPPING.keys())
    models.add(DEFAULT_MODEL)
    if os.path.exists(AVAILABLE_MODELS_FILE):
        try:
            with open(AVAILABLE_MODELS_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    value = line.strip()
                    if value and not value.startswith("#"):
                        models.add(value)
        except Exception as e:
            logger.warning(f"Не удалось загрузить список моделей из {AVAILABLE_MODELS_FILE}: {e}")
    return sorted(models)

# =================================================================
# LOGGING
# =================================================================
logging.basicConfig(level=logging.DEBUG, format='[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger("FreeQwenApi")

# Настройка файлового логирования с ротацией
os.makedirs("logs", exist_ok=True)
file_handler = RotatingFileHandler("logs/proxy.log", maxBytes=5_000_000, backupCount=3)
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logging.getLogger().addHandler(file_handler)

# Глобальный HTTP-клиент для сохранения кук (сессии)
http_client = httpx.AsyncClient(timeout=120.0, follow_redirects=True)
# TOKEN MANAGEMENT
# =================================================================
def ensure_session_dir():
    if not os.path.exists(SESSION_DIR):
        os.makedirs(SESSION_DIR, exist_ok=True)

def load_tokens():
    ensure_session_dir()
    if not os.path.exists(TOKENS_FILE):
        return []
    try:
        with open(TOKENS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Ошибка загрузки tokens.json: {e}")
        return []

def save_tokens(tokens):
    ensure_session_dir()
    try:
        with open(TOKENS_FILE, "w", encoding="utf-8") as f:
            json.dump(tokens, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Ошибка сохранения tokens.json: {e}")

_pointer = 0
def get_available_token():
    tokens = load_tokens()
    now = time.time() * 1000
    valid = [t for t in tokens if not t.get('invalid') and (not t.get('resetAt') or datetime.fromisoformat(t['resetAt'].replace('Z', '+00:00')).timestamp() * 1000 <= now)]
    if not valid:
        return None
    global _pointer
    token_obj = valid[_pointer % len(valid)]
    _pointer = (_pointer + 1) % len(valid)
    return token_obj

def mark_rate_limited(token_id, hours=24):
    tokens = load_tokens()
    for t in tokens:
        if t['id'] == token_id:
            reset_time = datetime.fromtimestamp(time.time() + hours * 3600)
            t['resetAt'] = reset_time.isoformat() + "Z"
            break
    save_tokens(tokens)

# =================================================================
# AUTH & BROWSER (Playwright)
# =================================================================
async def login_interactive(email=None, password=None, headless=False):
    """Интерактивный вход через браузер для получения токена"""
    logger.info("Запуск браузера для авторизации (headless=%s)...", headless)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Переходим на страницу авторизации (signin)
        auth_url = f"{QWEN_BASE_URL}/auth?action=signin"
        await page.goto(auth_url)
        
        if email and password:
            try:
                # Ожидаем появления формы входа
                await page.wait_for_selector('input[type="text"], input[type="email"], #username', timeout=15000)
                await page.fill('input[type="text"], input[type="email"], #username', email)
                await page.keyboard.press("Enter")
                await asyncio.sleep(3)
                await page.wait_for_selector('input[type="password"], #password', timeout=10000)
                await page.fill('input[type="password"], #password', password)
                await page.keyboard.press("Enter")
            except Exception as e:
                logger.warning(f"Автоматический ввод не удался: {e}. Пожалуйста, войдите вручную в браузере.")

        print("\n" + "="*50)
        print("               АВТОРИЗАЦИЯ")
        print("="*50)
        print("1. Войдите в свой аккаунт Qwen в открытом окне браузера.")
        print("2. Дождитесь появления интерфейса чата.")
        print("3. Нажмите Enter здесь для завершения.")
        print("="*50)
        
        input("\nНажмите Enter после успешного входа...")
        
        token = None
        try:
            token = await page.evaluate("localStorage.getItem('token')")
        except Exception as e:
            logger.error(f"Не удалось получить токен: {e}")
            await browser.close()
            return
        if not token:
            logger.error("Токен не найден! Убедитесь, что вы вошли в систему.")
            await browser.close()
            return

        user_info_raw = await page.evaluate("localStorage.getItem('user_info')")
        account_name = email
        if user_info_raw:
            try:
                user_info = json.loads(user_info_raw)
                account_name = user_info.get('email') or user_info.get('nickname') or account_name
            except: pass
            
        if not account_name:
            try:
                account_name = await page.evaluate("document.querySelector('.user-name, .email')?.innerText || ''")
            except: pass
            
        # Если всё еще нет имени, генерируем автоматически как в Node JS
        if not account_name:
            account_name = f"acc_{int(time.time() * 1000)}"
            logger.info(f"Имя аккаунта не определено, используем ID: {account_name}")
            
        # Извлекаем все куки из сессии браузера
        cookies = await context.cookies()
        
        tokens = load_tokens()
        tokens = [t for t in tokens if t['id'] != account_name]
        tokens.append({
            "id": account_name,
            "token": token,
            "cookies": cookies,  # Сохраняем куки
            "added_at": datetime.now().isoformat(),
            "invalid": False,
            "resetAt": None
        })
        save_tokens(tokens)
        logger.info(f"Аккаунт {account_name} успешно добавлен!")
        await browser.close()

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": QWEN_BASE_URL,
    "Referer": CHAT_PAGE_URL,
}

# =================================================================
# CORE PROXY ENGINE
# =================================================================
async def create_qwen_chat(token_obj, model=DEFAULT_MODEL):
    """Создание нового чата через API v2"""
    token = token_obj['token']
    # Загружаем куки только если их еще нет в клиенте (чтобы не затереть новые от сервера)
    if 'cookies' in token_obj:
        for cookie in token_obj['cookies']:
            if cookie['name'] not in http_client.cookies:
                http_client.cookies.set(cookie['name'], cookie['value'], domain=cookie['domain'])

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Accept": "*/*",
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
        "Origin": QWEN_BASE_URL,
        "Referer": CHAT_PAGE_URL,
    }
    payload = {
        "title": "Новый чат",
        "models": [model],
        "chat_mode": "normal",
        "chat_type": "t2t",
        "timestamp": int(time.time() * 1000)
    }
    try:
        resp = await http_client.post(CREATE_CHAT_URL, headers=headers, json=payload, timeout=30.0)
        if resp.status_code == 200:
            content_type = resp.headers.get("content-type", "")
            if "application/json" not in content_type:
                logger.error(f"Получен неожиданный контент ({content_type}) вместо JSON. Тело: {resp.text[:500]}")
                return None
            try:
                data = resp.json()
                chat_id = data.get('data', {}).get('id')
                if chat_id:
                    logger.info(f"NEW CHAT CREATED: {chat_id} (previous _last_chat_id was {_last_chat_id})")
                return chat_id
            except Exception as je:
                logger.error(f"Ошибка парсинга JSON: {je}. Тело: {resp.text[:500]}")
        else:
            logger.error(f"Ошибка создания чата: {resp.status_code}, тело: {resp.text[:500]}")
    except Exception as e:
        logger.error(f"Исключение при создании чата: {e}")
    return None

def build_qwen_payload(message_content, model, chat_id, parent_id=None, system_message=None, files=None, tools=None):
    user_msg_id = str(uuid.uuid4())
    assistant_msg_id = str(uuid.uuid4())
    
    # Структура сообщения должна точно соответствовать API v2
    new_message = {
        "fid": user_msg_id,
        "parentId": parent_id,
        "parent_id": parent_id,
        "role": "user",
        "content": message_content,
        "chat_type": "t2t",
        "sub_chat_type": "t2t",
        "timestamp": int(time.time()),
        "user_action": "chat",
        "models": [model],
        "files": files or [],
        "childrenIds": [assistant_msg_id],
        "extra": {"meta": {"subChatType": "t2t"}},
    }
    
    payload = {
        # Для t2t-запросов Qwen API стабильнее работает через SSE-stream,
        # даже если клиент запросил нестриминговый OpenAI-ответ.
        "stream": True,
        "incremental_output": True,
        "chat_id": chat_id,
        "chat_mode": "normal",
        "messages": [new_message],
        "model": model, 
        "parent_id": parent_id,
        "timestamp": int(time.time())
    }
    
    if system_message:
        payload["system_message"] = system_message
        
    if tools:
        payload["tools"] = tools
        payload["function_calling"] = True
    else:
        new_message["feature_config"] = {"thinking_enabled": False, "output_schema": "phase"}
        
    return payload

def _normalize_message_content(content):
    if not isinstance(content, list):
        return content

    normalized = []
    for item in content:
        if not isinstance(item, dict):
            normalized.append(item)
            continue

        item_type = item.get("type")
        if item_type == "text" and isinstance(item.get("text"), str):
            normalized.append({"type": "text", "text": item["text"]})
            continue
        if item_type == "image_url" and isinstance(item.get("image_url"), dict):
            image_url = item["image_url"].get("url")
            if image_url:
                normalized.append({"type": "image", "image": image_url})
                continue
        if item_type == "image" and isinstance(item.get("image"), str):
            normalized.append({"type": "image", "image": item["image"]})
            continue
        if item_type == "file" and isinstance(item.get("file"), str):
            normalized.append({"type": "file", "file": item["file"]})
            continue

        normalized.append(item)

    return normalized

def _extract_messages(body: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages = body.get("messages")
    if isinstance(messages, list) and messages:
        return messages

    if body.get("message") is not None:
        return [{"role": "user", "content": body.get("message")}]

    return []

def _extract_chat_ids(body: Dict[str, Any]):
    chat_id = body.get("chatId") or body.get("chat_id")
    parent_id = body.get("parentId") or body.get("parent_id") or body.get("x_qwen_parent_id")
    return chat_id, parent_id

def _build_openai_completion(content: str, model: str, chat_id: Optional[str], parent_id: Optional[str], usage: Optional[Dict[str, Any]] = None, tool_calls: Optional[List[Dict[str, Any]]] = None):
    message = {"role": "assistant", "content": content}
    finish_reason = "stop"
    
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
        if content == "" or content is None:
            message["content"] = None

    return {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason
        }],
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "chatId": chat_id,
        "parentId": parent_id
    }

def _parse_qwen_error_json(parsed: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    top_code = parsed.get("code")
    nested_data = parsed.get("data") if isinstance(parsed.get("data"), dict) else {}
    nested_code = nested_data.get("code")
    has_error = (
        parsed.get("success") is False or
        bool(parsed.get("error")) or
        bool(nested_data.get("error")) or
        bool(top_code) or
        bool(nested_code)
    )
    if not has_error:
        return None

    is_rate_limited = top_code == "RateLimited" or nested_code == "RateLimited"
    return {
        "status": 429 if is_rate_limited else 500,
        "error": "Ошибка Qwen API",
        "details": json.dumps(parsed, ensure_ascii=False)
    }

async def execute_qwen_completion(token_obj, chat_id, payload, on_chunk=None):
    token = token_obj["token"]

    if "cookies" in token_obj:
        for cookie in token_obj["cookies"]:
            if cookie["name"] not in http_client.cookies:
                http_client.cookies.set(cookie["name"], cookie["value"], domain=cookie["domain"])

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Accept": "*/*",
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
        "Origin": QWEN_BASE_URL,
        "Referer": f"{QWEN_BASE_URL}/c/{chat_id}",
    }

    logger.debug(f"Отправка запроса в чат {chat_id}...")
    try:
        async with http_client.stream(
            "POST",
            f"{CHAT_API_URL}?chat_id={chat_id}",
            headers=headers,
            json=payload,
            timeout=120.0
        ) as response:
            actual_status_raw = response.headers.get("x-actual-status-code")
            try:
                actual_status = int(actual_status_raw) if actual_status_raw else None
            except Exception:
                actual_status = None

            if response.status_code != 200:
                body = (await response.aread()).decode("utf-8", errors="ignore")
                return {
                    "success": False,
                    "status": response.status_code,
                    "error": "Ошибка Qwen API",
                    "details": body
                }

            content_type = (response.headers.get("content-type") or "").lower()
            if "text/event-stream" not in content_type:
                body = (await response.aread()).decode("utf-8", errors="ignore")
                try:
                    parsed = json.loads(body)
                except Exception:
                    return {
                        "success": False,
                        "status": actual_status or 500,
                        "error": "Unexpected non-SSE 200 response",
                        "details": body
                    }

                structured_error = _parse_qwen_error_json(parsed)
                if structured_error:
                    if actual_status and actual_status >= 400:
                        structured_error["status"] = actual_status
                    structured_error["success"] = False
                    return structured_error

                content = ""
                choices = parsed.get("choices")
                if isinstance(choices, list) and choices:
                    first_choice = choices[0] if isinstance(choices[0], dict) else {}
                    msg = first_choice.get("message") if isinstance(first_choice.get("message"), dict) else {}
                    content = str(msg.get("content") or "")
                elif parsed.get("success") is True and isinstance(parsed.get("data"), dict):
                    content = str(parsed["data"].get("content") or "")

                if content and callable(on_chunk):
                    on_chunk({"type": "content", "data": content})

                return {
                    "success": True,
                    "content": content,
                    "response_id": parsed.get("response_id") or parsed.get("id"),
                    "usage": parsed.get("usage") or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                }

            full_content = ""
            response_id = None
            usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            finished = False
            accumulated_tool_calls: Dict[int, Dict[str, Any]] = {}

            async for raw_line in response.aiter_lines():
                line = raw_line.strip()
                if not line or not line.startswith("data:"):
                    continue

                data_str = line[5:].strip()
                if not data_str:
                    continue
                if data_str == "[DONE]":
                    break

                try:
                    chunk = json.loads(data_str)
                except Exception:
                    continue

                if chunk.get("code") == "RateLimited" or (chunk.get("code") and chunk.get("detail")):
                    return {"success": False, "status": 429, "error": "RateLimited", "details": json.dumps(chunk, ensure_ascii=False)}
                if chunk.get("error") and not chunk.get("choices"):
                    return {"success": False, "status": 500, "error": "Ошибка Qwen API", "details": json.dumps(chunk, ensure_ascii=False)}

                created_meta = chunk.get("response.created")
                if isinstance(created_meta, dict) and created_meta.get("response_id"):
                    response_id = created_meta["response_id"]
                if chunk.get("response_id"):
                    response_id = chunk["response_id"]

                chunk_usage = chunk.get("usage")
                if isinstance(chunk_usage, dict):
                    usage = chunk_usage

                choices = chunk.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue

                first_choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = first_choice.get("delta") if isinstance(first_choice.get("delta"), dict) else {}
                
                # Логировать наличие tool_calls в каждом chunk
                if delta.get("tool_calls"):
                    logger.info(f"SSE chunk has tool_calls: {len(delta['tool_calls'])} calls")

                piece = delta.get("content")
                if piece is not None:
                    piece_str = str(piece)
                    full_content += piece_str
                    if callable(on_chunk):
                        on_chunk({"type": "content", "data": piece_str})

                tool_calls_delta = delta.get("tool_calls")
                if tool_calls_delta:
                    # Отправляем инкрементальные обновления tool_calls в поток
                    if callable(on_chunk):
                        on_chunk({"type": "tool_calls", "data": tool_calls_delta})

                    for tc in tool_calls_delta:
                        idx = tc.get("index", 0)
                        if idx not in accumulated_tool_calls:
                            accumulated_tool_calls[idx] = {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                        if tc.get("id"):
                            accumulated_tool_calls[idx]["id"] = tc["id"]
                        fn = tc.get("function", {})
                        if fn.get("name"):
                            accumulated_tool_calls[idx]["function"]["name"] += fn["name"]
                        if fn.get("arguments"):
                            accumulated_tool_calls[idx]["function"]["arguments"] += fn["arguments"]

                if delta.get("status") == "finished" or first_choice.get("finish_reason"):
                    finished = True
                    break

            final_tool_calls = None
            if accumulated_tool_calls:
                final_tool_calls = [accumulated_tool_calls[k] for k in sorted(accumulated_tool_calls.keys())]

            return {
                "success": True,
                "content": full_content,
                "response_id": response_id,
                "usage": usage,
                "finished": finished,
                "tool_calls": final_tool_calls
            }

    except Exception as e:
        logger.error(f"Ошибка запроса к Qwen API: {e}")
        return {
            "success": False,
            "status": 500,
            "error": "Proxy error",
            "details": str(e)
        }

# =================================================================
# FASTAPI APP
# =================================================================
app = FastAPI(title="FreeQwenApi Python")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def _stream_openai_response(token_info, chat_id: str, payload: Dict[str, Any], model: str):
    global _last_chat_id, _last_parent_id
    queue: asyncio.Queue = asyncio.Queue()
    has_streamed_chunks = False

    def on_chunk(chunk_data: Union[str, Dict[str, Any]]):
        if chunk_data:
            # Защита от передачи строки вместо словаря (обратная совместимость)
            if isinstance(chunk_data, str):
                queue.put_nowait({"type": "content", "data": chunk_data})
            else:
                queue.put_nowait(chunk_data)

    task = asyncio.create_task(execute_qwen_completion(token_info, chat_id, payload, on_chunk=on_chunk))

    try:
        while True:
            if task.done() and queue.empty():
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=0.2)
            except asyncio.TimeoutError:
                continue

            has_streamed_chunks = True
            
            if item.get("type") == "content":
                yield "data: " + json.dumps({
                    "id": "chatcmpl-stream",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": item["data"]}, "finish_reason": None}]
                }, ensure_ascii=False) + "\n\n"
            elif item.get("type") == "tool_calls":
                yield "data: " + json.dumps({
                    "id": "chatcmpl-stream",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"tool_calls": item["data"]}, "finish_reason": None}]
                }, ensure_ascii=False) + "\n\n"

        result = await task
        if result.get("success"):
            _last_chat_id = chat_id
            response_parent_id = result.get("response_id") or payload.get("parent_id")
            if response_parent_id:
                _last_parent_id = response_parent_id
            
            if chat_id and token_info:
                _chat_account_map[chat_id] = token_info.get("id")

        if not result.get("success"):
            if not has_streamed_chunks:
                err_text = f"Ошибка: {result.get('error', 'Ошибка Qwen API')}"
                yield "data: " + json.dumps({
                    "id": "chatcmpl-stream",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": err_text}, "finish_reason": None}]
                }, ensure_ascii=False) + "\n\n"
        elif not has_streamed_chunks and result.get("content"):
            # Qwen иногда отвечает обычным JSON вместо SSE.
            yield "data: " + json.dumps({
                "id": "chatcmpl-stream",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": result["content"]}, "finish_reason": None}]
            }, ensure_ascii=False) + "\n\n"

        finish_reason = "stop"
        if result.get("tool_calls"):
            finish_reason = "tool_calls"

        logger.info(f"Stream finished: success={result.get('success')}, tool_calls={bool(result.get('tool_calls'))}, finish_reason={finish_reason}")

        yield "data: " + json.dumps({
            "id": "chatcmpl-stream",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]
        }, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"
    finally:
        if not task.done():
            task.cancel()

async def handle_chat_completions(body: Dict[str, Any]):
    global _last_chat_id, _last_parent_id

    messages = _extract_messages(body)
    if not messages:
        return JSONResponse(status_code=400, content={"error": "Сообщения не указаны"})

    model = body.get("model", DEFAULT_MODEL)
    stream = bool(body.get("stream", False))
    mapped_model = get_mapped_model(model)

    chat_id, parent_id = _extract_chat_ids(body)
    
    # Привязка чата к аккаунту: если чат уже существует, используем тот же аккаунт
    token_info = None
    if chat_id and chat_id in _chat_account_map:
        target_acc = _chat_account_map[chat_id]
        tokens = load_tokens()
        token_info = next((t for t in tokens if t.get("id") == target_acc and not t.get("invalid")), None)
        if token_info:
            logger.info(f"Reusing account {target_acc} for chat {chat_id}")
        else:
            logger.warning(f"Account {target_acc} for chat {chat_id} unavailable, falling back")

    if not token_info:
        token_info = get_available_token()

    if not token_info:
        return JSONResponse(status_code=401, content={"error": "Нет доступных аккаунтов."})

    system_msg_obj = next((m for m in messages if isinstance(m, dict) and m.get("role") == "system"), None)
    system_msg = system_msg_obj.get("content") if isinstance(system_msg_obj, dict) else body.get("systemMessage")

    user_msg_obj = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), None)
    if not user_msg_obj:
        return JSONResponse(status_code=400, content={"error": "В запросе нет сообщений от пользователя"})

    message_content = _normalize_message_content(user_msg_obj.get("content", ""))
    files = user_msg_obj.get("files") if isinstance(user_msg_obj.get("files"), list) else body.get("files") or []
    tools = body.get("tools")
    
    logger.info(f"Tools in request: {len(tools) if tools else 0} tools, chat_id={chat_id or 'NEW'}, parent_id={parent_id}")

    # Fallback logic: use last chat if no specific chat requested
    if not chat_id and _last_chat_id:
        chat_id = _last_chat_id
        if not parent_id and _last_parent_id:
            parent_id = _last_parent_id

    if not chat_id:
        chat_id = await create_qwen_chat(token_info, mapped_model)
        if not chat_id:
            return JSONResponse(status_code=500, content={"error": "Не удалось создать чат в Qwen"})
        if chat_id:
            _chat_account_map[chat_id] = token_info.get("id")
            logger.info(f"Mapped chat {chat_id} → account {token_info.get('id')}")

    payload = build_qwen_payload(
        message_content,
        mapped_model,
        chat_id,
        parent_id=parent_id,
        system_message=system_msg,
        files=files,
        tools=tools
    )

    if stream:
        headers = {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
        return StreamingResponse(
            _stream_openai_response(token_info, chat_id, payload, mapped_model),
            media_type="text/event-stream",
            headers=headers,
        )

    result = await execute_qwen_completion(token_info, chat_id, payload)
    if not result.get("success"):
        status = result.get("status") or 500
        if not isinstance(status, int) or status < 400:
            status = 500
        return JSONResponse(
            status_code=status,
            content={"error": {"message": result.get("details") or result.get("error") or "Ошибка Qwen API", "type": "upstream_error"}}
        )

    # Update global state after successful completion
    _last_chat_id = chat_id
    response_parent_id = result.get("response_id") or parent_id
    if response_parent_id:
        _last_parent_id = response_parent_id
    
    if chat_id and token_info:
        _chat_account_map[chat_id] = token_info.get("id")

    return _build_openai_completion(
        result.get("content", ""),
        model,
        chat_id,
        response_parent_id,
        usage=result.get("usage"),
        tool_calls=result.get("tool_calls")
    )

@app.get("/api/chat/completions")
async def chat_completions_get():
    return JSONResponse(status_code=405, content={"error": "Метод не поддерживается", "message": "Используйте POST /api/chat/completions"})

@app.get("/api/v1/chat/completions")
async def chat_completions_v1_get():
    return JSONResponse(status_code=405, content={"error": "Метод не поддерживается", "message": "Используйте POST /api/v1/chat/completions"})

@app.post("/api/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    return await handle_chat_completions(body)

@app.post("/api/v1/chat/completions")
async def chat_completions_v1(request: Request):
    body = await request.json()
    return await handle_chat_completions(body)

@app.post("/api/chat")
async def chat_endpoint(request: Request):
    body = await request.json()
    return await handle_chat_completions(body)

@app.get("/api/models")
async def list_models():
    models = load_available_models()
    return {
        "object": "list",
        "data": [
            {
                "id": m,
                "object": "model",
                "created": 0,
                "owned_by": "qwen",
                "permission": []
            }
            for m in models
        ]
    }

# =================================================================
# CLI MENU & LAUNCHER
# =================================================================
def print_banner():
    print(r"""
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██ 
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██ 
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██ 
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██ 
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██ 
                                    ▀▀                                                    
   API-прокси для Qwen (Python Native)
""")

async def interactive_menu():
    while True:
        os.system('clear' if os.name == 'posix' else 'cls')
        print_banner()
        
        tokens = load_tokens()
        print("\nСписок аккаунтов:")
        if not tokens:
            print("  (пусто)")
        else:
            for i, t in enumerate(tokens):
                is_limited = False
                if t.get('resetAt'):
                    is_limited = datetime.fromisoformat(t['resetAt'].replace('Z', '+00:00')).timestamp() > time.time()
                status = "⏳ Лимит" if is_limited else "✅ OK"
                print(f"  {i+1} | {t['id']} | {status}")
        
        print("\n=== Меню ===")
        print("1 - Добавить новый аккаунт")
        print("2 - Перелогинить (не реализовано в этой версии)")
        print("3 - Запустить прокси (по умолчанию)")
        print("4 - Удалить аккаунт")
        print("0 - Выход")
        
        try:
            choice = input("\nВаш выбор (Enter = 3): ").strip()
        except EOFError: break
        
        if choice == "" or choice == "3":
            if not tokens:
                print("Ошибка: Сначала добавьте хотя бы один аккаунт (пункт 1).")
                time.sleep(2)
                continue
            print(f"\nЗапуск сервера на {HOST}:{PORT}...")
            config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info")
            server = uvicorn.Server(config)
            await server.serve()
            break
        elif choice == "1":
            print("\n--- Добавление аккаунта ---")
            print("1 - Ручной вход в браузере (надежнее)")
            print("2 - Автоматический вход (Email + Пароль)")
            sub_choice = input("Выберите способ: ").strip()
            
            if sub_choice == "2":
                email = input("Email: ").strip()
                password = input("Пароль: ").strip()
                # Возвращаем видимый браузер по просьбе пользователя
                await login_interactive(email, password, headless=False)
            else:
                await login_interactive(headless=False)
        elif choice == "4":
            if not tokens: continue
            try:
                idx = int(input("Введите номер аккаунта для удаления: ")) - 1
                if 0 <= idx < len(tokens):
                    tokens.pop(idx)
                    save_tokens(tokens)
                    print("Аккаунт удален.")
                    time.sleep(1)
            except ValueError: pass
        elif choice == "0":
            break

if __name__ == "__main__":
    try:
        asyncio.run(interactive_menu())
    except KeyboardInterrupt:
        pass
