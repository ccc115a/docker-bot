# docker-bot — MVP 規劃（v0.1）

> 來源：`_doc/chat.md` 對話結論。
> 目標：打造類似 Grok Bot / OpenClaw 的自主 Agent 原型，但第一版只做最小可用驗證。
> 約束：**零付費 API**，LLM 使用 Ollama cloud `gemma4:31b-cloud`（需 `ollama signin`，吃免費額度）；Agent 執行環境用 Docker 隔離。

## 1. MVP 一句話定義

Mac 本機跑 Ollama（大腦，運算 offload 到 cloud）+ Docker 跑一個 Node.js + Playwright 沙盒（手腳），
讓 cloud 模型透過 ReAct + Tool Calling 完成一個端到端瀏覽器任務：
**打開 Google → 搜尋 `NQU ERP` → 截圖存檔**。

呼應 Dropbox 案例的 MVP 思維：不先做完整雲端平台，先證明「本地小模型能指揮瀏覽器做事」。

## 2. 架構決策（已定案）

| 決策 | 選擇 | 理由 |
|---|---|---|
| Ollama 放哪 | **Mac 原生，不進 Docker** | Apple Silicon 上原生 Ollama 可直接用 Metal / Unified Memory；放 Docker（經 Linux VM 轉一層）會慢 10–20% 且易 OOM |
| Agent 放哪 | **Docker 容器 `agent-sandbox`** | 隔離 Playwright / Chromium 依賴，不污染本機；產出物經 volume 掛載回本機 |
| 容器間連線 | `OLLAMA_HOST=http://host.docker.internal:11434` + `extra_hosts: host-gateway` | 讓容器內 Node 能打到 Mac 本機 Ollama |
| 模型 | `gemma4:31b-cloud`（cloud，不佔本機 GPU/RAM） | 免費額度內使用，需 `ollama signin`；帳號頁確認剩餘用量；擅長結構化 JSON / Tool Calling，不適合傳高解析截圖做視覺座標 |
| 瀏覽器模式 | `HEADLESS=true` + `--no-sandbox --disable-setuid-sandbox` | 容器內無 X11/GUI，headless 效能最佳；除錯時才切 `false` |
| 編排框架 | **不引入** LangGraph / AutoGen / CrewAI / Temporal | MVP 用手寫 ReAct loop 即可，避免重依賴 |

架構圖：

```text
macOS Host
├── Native Ollama (gemma4:31b-cloud, :11434, 運算在 cloud)
│         ▲ HTTP (host.docker.internal:11434)
│         │
└── Docker: agent-sandbox
    ├── Node.js + Playwright + Chromium (headless)
    ├── ReAct Loop (DOM 剪枝 + JSON Tool Calling)
    └── volume .:/app (截圖 / 產出物回寫本機)
```

## 3. MVP 範圍

### In scope（一定要有）
1. `docker-compose.yml`：單一 service `agent-sandbox`。
2. `Dockerfile.agent`：以 `mcr.microsoft.com/playwright:v1.42.0-jammy`（Node 版）為基底。
3. `package.json`：依賴僅 `playwright@1.42.0`（npm，版本釘死；`fetch` 用 Node 內建）。
4. `agent.mjs`：ReAct 主迴圈 + 8 個 tool（瀏覽器 3 + 檔案 3 + shell 1 + 收尾 1）+ DOM 剪枝 + 結束截圖。
5. 建置與執行 SOP + 驗收標準（見 §7）。

### Out of scope（明確不做，留給 v0.2+）
- ❌ Teach-a-Task 操作錄製 / Routine 排程
- ❌ 多 Bot 協同 / Message Bus
- ❌ Web UI（FastAPI / React / Electron）、WebSocket 即時串流、VNC
- ❌ 向量記憶（Qdrant/Chroma）、長期 Skill 庫
- ❌ `read_file` / `execute_bash` / Gmail / Notion 等擴充 tool
- ❌ Linux 生產環境 GPU 容器化（nvidia-container-toolkit）
- ❌ Computer Use 視覺座標點擊（等換大模型再做）

## 4. 專案結構

```text
docker-bot/
├── _doc/
│   ├── chat.md            # 來源對話（含 Dropbox 類比 → 架構定案）
│   ├── plan.md            # 本文件
│   └── session-ses_f4d8.md# 建構過程紀錄
├── Dockerfile.agent
├── docker-compose.yml
├── package.json
├── agent.mjs
├── workspace/           # 沙盒家目錄（掛載為容器內 /home/user）
│   └── README.md
├── final_screenshot.png # 執行後產出，維持 git 追蹤以利 reviewer 直接驗收
├── README.md
└── LICENSE
```

## 5. 技術規格

