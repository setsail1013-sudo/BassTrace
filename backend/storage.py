from __future__ import annotations

import json
import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .models import Project, utc_now
from .timeline import beat_to_time

DATA_ROOT = Path(__file__).resolve().parent / "data" / "projects"
LOCK = threading.RLock()
EXPORTING: set[str] = set()
ID_PATTERN = re.compile(r"(?:demo|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\Z")
GRID_FIELDS = ("bpm", "meter", "offset", "beatTimes")


def index_path() -> Path:
    return DATA_ROOT / "index.sqlite3"


@contextmanager
def connect_index() -> Iterator[sqlite3.Connection]:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(index_path(), timeout=10)
    connection.execute("""CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
        updatedAt TEXT NOT NULL, revision INTEGER NOT NULL, path TEXT NOT NULL
    )""")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def update_index(connection: sqlite3.Connection, project: Project):
    # Relative metadata only; reads always resolve the validated project ID.
    connection.execute("""INSERT INTO projects(id,title,artist,updatedAt,revision,path)
        VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, artist=excluded.artist, updatedAt=excluded.updatedAt,
        revision=excluded.revision, path=excluded.path""",
        (project.id, project.title, project.artist, project.updatedAt,
         project.revision, f"{project.id}/project.json"))


def ensure_index() -> None:
    """Rebuild metadata from authoritative JSON, including pre-index projects."""
    with LOCK, connect_index() as connection:
        present_ids = set()
        for path in DATA_ROOT.glob("*/project.json"):
            try:
                project = load(path.parent.name)
            except (ValueError, FileNotFoundError):
                continue
            present_ids.add(project.id)
            update_index(connection, project)
        indexed_ids = [row[0] for row in connection.execute("SELECT id FROM projects")]
        for project_id in indexed_ids:
            if project_id not in present_ids:
                connection.execute("DELETE FROM projects WHERE id=?", (project_id,))


def derive_chord_intervals(project: Project) -> None:
    ordered = sorted(project.chords, key=lambda chord: (chord.bar, chord.beat))
    for chord in ordered:
        chord.start = max(0.0, min(project.duration, beat_to_time(project, chord.bar, chord.beat)))
    for index, chord in enumerate(ordered):
        end = ordered[index + 1].start if index + 1 < len(ordered) else project.duration
        chord.end = max(chord.start, min(project.duration, end))


def project_dir(project_id: str) -> Path:
    if not ID_PATTERN.fullmatch(project_id):
        raise ValueError("无效工程 ID")
    return DATA_ROOT / project_id


def trash_records() -> dict:
    path = DATA_ROOT / "trash.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def is_trashed(project_id: str) -> bool:
    return project_id in trash_records()


def task_running(project: Project) -> bool:
    return any(task is not None and task.state == "running" for task in
               (project.analysis, project.lyricAlignment, project.keyAnalysis,
                project.harmonyAnalysis, project.backingAnalysis))


def write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def save(project: Project):
    with LOCK:
        if is_trashed(project.id):
            raise FileNotFoundError("歌曲已移入回收站")
        derive_chord_intervals(project)
        project.updatedAt = utc_now()
        write_json(project_dir(project.id) / "project.json", project.model_dump())
        with connect_index() as connection:
            update_index(connection, project)


def load(project_id: str, *, include_trash: bool = False) -> Project:
    with LOCK:
        if not include_trash and is_trashed(project_id):
            raise FileNotFoundError("歌曲已移入回收站")
        path = project_dir(project_id) / "project.json"
        if not path.is_file():
            raise FileNotFoundError("找不到工程")
        project = Project.model_validate_json(path.read_text(encoding="utf-8"))
        if project.id != project_id:
            raise ValueError("工程 ID 与文件目录不匹配")
        derive_chord_intervals(project)
        if project.keyAnalysis is None and any(edit_flags(project_id).get(f) for f in ('key', 'originalKey')):
            from .models import KeyAnalysis
            project.keyAnalysis = KeyAnalysis(confirmed=True, stage='已保留人工调性')
        if 'audioSource' not in project.model_fields_set:
            original = next((s for s in project.stems if s.id == 'original'), None)
            bass = next((s for s in project.stems if s.id == 'bass' and s.available), None)
            if original and bass and original.url == bass.url:
                project.audioSource = 'uploaded_bass'
        return project


def list_projects() -> list[Project]:
    with LOCK:
        ensure_index()
        result = []
        with connect_index() as connection:
            ids = [row[0] for row in connection.execute("SELECT id FROM projects ORDER BY updatedAt DESC")]
        for project_id in ids:
            try:
                result.append(load(project_id))
            except (ValueError, FileNotFoundError):
                continue
        return sorted(result, key=lambda project: project.updatedAt, reverse=True)


