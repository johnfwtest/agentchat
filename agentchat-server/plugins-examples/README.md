# 消息插件示例（也是接口的可执行文档）

机制详见 `docs/DESIGN.md` 消息处理管道章节。用法：把想要的 `.py` 拷到
`agentchat-server/plugins/` 目录，并在其中 `plugins.txt` 清单里加入对应行（一行一个，顺序 =
发送管道顺序；**不在清单里的插件不启用**）。改完 `docker compose restart
agentchat-server` 生效。

- `filter_words.py`  — 敏感词改写（单向：on_send 改写，on_read 原样通过）
- `audit_log.py`     — 审计旁路（只记录，不改内容不改 codec）
- `encrypt_demo.py`  — 演示级流加密（可逆：on_send 加密 codec 0→1，on_read
                       解密 1→0，失败原样返回兼容存量/伪造数据。生产请换
                       成成熟加密库实现）
