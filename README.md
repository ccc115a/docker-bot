# docker-bot
docker-bot: 類似 Grok bot, 但是跑在自己的 docker 裡面（全 Node.js，無 Python）

- Agent：`npm install && docker compose run --rm agent-sandbox`（先 `ollama signin`，預設模型 `gemma4:31b-cloud`，可用 `MODEL_NAME` 覆寫）
- 網站：`./web.sh` → http://localhost:3100（選模型、對話；Agent 模式可調檔案/shell 工具，shell 經 `docker exec` 跑在 `shellbox` 容器內，只共享 `./workspace`）
- 規劃：`_doc/plan.md`；測試：`./test.sh`