def edit_flags(project_id: str) -> dict:
    path = project_dir(project_id) / "edits.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def save_user_edit(old: Project, new: Project) -> Project:
    """Detect edited events, including clients that omit manual/locked flags."""
    with LOCK:
        for field in ("bassEvents", "topTrack", "scoreStyle", "performanceNotes", "lyricAnchors"):
            if field not in new.model_fields_set:
                value = getattr(old, field)
                setattr(new, field, value.model_copy(deep=True) if hasattr(value, "model_copy")
                        else [event.model_copy(deep=True) for event in value] if isinstance(value, list) else value)
        if "performanceNotes" in new.model_fields_set:
            preserve_omitted_fields(old.performanceNotes, new.performanceNotes)
        if "scoreStyle" in new.model_fields_set:
            preserve_omitted_fields(old.scoreStyle, new.scoreStyle)
        previous_anchors = {a.id: a for a in old.lyricAnchors}
        for anchor in new.lyricAnchors:
            if anchor.id in previous_anchors:
                preserve_omitted_fields(previous_anchors[anchor.id], anchor)
        if "manualFills" not in new.model_fields_set:
            # A pre-three-track client does not know this collection. Only an
            # explicitly supplied empty list means the user cleared the track.
            new.manualFills = [group.model_copy(deep=True) for group in old.manualFills]
        else:
            previous_notes = {note.id: note for group in old.manualFills for note in group.notes}
            for group in new.manualFills:
                for note in group.notes:
                    previous = previous_notes.get(note.id)
                    if previous is None:
                        continue
                    if "notation" not in note.model_fields_set:
                        note.notation = previous.notation.model_copy(deep=True) if previous.notation else None
                    elif note.notation is not None and previous.notation is not None:
                        preserve_omitted_fields(previous.notation, note.notation)
        # Duration is server-owned; validate against the actual audio rather than
        # a submitted longer duration before writing any edit metadata.
        new.duration = old.duration
        new.clean_restored_fill_notation()
        new.validate_manual_fills()
        new.validate_bass_events()
        if "lyricsOriginal" not in new.model_fields_set:
            new.lyricsOriginal = old.lyricsOriginal
        # Task results belong to the server. A save made from a stale polling
        # snapshot must not reset task progress or delete its recognized draft.
        new.lyricAlignment = old.lyricAlignment.model_copy(deep=True)
        if new.lyricsOriginal != old.lyricsOriginal:
            from .models import LyricAlignment
            new.lyricAlignment = LyricAlignment(stage="原文已更新，请重新对齐", detectedSegments=old.lyricAlignment.detectedSegments)
        flags = edit_flags(old.id)
        # Task outputs and audio provenance cannot be replaced by stale clients.
        key_confirmed = bool(new.keyAnalysis and new.keyAnalysis.confirmed)
        new.keyAnalysis = old.keyAnalysis.model_copy(deep=True) if old.keyAnalysis else None
        if old.key != new.key or old.originalKey != new.originalKey or key_confirmed:
            from .models import KeyAnalysis
            if new.keyAnalysis is None:
                new.keyAnalysis = KeyAnalysis()
            new.keyAnalysis.confirmed = True
        new.harmonyAnalysis = old.harmonyAnalysis
        new.backingAnalysis = old.backingAnalysis
        new.audioSource = old.audioSource
        # Text offsets use browser UTF-16 carets; stale anchors are removed rather
        # than silently attached to a different word or replacement event.
        lyric_by_id = {l.id: l for l in new.lyrics}
        valid_events = {"bass": {e.id for e in new.bassEvents}, "chords": {e.id for e in new.chords}}
        new.lyricAnchors = [a for a in new.lyricAnchors
                            if a.lyricId in lyric_by_id and a.eventId in valid_events[a.track]
                            and lyric_by_id[a.lyricId].text.encode('utf-16-le')[a.startOffset * 2:a.endOffset * 2]
                            == a.text.encode('utf-16-le')]
        for field in GRID_FIELDS + ("key", "originalKey", "sections", "markers", "topTrack"):
            if getattr(old, field) != getattr(new, field):
                flags[field] = True
        for name in ("chords", "bassEvents", "lyrics", "notes"):
            before = {event.id: event for event in getattr(old, name)}
            after = getattr(new, name)
            deleted = set(flags.get("deleted_" + name, []))
            deleted.update(set(before) - {event.id for event in after})
            flags["deleted_" + name] = sorted(deleted)
            if name == 'chords':
                intervals = flags.setdefault('deleted_chord_intervals', [])
                for event_id in set(before) - {event.id for event in after}:
                    previous = before[event_id]
                    interval = [previous.start, previous.end]
                    if interval not in intervals:
                        intervals.append(interval)
            if name == "bassEvents":
                intervals = flags.setdefault("deleted_bass_intervals", [])
                for event_id in set(before) - {event.id for event in after}:
                    previous = before[event_id]
                    interval = [previous.start, previous.end]
                    if interval not in intervals:
                        intervals.append(interval)
            for event in after:
                previous = before.get(event.id)
                if name == "lyrics" and previous is not None and "order" not in event.model_fields_set:
                    event.order = previous.order
                excluded = {"source", "locked", "confidence"}
                if name == "chords":
                    excluded.update({"start", "end"})
                content = event.model_dump(exclude=excluded)
                previous_content = previous.model_dump(exclude=excluded) if previous else None
                if previous_content != content or event.source == "manual":
                    event.source = "manual"
                    event.locked = True
        new.id = old.id
        new.duration = old.duration
        new.stems = old.stems
        new.isDemo = old.isDemo
        new.analysis = old.analysis
        new.revision = old.revision + 1
        write_json(project_dir(old.id) / "edits.json", flags)
        save(new)
        return new


