// docker-bot web: static chat UI + Ollama proxy + agent mode (file/shell tools).
// Pure Node.js (playwright comes from repo-root node_modules via agent.mjs import).
// Run: npm start / node server.mjs
// Env: PORT (default 3000), OLLAMA_HOST (default http://localhost:11434),
//      FILE_ROOT (default <repo>/workspace — same dir the container sees as /home/user)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTools,
  parseToolArguments,
  executeTool,
  trimMessages,
} from "../agent.mjs";

const PORT = Number(process.env.PORT || 3000);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
process.env.FILE_ROOT ||= join(dirname(HERE), "workspace");
// 網站版 shell 一律丟進 Docker 跑（shellbox 容器），本機只暴露共用資料夾；
// 直接 node server.mjs 又不想用 docker 時，可設 SHELL_VIA_DOCKER=0 改回本機執行。
process.env.SHELL_VIA_DOCKER ??= "1";
process.env.SHELL_CONTAINER ??= "agent_shellbox";

const AGENT_TOOL_NAMES = ["list_files", "read_file", "write_file", "run_shell", "finish_task"];
const AGENT_TOOLS = buildTools().filter((t) => AGENT_TOOL_NAMES.includes(t.function.name));
const AGENT_SYSTEM =
  "你是沙盒助理，只能透過呼叫工具行動，絕對不要反問使用者該做什麼，也不要憑空編造檔案內容。" +
  "你有四種工具：list_files（列出沙盒家目錄檔案）、read_file（讀檔）、" +
  "write_file（寫檔，可寫程式）、run_shell（在沙盒家目錄執行指令，工作目錄就是家目錄本身，" +
  "想知道目前路徑就執行 pwd）。所有檔案路徑都相對於沙盒家目錄。" +
  "每一輪都必須呼叫一個工具；拿到結果後，用 finish_task 回報給使用者（result 寫繁體中文摘要）。";
const AGENT_MAX_STEPS = 10;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

async function handleModels(res) {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!r.ok) throw new Error(`ollama status ${r.status}`);
    const data = await r.json();
    send(res, 200, { models: (data.models || []).map((m) => m.name) });
  } catch (e) {
    send(res, 502, { error: `cannot reach ollama at ${OLLAMA_HOST}: ${e.message}` });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "invalid JSON body" });
  }
  const { model, messages, stream = true, think } = payload || {};
  if (!model || !Array.isArray(messages)) {
    return send(res, 400, { error: "body needs { model: string, messages: [{role, content}] }" });
  }
  const upstreamBody = { model, messages, stream };
  // think:false 關掉深度思考 → 回應快很多；不帶則沿用模型預設
  if (think !== undefined) upstreamBody.think = think;
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return send(res, 502, { error: `cannot reach ollama at ${OLLAMA_HOST}: ${e.message}` });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return send(res, upstream.status, { error: `ollama error: ${text.slice(0, 300)}` });
  }
  if (!stream) {
    const data = await upstream.json();
    return send(res, 200, data);
  }
  // Pass Ollama NDJSON stream straight through to the browser.
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

async function handleAgent(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "invalid JSON body" });
  }
  const { model, messages, think, maxSteps = AGENT_MAX_STEPS } = payload || {};
  if (!model || !Array.isArray(messages)) {
    return send(res, 400, { error: "body needs { model: string, messages: [{role, content}] }" });
  }
  const upstreamBody = { model, messages: null, stream: false };
  if (think !== undefined) upstreamBody.think = think;

  const hist = [{ role: "system", content: AGENT_SYSTEM }, ...messages];
  const steps = [];
  let done = false;
  let result = "";
  let step = 0;
  const limit = Math.min(Math.max(Number(maxSteps) || AGENT_MAX_STEPS, 1), AGENT_MAX_STEPS);

  while (!done && step < limit) {
    step += 1;
    const trimmed = trimMessages(hist);
    upstreamBody.messages = trimmed;
    let msg;
    try {
      const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return send(res, 502, { error: `ollama error: ${t.slice(0, 300)}`, steps, done: false, result });
      }
      msg = (await r.json()).message || {};
      hist.push(msg);
    } catch (e) {
      return send(res, 502, { error: `ollama call failed: ${e.message}`, steps, done: false, result });
    }

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      // 模型直接回話：當作最終答案收尾
      result = msg.content || "";
      done = true;
      break;
    }
    for (const call of toolCalls) {
      const funcName = (call.function || {}).name || "";
      const args = parseToolArguments((call.function || {}).arguments || {});
      let detail;
      try {
        [detail] = await executeTool(null, funcName, args);
        if (funcName === "finish_task") {
          result = args.result || "";
          done = true;
        }
      } catch (e) {
        detail = `工具執行失敗: ${e.message || e}`;
      }
      steps.push({ tool: funcName, args, detail });
      hist.push({ role: "tool", content: JSON.stringify({ status: "executed", detail }) });
      if (done) break;
    }
  }
  send(res, 200, { done, steps, result });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/api/models" || req.url.startsWith("/api/models?"))) {
    return handleModels(res);
  }
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && req.url === "/api/agent") return handleAgent(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log(`web on http://localhost:${PORT} (ollama: ${OLLAMA_HOST}, files: ${process.env.FILE_ROOT})`);
});
