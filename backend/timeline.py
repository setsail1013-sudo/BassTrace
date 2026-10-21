"""BPM counts quarter notes; beat cells follow the meter denominator."""
from bisect import bisect_right
from math import floor

from .models import Project


def beat_seconds(project: Project) -> float:
    denominator = int(project.meter.split("/")[1])
    return 60 / project.bpm * 4 / denominator


def anchored_times(project: Project) -> list[float]:
    """Offset anchors beat one while preserving supplied interval differences."""
    if len(project.beatTimes) < 2:
        return []
    first = project.beatTimes[0]
    return [time - first + project.offset for time in project.beatTimes]


def beat_to_time(project: Project, bar: int, beat: float = 1) -> float:
    position = (bar - 1) * int(project.meter.split("/")[0]) + beat - 1
    times = anchored_times(project)
    if not times:
        return project.offset + position * beat_seconds(project)
    index = floor(position)
    fraction = position - index
    if index < 0:
        return times[0] + position * (times[1] - times[0])
    step = times[-1] - times[-2]
    if index >= len(times) - 1:
        return times[-1] + (position - len(times) + 1) * step
    return times[index] + fraction * (times[index + 1] - times[index])


def time_to_beat(project: Project, time: float) -> tuple[int, float]:
    times = anchored_times(project)
    if not times:
        position = (time - project.offset) / beat_seconds(project)
    else:
        index = max(0, bisect_right(times, time) - 1)
        step = (times[index + 1] - times[index]) if index + 1 < len(times) else (
            times[-1] - times[-2]
        )
        position = index + (time - times[index]) / step
    count = int(project.meter.split("/")[0])
    bar_index = floor((position + 1e-9) / count)
    return bar_index + 1, max(1.0, position - bar_index * count + 1)
