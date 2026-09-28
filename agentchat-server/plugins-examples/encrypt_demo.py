"""示例：演示级流加密（可逆插件）。

on_send: codec==0 时加密并标记 codec=1；已加密原样通过（不二次加密）。
on_read: codec==1 时解密还原 codec=0；失败原样返回（兼容存量明文/伪造数据）。
密钥来自环境变量 PLUGIN_DEMO_KEY（缺省值仅供演示）。演示级实现，生产请换
成熟加密库（如 cryptography.Fernet）。
"""
import base64
import hashlib
import os

NAME = "encrypt-demo"
_PREFIX = "demo1:"                    # 密文头（内嵌格式版本）


def _keystream(n: int, seed: bytes) -> bytes:
    out = b""
    block = 0
    while len(out) < n:
        out += hashlib.sha256(seed + block.to_bytes(4, "big")).digest()
        block += 1
    return out[:n]


def _xor(data: bytes, key: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(data, _keystream(len(data), key)))


def _key() -> bytes:
    return hashlib.sha256(
        os.environ.get("PLUGIN_DEMO_KEY", "agentchat-demo-key").encode()).digest()


def on_send(conv, sender, content, codec):
    if codec != 0:
        return content, codec
    data = _xor(content.encode("utf-8"), _key())
    return _PREFIX + base64.urlsafe_b64encode(data).decode(), 1


def on_read(conv, msg, content, codec):
    if codec != 1 or not content.startswith(_PREFIX):
        return content, codec
    try:
        data = base64.urlsafe_b64decode(content[len(_PREFIX):])
        return _xor(data, _key()).decode("utf-8"), 0
    except Exception:
        return content, codec          # 解不开（伪造/密钥变更）：原样返回
