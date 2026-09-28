"""示例：审计旁路插件——只记录，不改内容不改 codec（对任何 codec 都观察）。"""
import logging

NAME = "audit-log"
log = logging.getLogger("agentchat.audit")


def on_send(conv, sender, content, codec):
    log.info("[audit] conv=%s sender=%s codec=%s len=%d",
             conv.get("_id"), sender, codec, len(content))
    return content, codec


def on_read(conv, msg, content, codec):
    return content, codec
