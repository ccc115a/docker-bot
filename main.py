"""docker-bot MVP v0.1 — ReAct Agent (Ollama 本地大腦 + Playwright 手腳).

任務：打開 Google → 搜尋 `NQU ERP` → 截圖存檔。
規格來源：`_doc/plan.md` §5。
"""
import json
import os

import requests
from playwright.sync_api import sync_playwright

MODEL_NAME = "qwen3.5:4b"
MAX_STEPS = 10
SCREENSHOT_PATH = "final_screenshot.png"
DEFAULT_PROMPT = "請幫我打開 https://www.google.com 並在搜尋框輸入 'NQU ERP'，然後完成任務。"
SYSTEM_PROMPT = "你是自動化 Agent，能呼叫工具操作瀏覽器完成任務，請依當前網頁狀況選工具，任務達成或卡住時必須呼叫 finish_task 結束。"

# DOM 剪枝 JS（關鍵：防 4B context 爆掉，只取前 15 筆互動元素）
DOM_PRUNE_JS = """() => {
    const elements = Array.from(document.querySelectorAll('input, button, a'));
    return elements.map(el => ({
        tag: el.tagName,
        id: el.id,
        name: el.name,
        text: (el.innerText || el.value || '').trim(),
        selector: el.id ? '#' + el.id : (el.name ? `[name="${el.name}"]` : el.tagName.toLowerCase())
    })).slice(0, 15);
}"""


def get_ollama_host() -> str:
    return os.getenv("OLLAMA_HOST", "http://host.docker.internal:11434").rstrip("/")


def get_ollama_url() -> str:
    return f"{get_ollama_host()}/api/chat"


def is_headless() -> bool:
    return os.getenv("HEADLESS", "true").lower() == "true"


def build_tools() -> list:
    """4 個 tool，參數只用 string（配合 4B 模型，避免巢狀 object）。"""
    return [
        {
            "type": "function",
            "function": {
                "name": "navigate",
                "description": "前往指定的 URL 網址",
                "parameters": {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "type_text",
                "description": "在指定輸入框填入文字並送出搜尋",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "selector": {"type": "string"},
                        "text": {"type": "string"},
                    },
                    "required": ["selector", "text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "click_element",
                "description": "點擊頁面上的特定元素",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "selector": {"type": "string", "description": "CSS 選擇器"},
                    },
                    "required": ["selector"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "finish_task",
                "description": "任務已完成或無法繼續時呼叫來結束",
                "parameters": {
                    "type": "object",
                    "properties": {"result": {"type": "string"}},
                    "required": ["result"],
                },
            },
        },
    ]


def parse_tool_arguments(raw) -> dict:
    """Ollama 有時回傳 dict，有時回傳 JSON 字串，統一轉成 dict。"""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def execute_tool(page, func_name: str, args: dict) -> tuple[str, bool]:
    """執行單一 tool，回傳 (result_detail, task_done)。Playwright 例外由呼叫端捕捉。"""
    if func_name == "navigate":
        page.goto(args["url"], wait_until="domcontentloaded", timeout=30000)
        return f"已成功前往 {args['url']}", False
    if func_name == "type_text":
        page.fill(args["selector"], args["text"], timeout=15000)
        # fill 後送 Enter，讓 Google 這類搜尋框直接提交（否則任務永遠停在首頁）
        try:
            page.press(args["selector"], "Enter", timeout=5000)
        except Exception:
            pass
        return f"已在 {args['selector']} 輸入文字", False
    if func_name == "click_element":
        page.click(args["selector"], timeout=15000)
        return f"已點擊元素 {args['selector']}", False
    if func_name == "finish_task":
        return "任務結束", True
    return f"未知工具: {func_name}", False


def run_agent(user_prompt: str = DEFAULT_PROMPT) -> bool:
    ollama_url = get_ollama_url()
    headless = is_headless()
    print(f"Ollama 端點: {ollama_url}")
    print(f"啟動 Playwright 瀏覽器 (Headless: {headless})...")

    messages: list = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    tools = build_tools()
    done = False
    step = 0
    last_finish_result = ""

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            locale="zh-TW",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()
        try:
            while not done and step < MAX_STEPS:
                step += 1
                print(f"\n--- Step {step} ---")

                # 1. DOM 剪枝狀態補充（about:blank 時跳過）
                if page.url != "about:blank":
                    try:
                        summary = page.evaluate(DOM_PRUNE_JS)
                    except Exception as e:
                        summary = f"抓取頁面元素失敗: {e}"
                    context = (
                        f"\n目前網址: {page.url}\n"
                        f"頁面元素摘要: {json.dumps(summary, ensure_ascii=False)}"
                    )
                    # 到達搜尋結果頁即提醒收尾（Google 可能出驗證頁，屬已知限制）
                    if "search?" in page.url and ("q=" in page.url):
                        context += "\n提示：已到達搜尋結果網址，若頁面顯示結果或驗證頁，請直接呼叫 finish_task 回報結果字串。"
                    messages.append({"role": "user", "content": f"當前狀態：{context}"})

                # 2. 呼叫本地 Ollama
                payload = {
                    "model": MODEL_NAME,
                    "messages": messages,
                    "tools": tools,
                    "stream": False,
                }
                try:
                    res = requests.post(ollama_url, json=payload, timeout=60)
                    res.raise_for_status()
                    response_msg = res.json().get("message", {})
                    messages.append(response_msg)
                except Exception as e:
                    print(f"呼叫 Ollama API 失敗: {e}")
                    break

                # 3. 無 tool_calls → 印 content，下一輪繼續
                tool_calls = response_msg.get("tool_calls", []) or []
                if not tool_calls:
                    print(f"Agent 思考: {response_msg.get('content', '')}")
                    messages.append(
                        {
                            "role": "user",
                            "content": "請選擇一個工具繼續（navigate / type_text / click_element），若任務已完成或卡住請呼叫 finish_task。",
                        }
                    )
                    continue

                # 4. 依序執行 tool
                for call in tool_calls:
                    func = (call.get("function") or {})
                    func_name = func.get("name", "")
                    args = parse_tool_arguments(func.get("arguments", {}))
                    print(f"Agent 決定執行工具: {func_name} | 參數: {args}")
                    try:
                        detail, finished = execute_tool(page, func_name, args)
                        if func_name == "finish_task":
                            last_finish_result = args.get("result", "")
                            print(f"任務完成！結果: {last_finish_result}")
                            done = True
                    except Exception as e:
                        detail, finished = f"執行動作失敗: {e}", False
                        print(f"警告: {detail}")
                        if func_name == "finish_task":
                            done = True
                    messages.append(
                        {
                            "role": "tool",
                            "content": json.dumps(
                                {"status": "executed", "detail": detail},
                                ensure_ascii=False,
                            ),
                        }
                    )
                    if done:
                        break
                # 每步之間給頁面一點載入時間
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=5000)
                except Exception:
                    pass

            # 結束截圖（無論成功/熔斷都存檔，方便驗收）
            try:
                page.screenshot(path=SCREENSHOT_PATH)
                print(f"最終畫面截圖已儲存: {SCREENSHOT_PATH}")
            except Exception as e:
                print(f"截圖失敗: {e}")
        finally:
            browser.close()

    print(f"共執行 {step} 步，done={done}")
    return done


if __name__ == "__main__":
    run_agent()
