#!/bin/bash
set -x

node --check agent.mjs && node --check web/server.mjs

curl -s http://localhost:11434/api/tags | head -c 500 || true

ollama list 2>/dev/null | grep "gemma4:31b-cloud" || echo "WARN: gemma4:31b-cloud not in ollama list"

docker compose config

docker compose build

docker compose run --rm agent-sandbox || true

ls -la final_screenshot.png || true

# 檔案/shell 工具單元測試（本機模式：路徑鎖 + 讀寫 + shell）
rm -rf /tmp/agent-fs-test
FILE_ROOT=/tmp/agent-fs-test SHELL_VIA_DOCKER=0 node -e "
import('./agent.mjs').then(async (m) => {
  const assert = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); };
  const call = async (n, a) => (await m.executeTool(null, n, a))[0];
  for (const bad of ['..', '/etc/passwd', 'a/../../..']) {
    let t = false; try { m.resolveInRoot(bad); } catch { t = true; }
    assert(t, 'escape not blocked: ' + bad);
  }
  assert((await call('write_file', { path: 'd/f.txt', content: 'hello' })).includes('已寫入'), 'write');
  const l = await call('list_files', { path: '' });
  assert(l.includes('d'), 'list: ' + l);
  assert((await call('read_file', { path: 'd/f.txt' })) === 'hello', 'read');
  const s = await call('run_shell', { command: 'cat d/f.txt && pwd' });
  assert(s.startsWith('exit=0') && s.includes('hello') && s.includes('agent-fs-test'), 'shell: ' + s.slice(0, 120));
  console.log('FS_LOCAL_OK');
}).catch(e => { console.error(e.message); process.exit(1); });
"
rm -rf /tmp/agent-fs-test

# shellbox 鏈路測試（docker exec 跑在容器內 + 共用資料夾互通）
docker compose up -d shellbox
FILE_ROOT="$PWD/workspace" SHELL_VIA_DOCKER=1 SHELL_CONTAINER=agent_shellbox node -e "
import('./agent.mjs').then(async (m) => {
  const assert = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); };
  const call = async (n, a) => (await m.executeTool(null, n, a))[0];
  const s1 = await call('run_shell', { command: 'pwd' });
  assert(s1.startsWith('exit=0') && s1.includes('/home/user'), 'pwd: ' + s1.slice(0, 120));
  await call('write_file', { path: '.test-probe', content: 'ping' });
  const s2 = await call('run_shell', { command: 'cat .test-probe' });
  assert(s2.includes('ping'), 'shared vol: ' + s2.slice(0, 120));
  await call('run_shell', { command: 'rm -f .test-probe' });
  console.log('SHELLBOX_OK');
}).catch(e => { console.error(e.message); process.exit(1); });
"
