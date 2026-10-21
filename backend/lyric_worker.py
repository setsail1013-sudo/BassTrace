"""Fixed local JSON worker for the optional isolated faster-whisper environment."""
from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path


def main() -> int:
    try:
        # Model imports/download libraries may log to stdout. Keep protocol
        # output separate so the parent always receives one JSON document.
        with contextlib.redirect_stdout(sys.stderr):
            from .lyrics import FasterWhisperLyrics, _direct_whisper_capabilities
            from .models import LyricsAlignRequest
            if sys.argv[1:] == ["--probe"]:
                result = _direct_whisper_capabilities()
            elif sys.argv[1:]:
                raise ValueError("未知歌词 worker 参数")
            else:
                raw = sys.stdin.read(100001)
                if len(raw) > 100000:
                    raise ValueError("歌词 worker 请求过长")
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError("歌词 worker 请求必须是 JSON 对象")
                options = LyricsAlignRequest.model_validate(request)
                vocals = Path(request.get("vocals", ""))
                if not vocals.is_absolute() or not vocals.is_file():
                    raise ValueError("歌词 worker 需要可读的绝对人声音轨路径")
                if not _direct_whisper_capabilities()["available"]:
                    raise RuntimeError("独立歌词环境尚未安装可用的 faster-whisper")
                segments = FasterWhisperLyrics().transcribe_local(vocals, model=options.model, language=options.language,
                                                                start=options.start or 0, end=options.end)
                result = {"ok": True, "segments": [segment.model_dump() for segment in segments]}
        sys.stdout.write(json.dumps(result, ensure_ascii=True))
        return 0
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)[-1600:]}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