def preserve_omitted_fields(old, new) -> None:
    """A client that does not know a nested setting must not erase it."""
    for field in type(new).model_fields:
        previous = getattr(old, field)
        current = getattr(new, field)
        if field not in new.model_fields_set:
            setattr(new, field, previous.model_copy(deep=True) if hasattr(previous, "model_copy") else previous)
        elif hasattr(current, "model_fields_set") and hasattr(previous, "model_fields_set"):
            preserve_omitted_fields(previous, current)


def merge_candidates(current: Project, result: dict) -> Project:
    """Merge analysis with the latest saved project, preserving human decisions."""
    flags = edit_flags(current.id)
    manual_grid = any(flags.get(field) for field in GRID_FIELDS)
    for field in ("bpm", "offset", "key", "originalKey"):
        if field in result and not flags.get(field) and not (manual_grid and field in GRID_FIELDS):
            setattr(current, field, result[field])
    if not manual_grid and any(field in result for field in ("bpm", "offset", "beatTimes")):
        # A new uniform-tempo estimate must not continue using the previous
        # automatic grid. Explicit non-uniform candidate grids remain supported.
        current.beatTimes = result.get("beatTimes", [])
    if "sections" in result and not flags.get("sections") and not manual_grid:
        current.sections = result["sections"]
    for name in ("chords", "bassEvents", "lyrics", "notes"):
        if name not in result:
            continue
        if name == "bassEvents":
            current.bassEvents = merge_bass_candidates(current, result[name], flags)
            continue
        # Chord positions are measured against the analyzed beat grid. A corrected
        # human grid must remain the source of truth, so retain existing events.
        if name == "chords" and manual_grid and not result.get('_harmonyOnCurrentGrid'):
            continue
        linked_ids = {a.eventId for a in current.lyricAnchors if a.track == name and not a.disabled}
        protected = [event for event in getattr(current, name) if event.locked or event.source == "manual" or event.id in linked_ids]
        protected_ids = {event.id for event in protected}
        deleted = set(flags.get("deleted_" + name, []))
        candidates = []
        for event in result[name]:
            if event.id in protected_ids or event.id in deleted:
                continue
            if name == "chords":
                collision = any(p.bar == event.bar and abs(p.beat - event.beat) < .01 for p in protected)
                event_time = beat_to_time(current, event.bar, event.beat)
                collision = collision or any(start - 1e-6 <= event_time < end - 1e-6
                                             for start, end in flags.get('deleted_chord_intervals', []))
            else:
                event_end = event.end if name in {"lyrics", "bassEvents"} else event.start + event.duration
                collision = any(event.start < (p.end if name in {"lyrics", "bassEvents"} else p.start + p.duration)
                                and event_end > p.start for p in protected)
                if name == "bassEvents":
                    collision = collision or any(event.start < end and event.end > start
                                                 for start, end in flags.get("deleted_bass_intervals", []))
            if not collision:
                candidates.append(event)
        events = protected + candidates
        if name == "lyrics" and any(event.order is not None for event in events):
            # Explicit document order survives automatic time changes. Stable
            # sorting leaves legacy/unordered additions after the ordered text.
            events.sort(key=lambda event: (event.order is None, event.order if event.order is not None else 0))
        else:
            events.sort(key=(lambda event: (event.bar, event.beat)) if name == "chords" else (lambda event: event.start))
        setattr(current, name, events)
    return current


def merge_bass_candidates(current: Project, candidates: list, flags: dict) -> list:
    """Protect edited/deleted time spans even when candidate IDs or grids change."""
    linked_ids = {a.eventId for a in current.lyricAnchors if a.track == 'bass' and not a.disabled}
    protected = [event for event in current.bassEvents if event.locked or event.source == "manual" or event.id in linked_ids]
    exclusions = [(event.start, event.end) for event in protected]
    exclusions.extend(tuple(interval) for interval in flags.get("deleted_bass_intervals", []))
    deleted_ids = set(flags.get("deleted_bassEvents", []))
    events = list(protected)
    used_ids = {event.id for event in protected}
    for event in candidates:
        if event.id in deleted_ids and not flags.get("deleted_bass_intervals"):
            continue
        spans = [(event.start, event.end)]
        for left, right in exclusions:
            kept = []
            for start, end in spans:
                if start >= right or end <= left:
                    kept.append((start, end))
                else:
                    if start < left:
                        kept.append((start, left))
                    if end > right:
                        kept.append((right, end))
            spans = kept
        for start, end in spans:
            if end - start < .001:
                continue
            event_id = event.id
            if start != event.start or end != event.end or event_id in used_ids:
                event_id = f"{event.id[:70]}@{round(start * 1000000)}-{round(end * 1000000)}"
            if event_id in used_ids:
                continue
            used_ids.add(event_id)
            events.append(event.model_copy(update={"id": event_id, "start": start, "end": end}))
    return sorted(events, key=lambda event: (event.start, event.end, event.id))
