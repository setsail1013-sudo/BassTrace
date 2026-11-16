"""Read a local chord-chart PDF into positioned text boxes.

Microsoft Print to PDF often has no text layer. An empty text layer is not a
result: the page is rasterized and read with a local Tesseract. Nothing is
uploaded. Missing tools raise a Chinese error instead of inventing alignment.
"""
from __future__ import annotations

import html
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .chord_chart import Glyph
from .models import normalize_chord_symbol, valid_chord_symbol

MAX_PAGES = 30
MAX_GLYPHS = 20000
_LANG_CACHE: dict[str, set[str]] = {}


class ChartToolError(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class ChartReadError(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def capabilities() -> dict:
    missing = missing_tools()
    return {"available": not missing, "reason": "" if not missing else "、".join(missing)}


def missing_tools() -> list[str]:
    """Tools required only after the PDF text layer is empty."""
    missing = []
    raster, raster_error = _locate("BASSCHART_PDFTOPPM", "pdftoppm")
    ocr, ocr_error = _locate("BASSCHART_TESSERACT", "tesseract")
    if raster_error:
        missing.append(raster_error)
    elif raster is None:
        missing.append("pdftoppm（Poppler，用于把 PDF 页面转成图片）")
    if ocr_error:
        missing.append(ocr_error)
    elif ocr is None:
        missing.append("Tesseract OCR")
    elif not _has_language(ocr, "chi_sim"):
        missing.append("Tesseract 中文语言包 chi_sim")
    return missing


def extract_glyphs(pdf: bytes) -> list[Glyph]:
    if not pdf.startswith(b"%PDF-"):
        raise ChartReadError("上传的文件不是有效的 PDF。")
    with tempfile.TemporaryDirectory(prefix="basstrace-chord-") as directory:
        path = Path(directory) / "chart.pdf"
        path.write_bytes(pdf)
        text_layer = _text_layer(path)
        # A page number or watermark is not a chart. Fall through to local OCR.
        if _useful_text_layer(text_layer):
            return _limit(text_layer)
        missing = missing_tools()
        if missing:
            raise ChartToolError(
                "无法解析没有文字层的和弦谱，本机缺少：" + "、".join(missing) + "。请先安装后再导入，不会改写工程。"
            )
        return _limit(_ocr(path, Path(directory)))


def parse_bbox_html(payload: str) -> list[Glyph]:
    """Poppler ``pdftotext -bbox-layout`` uses a bottom-left origin."""
    glyphs = []
    page_number = 0
    for chunk in re.split(r"<page\b", payload)[1:]:
        height_match = re.search(r'height="([\d.]+)"', chunk)
        if height_match is None:
            continue
        height = float(height_match.group(1))
        for x_min, y_min, x_max, y_max, text in re.findall(
            r'<word\b[^>]*\bxMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)"[^>]*>([^<]*)</word>',
            chunk,
        ):
            word = html.unescape(text).strip()
            if not word:
                continue
            glyphs.append(Glyph(
                word, float(x_min), height - float(y_max), float(x_max), height - float(y_min), page_number,
            ))
        page_number += 1
    return glyphs


def parse_tesseract_tsv(payload: str, page: int) -> list[Glyph]:
    glyphs = []
    for line in payload.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue
        text = parts[11].strip()
        if not text:
            continue
        left, top, width, height = (float(parts[index]) for index in range(6, 10))
        if width <= 0 or height <= 0:
            continue
        glyphs.append(Glyph(text, left, top, left + width, top + height, page))
    return glyphs


def _text_layer(path: Path) -> list[Glyph]:
    binary, error = _locate("BASSCHART_PDFTOTEXT", "pdftotext")
    if error or binary is None:
        return []
    try:
        result = subprocess.run(
            [binary, "-bbox-layout", "-enc", "UTF-8", str(path), "-"],
            capture_output=True, timeout=30, check=False, creationflags=_quiet(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode:
        return []
    payload = result.stdout.decode("utf-8", errors="replace")
    return parse_bbox_html(payload)


def _ocr(path: Path, directory: Path) -> list[Glyph]:
    raster, _error = _locate("BASSCHART_PDFTOPPM", "pdftoppm")
    ocr, _ocr_error = _locate("BASSCHART_TESSERACT", "tesseract")
    if raster is None or ocr is None:
        raise ChartToolError("无法解析没有文字层的和弦谱，本机缺少：pdftoppm（Poppler，用于把 PDF 页面转成图片）、Tesseract OCR。请先安装后再导入，不会改写工程。")
    prefix = directory / "page"
    try:
        rendered = subprocess.run(
            [raster, "-png", "-r", "200", "-f", "1", "-l", str(MAX_PAGES + 1), str(path), str(prefix)],
            capture_output=True, timeout=120, check=False, creationflags=_quiet(),
        )
    except subprocess.TimeoutExpired as exc:
        raise ChartReadError("解析和弦谱超时，请确认 PDF 页数较少后重试。") from exc
    except OSError as exc:
        raise ChartReadError("和弦谱 PDF 无法读取，请确认文件未损坏。") from exc
    images = sorted(directory.glob("page-*.png"))
    if rendered.returncode or not images:
        raise ChartReadError("和弦谱 PDF 无法读取，请确认文件未损坏。")
    if len(images) > MAX_PAGES:
        raise ChartReadError(f"和弦谱页数过多，最多解析 {MAX_PAGES} 页。")
    language = "chi_sim+eng" if _has_language(ocr, "eng") else "chi_sim"
    glyphs = []
    for page, image in enumerate(images):
        try:
            result = subprocess.run(
                [ocr, str(image), "stdout", "-l", language, "--psm", "11", "tsv"],
                capture_output=True, timeout=90, check=False, creationflags=_quiet(),
            )
        except subprocess.TimeoutExpired as exc:
            raise ChartReadError("解析和弦谱超时，请确认 PDF 页数较少后重试。") from exc
        except OSError as exc:
            raise ChartReadError("和弦谱页面解析失败，请确认 PDF 未损坏且本机 Tesseract 可用。") from exc
        if result.returncode:
            raise ChartReadError("和弦谱页面解析失败，请确认 PDF 未损坏且本机 Tesseract 可用。")
        glyphs.extend(parse_tesseract_tsv(result.stdout.decode("utf-8", errors="replace"), page))
        image.unlink(missing_ok=True)
    if not glyphs:
        raise ChartReadError("没有从和弦谱版面中提取到文字，未写入和弦。请确认 PDF 能在本机打开。")
    return glyphs


def _limit(glyphs: list[Glyph]) -> list[Glyph]:
    if len(glyphs) > MAX_GLYPHS:
        raise ChartReadError("和弦谱版面过大，未写入和弦。")
    return glyphs


def _locate(env_key: str, executable: str) -> tuple[str | None, str | None]:
    configured = os.environ.get(env_key, "").strip()
    if configured:
        if Path(configured).is_file():
            return str(Path(configured)), None
        return None, f"{env_key} 指定的程序不存在，请检查路径。"
    return shutil.which(executable), None


def _useful_text_layer(glyphs: list[Glyph]) -> bool:
    for glyph in glyphs:
        text = glyph.text.strip()
        if any("\u4e00" <= char <= "\u9fff" for char in text):
            return True
        if valid_chord_symbol(normalize_chord_symbol(text)):
            return True
    return False


def _languages(binary: str) -> set[str]:
    cached = _LANG_CACHE.get(binary)
    if cached is not None:
        return cached
    try:
        result = subprocess.run(
            [binary, "--list-langs"], capture_output=True, timeout=15, check=False, text=True, creationflags=_quiet(),
        )
        listing = f"{result.stdout}\n{result.stderr}"
        found = {line.strip() for line in listing.splitlines() if line.strip() and " " not in line.strip()}
    except (OSError, subprocess.TimeoutExpired):
        found = set()
    _LANG_CACHE[binary] = found
    return found


def _has_language(binary: str, language: str) -> bool:
    return language in _languages(binary)


def _quiet() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
