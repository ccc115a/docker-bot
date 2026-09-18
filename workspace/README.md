# 沙盒家目錄

這裡是 Agent 在容器內看到的 `/home/user`（本機 `./workspace` 掛載進來）。

- Agent 的 `list_files` / `read_file` / `write_file` / `run_shell` 都鎖在這個目錄內，`..` 穿透會被擋掉。
- 放想讓 Agent 處理的檔案進來，產出也會寫回這裡。
