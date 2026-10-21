"""Original synthetic 32-bar rehearsal example; no external recording or lyrics."""
import math

import numpy as np
import soundfile as sf

from .audio import peaks, recommend_fingering
from .models import Analysis, Chord, Lyric, Marker, Note, Project, Section, Stem
from .storage import LOCK, load, project_dir, save


def ensure_demo() -> Project:
    with LOCK:
        try:
            return load("demo")
        except FileNotFoundError:
            pass
        directory = project_dir("demo")
        directory.mkdir(parents=True, exist_ok=True)
        rate, duration, bpm = 22050, 80, 96
        length = rate * duration
        bass = np.zeros(length, dtype=np.float32)
        drums = np.zeros_like(bass)
        other = np.zeros_like(bass)
        rng = np.random.default_rng(96)
        chords, notes = [], []
        progression = [("Cmaj7", 36, [60, 64, 67, 71]), ("Am7", 33, [57, 60, 64, 67]),
                       ("Dm7", 38, [62, 65, 69, 72]), ("G7", 31, [55, 59, 62, 65])]
        for bar in range(1, 33):
            label, root, voicing = progression[(bar - 1) % 4]
            chords.append(Chord(id=f"demo-chord-{bar}", bar=bar, beat=1, label=label,
                                source="demo", confidence=1))
            if bar in (8, 16, 24, 32):
                chords.append(Chord(id=f"demo-chord-{bar}-3", bar=bar, beat=3, label="G7",
                                    source="demo", confidence=1))
            bar_start = (bar - 1) * 2.5
            pad_length = int(2.35 * rate)
            t_pad = np.arange(pad_length) / rate
            pad = sum(np.sin(2 * np.pi * (440 * 2 ** ((midi - 69) / 12)) * t_pad) for midi in voicing)
            pad *= .025 * np.minimum(t_pad * 8, 1) * np.minimum((2.35 - t_pad) * 3, 1)
            start = int(bar_start * rate)
            other[start:start + pad_length] += pad.astype(np.float32)
            for beat in range(4):
                time = bar_start + beat * .625
                pitch = root if beat in (0, 2) else root + (7 if beat == 1 else 12)
                if bar % 8 == 0 and beat == 3:
                    pitch = root + 10
                note_length = .48 if beat != 3 else .35
                notes.append(Note(id=f"demo-note-{bar}-{beat}", midi=pitch, start=time,
                                  duration=note_length, source="demo", confidence=1))
                n = int(note_length * rate)
                t = np.arange(n) / rate
                frequency = 440 * 2 ** ((pitch - 69) / 12)
                signal = (np.sin(2 * np.pi * frequency * t) + .28 * np.sin(4 * np.pi * frequency * t))
                signal *= .25 * np.minimum(t * 180, 1) * np.exp(-t * 4) * np.minimum((note_length - t) * 40, 1)
                start = int(time * rate)
                bass[start:start + n] += signal.astype(np.float32)
                n = int(.16 * rate)
                t = np.arange(n) / rate
                if beat % 2 == 0:
                    hit = .32 * np.sin(2 * np.pi * (55 * t + 25 * .035 * (1 - np.exp(-t / .035)))) * np.exp(-t * 25)
                else:
                    hit = .12 * rng.normal(0, 1, n) * np.exp(-t * 30)
                drums[start:start + n] += hit.astype(np.float32)
                for eighth in (0, .3125):
                    start = int((time + eighth) * rate)
                    n = int(.06 * rate)
                    noise = rng.normal(0, 1, n)
                    hat = np.diff(noise, prepend=noise[0]) * np.exp(-np.arange(n) / rate * 70) * .025
                    drums[start:start + n] += hat.astype(np.float32)
        stems = []
        for name, audio in (("original", bass + drums + other), ("bass", bass), ("drums", drums), ("other", other)):
            path = directory / f"{name}.wav"
            sf.write(path, audio, rate, subtype="PCM_16")
            stems.append(Stem(id=name, name={"original": "原曲", "bass": "贝斯", "drums": "鼓", "other": "伴奏"}[name],
                              url=f"/media/demo/{name}.wav", available=True, peaks=peaks(path)))
        stems.append(Stem(id="vocals", name="人声", available=False))
        lines = ["夜色沿着街角慢慢亮起", "低音陪我走过每个路口", "把今天的风放进口袋", "等第一道光落在肩头",
                 "跟着节奏向前走", "让每一拍都有回声", "我们在同一个起点", "听见新的明天"]
        lyrics = []
        for index, line in enumerate(lines):
            start = 10 + index * 7.5
            middle = len(line) // 2
            lyrics.extend([
                Lyric(id=f"demo-lyric-{index}-a", text=line[:middle], start=start, end=start + 2.9, source="demo"),
                Lyric(id=f"demo-lyric-{index}-b", text=line[middle:], start=start + 3.1, end=start + 6.4, source="demo"),
            ])
        project = Project(id="demo", title="夜行练习", artist="BassChart Studio 原创演示", duration=duration,
                          bpm=bpm, originalKey="C", key="C", meter="4/4", isDemo=True, stems=stems,
                          sections=[Section(id="intro", name="Intro", startBar=1, endBar=4, color="#8477c8"),
                                    Section(id="verse", name="Verse", startBar=5, endBar=12, color="#56a6a2"),
                                    Section(id="chorus", name="Chorus", startBar=13, endBar=20, color="#dd9962"),
                                    Section(id="bridge", name="Bridge", startBar=21, endBar=24, color="#b47ca2"),
                                    Section(id="chorus2", name="Chorus 2", startBar=25, endBar=28, color="#dd9962"),
                                    Section(id="outro", name="Outro", startBar=29, endBar=32, color="#8477c8")],
                          chords=chords, lyrics=lyrics, notes=recommend_fingering(notes),
                          markers=[Marker(id=f"demo-fill-{bar}", time=bar * 2.5 - .625, label="FILL",
                                          text="上行八度衔接", source="demo") for bar in (8, 16, 24)],
                          analysis=Analysis(state="complete", stage="原创演示已就绪", progress=100,
                                            warnings=["演示音频为程序生成的原创器乐，歌词为手工标注的演示文本；没有人声轨。",
                                                      "演示和弦、音符与段落来自合成工程，导入真实音频后的分析精度会不同。"] ))
        save(project)
        return project
