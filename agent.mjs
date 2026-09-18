/* docker-bot MVP v0.1 — ReAct Agent (Ollama 本地大腦 + Playwright 手腳).
 *
 * 任務：打開 Google → 搜尋 `NQU ERP` → 截圖存檔。
 * 規格來源：`_doc/plan.md` §5。
 * Node.js 移植版（原 main.py 已移除，repo 不再使用 Python）。
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);

export const MODEL_NAME = process.env.MODEL_NAME || "gemma4:31b-cloud";
export const MAX_STEPS = 10;
export const SCREENSHOT_PATH = "final_screenshot.png";
// Agent 在沙盒內能碰的檔案系統根目錄（容器內路徑，compose 把本機 ./workspace 掛在這裡）
export function getFileRoot() {
  return process.env.FILE_ROOT || "/home/user";
}
export const READ_MAX_BYTES = 50 * 1024;
export const WRITE_MAX_BYTES = 200 * 1024;
export const SHELL_TIMEOUT_MS = 120 * 1000;
export const SHELL_MAX_OUTPUT = 20 * 1024;
export const DEFAULT_PROMPT =
  "請幫我打開 https://www.google.com 並在搜尋框輸入 'NQU ERP'，然後完成任務。";
export const SYSTEM_PROMPT =
  "你是沙盒自動化 Agent，只能透過呼叫工具行動，絕對不要反問使用者該做什麼。" +
  "你有三類工具：瀏覽器（navigate / type_text / click_element）、" +
  "檔案（list_files / read_file / write_file，根目錄為沙盒家目錄，路徑都相對於它）、" +
  "及 shell（run_shell，可執行指令、寫程式、安裝軟體，工作目錄預設為沙盒家目錄）。" +
  "每一輪都必須呼叫一個工具推進任務；任務達成、或同樣動作失敗兩次、或確認無法繼續時，" +
  "必須呼叫 finish_task 結束並回報結果字串。";

// DOM 剪枝 JS（關鍵：防小模型 context 爆掉，只取前 15 筆「可見」互動元素）
// v2 修掉兩個致命傷：(1) 舊版會把 hidden input（如 type=file）也列入，
// 模型一點就空燒 15s timeout；(2) 舊版漏了 textarea，Google 首頁真正的
// 搜尋框（<textarea name="q">）根本不在摘要裡，模型看得到吃不到。
export const DOM_PRUNE_JS = `() => {
    const isVisible = (el) => {
        if (el.disabled) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const elements = Array.from(
        document.querySelectorAll('input:not([type="hidden"]), textarea, select, button, a')
    ).filter(isVisible);
    return elements.map(el => ({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        label: (el.getAttribute('aria-label') || el.placeholder || '').trim(),
        text: (el.innerText || el.value || '').trim().slice(0, 40),
        selector: el.id
            ? '#' + el.id
            : (el.name ? \`\${el.tagName.toLowerCase()}[name="\${el.name}"]\`
                : el.tagName.toLowerCase())
    })).slice(0, 15);
}`;

export function getOllamaHost() {
  return (process.env.OLLAMA_HOST || "http://host.docker.internal:11434").replace(/\/$/, "");
}

export function getOllamaUrl() {
  return `${getOllamaHost()}/api/chat`;
}

export function isHeadless() {
  return (process.env.HEADLESS || "true").toLowerCase() === "true";
}

export function buildTools() {
  // 8 個 tool，參數只用 string（配合模型，避免巢狀 object）。
  return [
    {
      type: "function",
      function: {
        name: "navigate",
        description: "前往指定的 URL 網址",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "type_text",
        description: "在指定輸入框填入文字並送出搜尋",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
          },
          required: ["selector", "text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "click_element",
        description: "點擊頁面上的特定元素",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS 選擇器" },
          },
          required: ["selector"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "列出沙盒家目錄下指定相對路徑的檔案與子目錄（預設為根目錄）",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相對於沙盒家目錄的路徑，預設為空字串" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "讀取沙盒家目錄下指定相對路徑的文字檔內容",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相對於沙盒家目錄的檔案路徑" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "寫入文字檔到沙盒家目錄下指定相對路徑（自動建父目錄，可寫程式）",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相對於沙盒家目錄的檔案路徑" },
            content: { type: "string", description: "要寫入的完整文字內容" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_shell",
        description: "在沙盒家目錄下執行 shell 指令（可跑程式、裝軟體），回傳 stdout/stderr 與 exit code",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要執行的 shell 指令" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish_task",
        description: "任務已完成或無法繼續時呼叫來結束",
        parameters: {
          type: "object",
          properties: {
            result: { type: "string" },
          },
          required: ["result"],
        },
      },
    },
  ];
}

// 把模型給的相對路徑鎖在 FILE_ROOT 內：.. 穿透、絕對路徑逃逸一律擋掉。
export function resolveInRoot(rel) {
  const root = path.resolve(getFileRoot());
  const p = path.resolve(root, rel || ".");
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error("路徑超出沙盒家目錄，僅允許 FILE_ROOT 內的相對路徑");
  }
  return p;
}

export async function listFiles(rel) {
  const dir = resolveInRoot(rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(
    entries.slice(0, 200).map(async (e) => {
      let size = "";
      if (e.isFile()) {
        try {
          size = String((await fs.stat(path.join(dir, e.name))).size);
        } catch {
          size = "?";
        }
      }
      return `${e.isDirectory() ? "dir " : "file"} ${size} ${e.name}`;
    }),
  );
  out.sort((a, b) => (a.startsWith("dir ") === b.startsWith("dir ") ? (a < b ? -1 : 1) : a.startsWith("dir ") ? -1 : 1));
  const more = entries.length > 200 ? `\n…還有 ${entries.length - 200} 筆未列出` : "";
  return out.join("\n") + more || "(空目錄)";
}

export async function readFile(rel) {
  const file = resolveInRoot(rel);
  const buf = await fs.readFile(file);
  if (buf.includes(0)) throw new Error("二進位檔案不讀取，請用 shell 處理");
  const text = buf.toString("utf8");
  if (buf.length > READ_MAX_BYTES) {
    return text.slice(0, READ_MAX_BYTES) + `\n…檔案過大，僅顯示前 ${READ_MAX_BYTES} bytes`;
  }
  return text;
}

export async function writeFile(rel, content) {
  if (!rel) throw new Error("path 不可為空");
  const data = String(content ?? "");
  if (Buffer.byteLength(data) > WRITE_MAX_BYTES) {
    throw new Error(`內容超過 ${WRITE_MAX_BYTES} bytes，請分多次寫入`);
  }
  const file = resolveInRoot(rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, "utf8");
  return `已寫入 ${rel}（${Buffer.byteLength(data)} bytes）`;
}

export async function runShell(command) {
  if (!command || !String(command).trim()) throw new Error("command 不可為空");
  if (useDockerShell()) return runShellDocker(command);
  await fs.mkdir(path.resolve(getFileRoot()), { recursive: true });
  try {
    const { stdout, stderr } = await execAsync(String(command), {
      cwd: path.resolve(getFileRoot()),
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: SHELL_MAX_OUTPUT,
      shell: "/bin/bash",
    });
    return formatShell(0, stdout, stderr);
  } catch (e) {
    // timeout / 非零 exit / 輸出爆炸都走這裡，照樣把輸出還給模型
    if (e.killed && e.signal === "SIGTERM") {
      return `exit=TIMEOUT（超過 ${SHELL_TIMEOUT_MS / 1000}s）\n` + formatShell("", e.stdout || "", e.stderr || "");
    }
    const overflow = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "\n…輸出過長已截斷" : "";
    return formatShell(e.code ?? 1, e.stdout || "", e.stderr || e.message) + overflow;
  }
}

// 網站版專用：shell 丟進 Docker 跑，本機只暴露共用資料夾（./workspace）。
// 容器內工作目錄固定 /home/user；FILE_ROOT 只用來做本機檔案工具的根。
export function useDockerShell() {
  return (process.env.SHELL_VIA_DOCKER || "").toLowerCase() === "1";
}

export function getShellContainer() {
  return process.env.SHELL_CONTAINER || "agent_shellbox";
}

export function runShellDocker(command) {
  const container = getShellContainer();
  const args = ["exec", "-i", "-w", "/home/user", container, "bash", "-c", String(command)];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("docker", args, { timeout: SHELL_TIMEOUT_MS });
    } catch (e) {
      resolve(`exit=DOCKER_FAIL\n--- stderr ---\n本機呼叫 docker 失敗：${e.message}`);
      return;
    }
    let out = "";
    let err = "";
    let truncated = false;
    const push = (chunk, isErr) => {
      if (truncated) return;
      const s = chunk.toString();
      if (isErr) {
        if (err.length + s.length > SHELL_MAX_OUTPUT) {
          err += s.slice(0, SHELL_MAX_OUTPUT - err.length);
          truncated = true;
        } else err += s;
      } else {
        if (out.length + s.length > SHELL_MAX_OUTPUT) {
          out += s.slice(0, SHELL_MAX_OUTPUT - out.length);
          truncated = true;
        } else out += s;
      }
    };
    child.stdout.on("data", (c) => push(c, false));
    child.stderr.on("data", (c) => push(c, true));
    child.on("error", (e) => {
      resolve(`exit=DOCKER_FAIL\n--- stderr ---\n本機呼叫 docker 失敗：${e.message}`);
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        resolve(`exit=TIMEOUT（超過 ${SHELL_TIMEOUT_MS / 1000}s）\n` + formatShell("", out, err));
        return;
      }
      if (/no such container|not running|No such container/i.test(err)) {
        resolve(
          `exit=NO_SHELLBOX\n--- stderr ---\nshellbox 容器未啟動，` +
            `請先執行：docker compose up -d shellbox\n原始錯誤：${err.slice(0, 200)}`,
        );
        return;
      }
      resolve(formatShell(code ?? 1, out, err) + (truncated ? "\n…輸出過長已截斷" : ""));
    });
  });
}

function formatShell(code, stdout, stderr) {
  const cut = (s) => {
    s = String(s || "");
    return s.length > SHELL_MAX_OUTPUT ? s.slice(0, SHELL_MAX_OUTPUT) + "\n…輸出過長已截斷" : s;
  };
  return `exit=${code}\n--- stdout ---\n${cut(stdout)}\n--- stderr ---\n${cut(stderr)}`;
}

export function parseToolArguments(raw) {
  // Ollama 有時回傳 object，有時回傳 JSON 字串，統一轉成 object。
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function trimMessages(messages, keepStates = 2, maxLen = 20) {
  // 修剪對話歷史：永遠保留 system + 原始任務；舊的「當前狀態」只留最近
  // keepStates 筆，避免 context 無限膨脹拖慢 Ollama（實測曾因此 60s timeout）。
  if (messages.length <= 2) return messages;
  const head = messages.slice(0, 2);
  const rest = messages.slice(2);
  const stateIdx = [];
  rest.forEach((m, i) => {
    if (m.role === "user" && typeof m.content === "string" && m.content.includes("當前狀態：")) {
      stateIdx.push(i);
    }
  });
  const drop = new Set(stateIdx.slice(0, Math.max(0, stateIdx.length - keepStates)));
  let out = rest.filter((_, i) => !drop.has(i));
  if (head.length + out.length > maxLen) out = out.slice(head.length + out.length - maxLen);
  return [...head, ...out];
}

export async function executeTool(page, funcName, args) {
  // 執行單一 tool，回傳 [resultDetail, taskDone]。Playwright 例外由呼叫端捕捉。
  if (funcName === "navigate") {
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return [`已成功前往 ${args.url}`, false];
  }
  if (funcName === "type_text") {
    await page.fill(args.selector, args.text, { timeout: 15000 });
    // fill 後送 Enter，讓 Google 這類搜尋框直接提交（否則任務永遠停在首頁）
    try {
      await page.press(args.selector, "Enter", { timeout: 5000 });
    } catch {
      // 忽略
    }
    return [`已在 ${args.selector} 輸入文字`, false];
  }
  if (funcName === "click_element") {
    await page.click(args.selector, { timeout: 15000 });
    return [`已點擊元素 ${args.selector}`, false];
  }
  if (funcName === "list_files") {
    return [await listFiles(args.path || ""), false];
  }
  if (funcName === "read_file") {
    return [await readFile(args.path), false];
  }
  if (funcName === "write_file") {
    return [await writeFile(args.path, args.content), false];
  }
  if (funcName === "run_shell") {
    return [await runShell(args.command), false];
  }
  if (funcName === "finish_task") {
    return ["任務結束", true];
  }
  return [`未知工具: ${funcName}`, false];
}

export async function runAgent(userPrompt = DEFAULT_PROMPT) {
  const ollamaUrl = getOllamaUrl();
  const headless = isHeadless();
  console.log(`Ollama 端點: ${ollamaUrl}`);
  console.log(`沙盒家目錄: ${path.resolve(getFileRoot())}`);
  await fs.mkdir(path.resolve(getFileRoot()), { recursive: true });
  console.log(`啟動 Playwright 瀏覽器 (Headless: ${headless})...`);

  let messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
  const tools = buildTools();
  let done = false;
  let step = 0;
  let lastFinishResult = "";

  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
    locale: "zh-TW",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    while (!done && step < MAX_STEPS) {
      step += 1;
      console.log(`\n--- Step ${step} ---`);

      // 1. DOM 剪枝狀態補充（about:blank 時跳過）
      if (page.url() !== "about:blank") {
        let summary;
        try {
          // IIFE 包裝：evaluate 吃字串時只求值不呼叫，不加 () 會拿回函式本身而非結果
          summary = await page.evaluate(`(${DOM_PRUNE_JS})()`);
        } catch (e) {
          summary = `抓取頁面元素失敗: ${e.message || e}`;
        }
        let state =
          `\n目前網址: ${page.url()}\n` + `頁面元素摘要: ${JSON.stringify(summary)}`;
        // 到達搜尋結果頁即提醒收尾（Google 可能出驗證頁，屬已知限制）
        if (page.url().includes("search?") && page.url().includes("q=")) {
          state +=
            "\n提示：已到達搜尋結果網址，若頁面顯示結果或驗證頁，請直接呼叫 finish_task 回報結果字串。";
        }
        messages.push({ role: "user", content: `任務：${userPrompt}\n當前狀態：${state}` });
      }

      // 2. 修剪歷史再送出（小模型 context 一爆就開始失憶＋超時）
      messages = trimMessages(messages);

      // 2. 呼叫本地 Ollama
      const payload = { model: MODEL_NAME, messages, tools, stream: false };
      let responseMsg;
      try {
        const res = await fetch(ollamaUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        responseMsg = (await res.json()).message || {};
        messages.push(responseMsg);
      } catch (e) {
        console.log(`呼叫 Ollama API 失敗: ${e.message || e}`);
        break;
      }

      // 3. 無 tool_calls → 印 content，下一輪繼續
      const toolCalls = responseMsg.tool_calls || [];
      if (toolCalls.length === 0) {
        console.log(`Agent 思考: ${responseMsg.content || ""}`);
        messages.push({
          role: "user",
          content:
            "請選擇一個工具繼續（navigate / type_text / click_element / list_files / read_file / write_file / run_shell），若任務已完成或卡住請呼叫 finish_task。",
        });
        continue;
      }

      // 4. 依序執行 tool
      for (const call of toolCalls) {
        const func = call.function || {};
        const funcName = func.name || "";
        const args = parseToolArguments(func.arguments || {});
        console.log(`Agent 決定執行工具: ${funcName} | 參數: ${JSON.stringify(args)}`);
        let detail;
        let finished = false;
        try {
          [detail, finished] = await executeTool(page, funcName, args);
          if (funcName === "finish_task") {
            lastFinishResult = args.result || "";
            console.log(`任務完成！結果: ${lastFinishResult}`);
            done = true;
          }
        } catch (e) {
          detail = `執行動作失敗: ${e.message || e}`;
          finished = false;
          console.log(`警告: ${detail}`);
          if (funcName === "finish_task") done = true;
        }
        messages.push({
          role: "tool",
          content: JSON.stringify({ status: "executed", detail }),
        });
        if (done) break;
      }
      // 每步之間給頁面一點載入時間
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
      } catch {
        // 忽略
      }
    }

    // 結束截圖（無論成功/熔斷都存檔，方便驗收）
    try {
      await page.screenshot({ path: SCREENSHOT_PATH });
      console.log(`最終畫面截圖已儲存: ${SCREENSHOT_PATH}`);
    } catch (e) {
      console.log(`截圖失敗: ${e.message || e}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`共執行 ${step} 步，done=${done}`);
  return done;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAgent();
}
