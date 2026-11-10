"""Local PDF rendering, isolated from the audio-analysis executor and project storage."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

from typing import Literal
from .models import Model, Project

ROOT = Path(__file__).resolve().parent.parent
RENDER_LIMIT = threading.BoundedSemaphore(1)


def capabilities() -> dict:
    try:
        runtime()
    except PdfUnavailable as exc:
        return {"available": False, "reason": str(exc)}
    roots = [os.environ.get(key, "") for key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
    edge = any(root and (Path(root) / "Microsoft/Edge/Application/msedge.exe").is_file() for root in roots)
    return {"available": edge, "reason": "" if edge else "需要 Microsoft Edge；仍可使用浏览器打印。"}


class PdfExportRequest(Model):
    project: Project
    mode: Literal["chart", "structure"] = "chart"
    degree: bool = False


class PdfUnavailable(RuntimeError):
    pass


def runtime() -> tuple[str, Path]:
    node = os.environ.get("BASSCHART_NODE") or shutil.which("node")
    script = ROOT / "frontend" / "scripts" / "render-pdf.mjs"
    if not node or not Path(node).is_file():
        raise PdfUnavailable("PDF 渲染需要 Node.js。请通过启动脚本重新启动项目，也可使用浏览器打印。")
    if not (ROOT / "frontend" / "dist-renderer" / "score.mjs").is_file():
        raise PdfUnavailable("PDF 渲染组件尚未构建，请重新运行启动脚本，或先使用浏览器打印。")
    return node, script


def render_pdf(request: PdfExportRequest) -> bytes:
    node, script = runtime()
    if not RENDER_LIMIT.acquire(timeout=1):
        raise PdfUnavailable("另一份 PDF 正在生成，请稍后重试。")
    try:
        result = subprocess.run(
            [node, str(script)], cwd=str(ROOT / "frontend"),
            input=json.dumps(request.model_dump(), ensure_ascii=False).encode("utf-8"),
            capture_output=True, timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode or not result.stdout.startswith(b"%PDF-"):
            detail = result.stderr.decode("utf-8", errors="replace").strip()[-1500:]
            raise PdfUnavailable("PDF 生成失败，请重试或使用浏览器打印。" + (" " + detail if detail else ""))
        return result.stdout
    except subprocess.TimeoutExpired as exc:
        raise PdfUnavailable("PDF 生成超过 60 秒，请减少每行小节数后重试。") from exc
    except OSError as exc:
        raise PdfUnavailable("无法启动 PDF 渲染组件，请检查 Node.js 和 Microsoft Edge 安装。") from exc
    finally:
        RENDER_LIMIT.release()