### 5.1 環境變數
| 變數 | 預設值 | 說明 |
|---|---|---|
| `OLLAMA_HOST` | `http://host.docker.internal:11434` | Mac 本機 Ollama 位址 |
| `HEADLESS` | `true` | 容器內固定 `true`，本地除錯可設 `false` |
| `MODEL_NAME` | `gemma4:31b-cloud`（`agent.mjs` 預設，可用 env `MODEL_NAME` 覆寫） | 切模型前先用網站手動試過；cloud 模型注意免費額度 |
| `FILE_ROOT` | `/home/user`（compose 掛載本機 `./workspace`） | 檔案/shell 工具的根目錄；模型只能用相對路徑，`..` 穿透擋掉 |
| `SHELL_VIA_DOCKER` | 網站預設 `1`，Docker 版 agent 預設空 | `1` 時 `run_shell` 走 `docker exec` 進 `shellbox` 容器跑，本機只暴露共用資料夾；`0` 則本機直跑 |
| `SHELL_CONTAINER` | `agent_shellbox` | `docker exec` 的目標容器名 |

### 5.2 Tool 定義（8 個，JSON Schema）
瀏覽器：
1. `navigate(url)` — `page.goto(url, wait_until="domcontentloaded", timeout=30000)` 前往指定 URL。
2. `type_text(selector, text)` — `page.fill(selector, text, timeout=15000)` 後自動對同一 selector `press("Enter", timeout=5000)`（失敗忽略）；Google 搜尋框靠此直接提交，否則任務會停在首頁。
3. `click_element(selector)` — `page.click(selector, timeout=15000)` 點擊。
檔案（路徑皆為相對於 `FILE_ROOT` 的相對路徑，`..`/絕對路徑逃逸直接報錯；讀 50KB、寫 200KB 上限）：
4. `list_files(path="")` — 列出目錄（dir 在前，最多 200 筆）。
5. `read_file(path)` — 讀文字檔；二進位檔拒讀。
6. `write_file(path, content)` — 寫檔（自動建父目錄，可寫程式）。
Shell（`cwd=FILE_ROOT`，120s timeout，輸出 20KB 截斷，永遠回傳 exit code + stdout/stderr）：
7. `run_shell(command)` — 執行指令、跑程式、裝軟體。Docker 版 agent 在容器內直跑；
   網站版經 `docker exec` 跑進常駐 `shellbox` 容器（`docker compose up -d shellbox` 啟動，
   與 agent 同鏡像、只掛 `./workspace`），本機其他目錄碰不到。
收尾：
8. `finish_task(result)` — 宣告任務完成/放棄，結束迴圈。

> 設計原則（配合小模型）：參數只用 `string`，description 用中文短句；不用巢狀 object，避免模型輸出錯誤。

### 5.3 ReAct 主迴圈
```
messages = [system, user_prompt]
step = 0, MAX_STEPS = 10
while not done and step < MAX_STEPS:
  1. 若 page.url != about:blank → 剪枝 JS 抓「可見」互動元素（見 §5.4），
     只取 tag/type/name/label/text/selector，前 15 筆；
     state 訊息每輪重貼任務原文（小模型兩三步就會失憶），格式為
     `任務：{原始 prompt}\n當前狀態：{url + 元素摘要}`；
     若 url 含 "search?" + "q="，加註「已到達結果頁（含驗證頁），請呼叫 finish_task」提示
  2. 先 `trimMessages()`（永遠保留 system + 原始任務；舊 state 只留最近 2 筆；
     總長超過 20 截斷），再 POST {OLLAMA_HOST}/api/chat {model, messages, tools, stream:false} (timeout=60s)
  3. 若無 tool_calls → 印出 content，並 append nudge（請選 tool / 卡住請 finish_task），continue
  4. 依序執行 tool：arguments 經 parse_tool_arguments() 正規化（dict 或 JSON 字串 → dict）；
     try/except 包住 Playwright 動作，回傳 {"status":"executed","detail":...} 為 tool message
  5. 若 finish_task → 記錄 result，done = True
  6. 每步尾 wait_for_load_state("domcontentloaded", timeout=5000)（失敗忽略）
page.screenshot(final_screenshot.png)（成功/熔斷皆存檔）; browser.close()
```

瀏覽器 context（`agent.mjs:runAgent`）：`userAgent` 偽裝桌面 Chrome、`locale="zh-TW"`、`viewport=1280x800`，`chromium.launch` 帶 `--no-sandbox --disable-setuid-sandbox`。DOM 剪枝呼叫須用 IIFE 包裝（`` page.evaluate(`(${DOM_PRUNE_JS})()`) ``）：`evaluate` 吃字串時只求值不呼叫，直接傳箭頭函式字串會拿回函式本身而非結果。

### 5.4 DOM 剪枝規則（關鍵：防小模型 context 爆掉）
```js
// 只取「可見」元素：排除 display:none（rect=0）、visibility:hidden、disabled；
// input[type=hidden] 直接不選；textarea/select 納入（Google 搜尋框是 <textarea name="q">）
Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select, button, a'))
  .filter(isVisible)
  .map(el => ({
    tag, type, name,
    label: aria-label || placeholder,   // 模型挑元素的主要依據
    text: (innerText || value).slice(0, 40),
    selector: id ? '#'+id : (name ? `tag[name="..."]` : tag)
  })).slice(0, 15)
```
- 不送完整 HTML、不送截圖。
- system prompt 固定一句：「你是自動化 Agent，能呼叫工具操作瀏覽器完成任務，請依當前網頁狀況選工具。」

