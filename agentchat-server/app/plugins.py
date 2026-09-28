"""消息处理插件管道（2026-09-21 设计定稿）。

字段与插件正交：
- codec（消息字段，int）= 内容形态信令，独立于插件存在。0=plain 缺省
  （存量消息无字段=0），已注册值见 CODECS；需求顺延注册。
- 插件 = 管道过滤器。无启用插件时管道为空，(content, codec) 原样直通 = 现状。

启用与顺序（清单制，对系统侵入最小）：
- plugins/ 目录（PLUGINS_DIR 可配）放插件文件（*.py）与清单 plugins.txt。
- **plugins.txt 是唯一启用源**：每行一个插件名（文件名去 .py，支持 # 注释与
  空行），清单顺序 = 发送管道顺序。不在清单里的插件文件放在目录中也不启用。
- 添加插件 = 拷文件 + 清单插入一行（中间插入即中间生效）；停用 = 删一行
  （文件可保留）；清单引用的文件不存在 = 启动 fail-loud。

管道规则（栈序还原）：
  发送：  (content, codec) → 清单顺序 P1 → P2 → ... → 落库
  读取：  (content, codec) → ... → P2⁻¹ → P1⁻¹ → 返回/推送
  读取按清单顺序的**逆序**执行（变换还原必须 LIFO）。框架保证逆序；每个
  插件自决：还原自己的变换（可逆类），或原样通过（单向/旁路类）。

插件形态（普通同步函数，可选钩子）：

    NAME = "my-plugin"                       # 日志标识
    def on_send(conv, sender, content, codec) -> tuple[str, int]
    def on_read(conv, msg, content, codec) -> tuple[str, int]

- on_send 在幂等检查后、mentions 解析/落库前（仅用户 text 消息；系统消息、
  think 不经过）；抛 HTTPException 即拒绝发送。
- on_read 在 serialize_msg（全部读取出口的公共汇聚点：REST/MCP/WS//sync/搜索）
  内执行。
- 失败策略 fail-loud：插件异常冒泡（500 + 日志）。
- 信任模型：插件与 server 同进程执行任意 Python，插件作者 = 管理员级信任。
"""
import importlib.util
import os
from pathlib import Path

from fastapi import HTTPException

# codec 注册表：int → 名称。0 恒为 plain（缺省）；需求顺延注册并同步文档。
CODECS = {
    0: "plain",
    1: "encrypted",
}

MANIFEST = "plugins.txt"          # 启用清单（唯一启用源）


class _Plugin:
    def __init__(self, name: str, on_send, on_read):
        self.name = name
        self.on_send, self.on_read = on_send, on_read


_PLUGINS: list[_Plugin] = []      # 按清单顺序


def _parse_manifest(path: Path) -> list[str]:
    """清单解析：每行一个插件名（文件名去 .py）；# 注释与空行忽略。"""
    names = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            names.append(line.removesuffix(".py"))
    return names


def load_plugins(plugins_dir: str | None = None) -> int:
    """启动时按清单加载插件（目录/清单不存在 = 空管道，行为与无机制时一致）。"""
    global _PLUGINS
    _PLUGINS = []
    directory = Path(plugins_dir or os.environ.get("PLUGINS_DIR", "plugins"))
    manifest = directory / MANIFEST
    if not manifest.is_file():
        return 0
    for stem in _parse_manifest(manifest):
        file = directory / f"{stem}.py"
        if not file.is_file():
            # 清单声明了却不给文件：fail-loud（比静默少一个过滤/解密插件安全）
            raise RuntimeError(f"插件清单引用的文件不存在: {file}")
        try:
            spec = importlib.util.spec_from_file_location(
                f"agentchat_plugin_{stem}", file)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _PLUGINS.append(_Plugin(
                name=getattr(mod, "NAME", stem),
                on_send=getattr(mod, "on_send", None),
                on_read=getattr(mod, "on_read", None)))
            print(f"[plugins] enabled {stem}.py ({getattr(mod, 'NAME', stem)})")
        except Exception as e:
            raise RuntimeError(f"插件 {stem} 加载失败: {e}") from e
    if _PLUGINS:
        print(f"[plugins] {len(_PLUGINS)} 个插件，发送顺序: "
              f"{' → '.join(p.name for p in _PLUGINS)}（读取为其逆序）")
    return len(_PLUGINS)


def send_pipe(conv: dict, sender: str, content: str, codec: int) -> tuple[str, int]:
    """发送管道（清单顺序）：依次流过全部启用插件。仅用户 text 消息经过。"""
    for p in _PLUGINS:
        if p.on_send:
            content, codec = p.on_send(conv, sender, content, codec)
    return content, codec


def read_pipe(conv: dict | None, msg: dict, content: str, codec: int) -> tuple[str, int]:
    """读取管道（清单逆序）：栈式还原。serialize_msg 的唯一内容出口。"""
    for p in reversed(_PLUGINS):
        if p.on_read:
            content, codec = p.on_read(conv, msg, content, codec)
    return content, codec


def check_codec(codec: int) -> int:
    """发送入参校验：值必须在注册表内（防 typo），未知值 400。"""
    if codec not in CODECS:
        raise HTTPException(400, f"未知 codec: {codec}（已注册: {CODECS}）")
    return codec
