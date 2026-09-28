"""示例：敏感词改写（单向插件）。on_send 在明文域改写；on_read 原样通过。"""
NAME = "filter-words"

SENSITIVE = {"密码": "******", "secret": "******"}


def on_send(conv, sender, content, codec):
    if codec != 0:
        return content, codec          # 非明文（如已加密）不处理
    for word, rep in SENSITIVE.items():
        content = content.replace(word, rep)
    return content, codec


def on_read(conv, msg, content, codec):
    return content, codec              # 单向插件：无需还原