## 6. 檔案規格摘要

- **package.json**：依賴僅 `playwright@1.42.0`（見 §3），版本釘死；HTTP 用 Node 內建 `fetch`（`AbortSignal.timeout(60000)` 取代 `requests` timeout）。
- **Dockerfile.agent**：`FROM playwright:v1.42.0-jammy` → `WORKDIR /app` → `npm install --omit=dev` → `COPY . .` → `CMD ["node","agent.mjs"]`。
- **docker-compose.yml**：services 有 `agent-sandbox` + `shellbox`（同鏡像；後者 `command: sleep infinity` 常駐待命，只掛 `./workspace`，給網站版 `docker exec` 用），`environment` 帶 `OLLAMA_HOST`/`HEADLESS`/`FILE_ROOT`，`volumes: - .:/app` + `- ./workspace:/home/user`（沙盒家目錄寫回本機），`extra_hosts: host.docker.internal:host-gateway`，`tty/stdin_open: true`。**不含 `ollama-server` service、不掛 `~/.ollama`**（已決議 Ollama 跑本機）。
- **agent.mjs**：函式清單 `getOllamaHost()` / `getOllamaUrl()` / `isHeadless()` / `getFileRoot()` / `buildTools()` / `parseToolArguments()` / `trimMessages()` / `resolveInRoot()` / `listFiles()` / `readFile()` / `writeFile()` / `runShell()` / `executeTool()` / `runAgent()`；直接執行時跑預設 prompt：`請幫我打開 https://www.google.com 並在搜尋框輸入 'NQU ERP'，然後完成任務。`

## 7. 建置、執行與驗收

### SOP（3 步）
```bash
# 0. 前置：登入 Ollama（cloud 模型用，免費額度）
ollama signin   # 已登入可跳過；帳號頁確認剩餘用量

# 1. 建置（在 docker-bot/ 下）
docker compose build

# 2. 執行（預設 gemma4:31b-cloud；換模型：MODEL_NAME=xxx docker compose run --rm agent-sandbox）
docker compose run --rm agent-sandbox
```

### 驗收標準（DoD）
- [ ] `docker compose run` 能連上 `OLLAMA_HOST`，log 第一行印出 `Ollama 端點` 且無 `呼叫失敗`。
- [ ] 終端機可見 `Step 1..N` ReAct 日誌，至少出現 1 次 `navigate` + 1 次 `finish_task`。
- [ ] 本機 `docker-bot/final_screenshot.png` 成功生成，打開可見 Google 搜尋結果頁（若為 Google 驗證頁亦算到達終點，應直接 `finish_task`，見 §5.3）。
- [ ] 連續跑 2 次皆在 `MAX_STEPS=10` 內結束（未無限迴圈；熔斷亦須存檔截圖）。

### 除錯開關
- 連不到 Ollama → 在 Mac 執行 `curl http://localhost:11434/api/tags` 確認服務；容器內改測 `host.docker.internal`。
- 元素點不到 → `HEADLESS=false` 在 Mac 本地（非 Docker）跑一次 `node agent.mjs` 肉眼觀察（需先 `npm install` + `npx playwright install chromium`）。
- 模型亂回散文 → 檢查 `tools` 是否正確傳入、`stream: false` 是否設置。

## 8. 風險與限制（已知問題）

1. **Tool Calling 不穩**：cloud 模型偶爾輸出散文而非 tool_calls → 對策：system prompt 明令「只能調工具、絕不反問」+ 每輪重貼任務 + `MAX_STEPS` 熔斷 + 無 tool_calls 時 nudge 繼續。
2. **Selector 脆弱**：無 id/name 的元素退化為裸 TAG（如 `input` 命中 10 個 hidden 元素，空燒 15s timeout）→ 對策：剪枝只收可見元素、selector 優先 `tag[name="..."]`、附 `label` 供模型辨認；v0.2 再引入 role-based 定位。
3. **Context 膨脹**：每步 append DOM JSON，實測第 6 步即 Ollama 60s timeout → 對策：`trimMessages()` 只留近期 state（見 §5.3）。
4. **Shell 雙面刃**：`run_shell` 讓模型能裝軟體跑程式，也能 `rm -rf` 搞破壞 → 對策：鎖在 `FILE_ROOT` 內（容器 + volume 雙層隔離，毀掉也只影響 `./workspace`）；120s timeout + 20KB 輸出上限防卡死。
5. **無視覺能力**：不处理驗證碼、Canvas、無 API 傳統系統 → 明確列為非目標。
4. **Mac Docker 網路**：`host.docker.internal` 在舊版 Docker 需 `extra_hosts` → 已寫入 compose。

## 9. 下一步（v0.2 候選，不在本次實作）
1. 加 `read_file` / `save_to_json` tool，讓 Agent 能寫檔。
2. FastAPI 輕量 CLI/Web 輸入（取代寫死 prompt）。
3. 成功/失敗 log 存檔，累積為 Skill 範例。

---
*驗收方式： reviewer 只需執行 §7 三行指令 + 檢查截圖，即可判定 MVP 通過。*
