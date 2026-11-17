"""Formula checks for the P0 harness.

Numbers in this file are hand-worked from the synthetic example under
evaluation_fixtures. They are not measurements of songs, separation quality,
or singing recognition.
"""
import contextlib
import inspect
import io
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from backend.evaluation.metrics import (
    bass_pitch_accuracy,
    bpm_and_measures,
    canonical_chord,
    chord_accuracy,
    human_time,
    levenshtein,
    listening_score,
    lyric_metrics,
    normalize_lyric,
    note_f1,
    parse_chord,
    section_boundaries,
)
from backend.evaluation.runner import exit_code, main, run_evaluation
from backend.evaluation.schema import (
    ChordAnnotation,
    ChordPrediction,
    GoldFile,
    HumanEditFile,
    ListeningSheet,
    NoteAnnotation,
    PredictionFile,
    SectionSpan,
    TempoAnnotation,
)


FIXTURE = Path(__file__).resolve().parent / "evaluation_fixtures"
LYRIC_TEXT = "城市的灯"


def metric_values(node):
    found = []
    if isinstance(node, dict):
        if "status" in node and "value" in node and "definition" in node:
            found.append(node["value"])
        for child in node.values():
            found.extend(metric_values(child))
    elif isinstance(node, list):
        for child in node:
            found.extend(metric_values(child))
    return found


def contains_key(node, key):
    if isinstance(node, dict):
        if key in node:
            return True
        return any(contains_key(child, key) for child in node.values())
    if isinstance(node, list):
        return any(contains_key(child, key) for child in node)
    return False


class FormulaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = FIXTURE / "tracks" / "example01"
        cls.gold = GoldFile.model_validate_json((folder / "gold.json").read_text(encoding="utf-8"))
        cls.prediction = PredictionFile.model_validate_json((folder / "prediction.json").read_text(encoding="utf-8"))
        cls.listening = ListeningSheet.model_validate_json((folder / "listening.json").read_text(encoding="utf-8"))
        cls.human = HumanEditFile.model_validate_json((folder / "human-edit.json").read_text(encoding="utf-8"))

    def test_fixture_is_marked_synthetic(self):
        self.assertTrue(self.gold.syntheticExample)
        self.assertEqual(self.gold.trackId, "example01")

    def test_hand_worked_fixture_matches_the_formulas(self):
        tempo = bpm_and_measures(self.gold.tempo, self.prediction.tempo)
        self.assertAlmostEqual(tempo["value"], 0.2)
        self.assertEqual(tempo["components"]["bpmAbsoluteError"], 60)
        self.assertEqual(tempo["components"]["nearestOctaveRelation"], "half")
        self.assertEqual(tempo["components"]["nearestOctaveAbsoluteError"], 0)
        self.assertAlmostEqual(tempo["components"]["downbeatMedianAbsoluteErrorSeconds"], 0.1)

        sections = section_boundaries(self.gold.sections, self.prediction.sections)
        self.assertAlmostEqual(sections["value"], 0.5)
        self.assertIsNone(sections["components"]["semanticNameAgreement"]["value"])
        self.assertEqual(sections["components"]["semanticNameAgreement"]["reason"], "prediction_section_names_are_not_semantic")

        chords = chord_accuracy(self.gold.chords, self.prediction.chords)
        quiet = chord_accuracy(self.gold.chords, [
            ChordPrediction(start=item.start, end=item.end, label=item.label, confidence=0) for item in self.prediction.chords
        ])
        self.assertAlmostEqual(chords["value"], 0.5)
        self.assertAlmostEqual(chords["components"]["rootAccuracy"], 1)
        self.assertEqual(chords["value"], quiet["value"])
        self.assertFalse(contains_key(chords, "confidence"))

        timing, recognition = lyric_metrics(self.gold.lyrics, self.prediction.lyrics)
        self.assertAlmostEqual(timing["value"], 0.2)
        self.assertEqual(timing["components"]["matchedLines"], 1)
        self.assertAlmostEqual(recognition["value"], 0.125)
        self.assertAlmostEqual(recognition["components"]["exactLineRecall"], 0.5)
        self.assertNotIn(LYRIC_TEXT, json.dumps(timing, ensure_ascii=False))
        self.assertNotIn(LYRIC_TEXT, json.dumps(recognition, ensure_ascii=False))

        notes = note_f1(self.gold.notes, self.prediction.notes)
        self.assertAlmostEqual(notes["value"], 0.4)
        self.assertEqual(notes["components"]["truePositives"], 1)
        self.assertEqual(notes["components"]["falsePositives"], 2)
        self.assertEqual(notes["components"]["falseNegatives"], 1)
        self.assertEqual(notes["components"]["offsetMatchRate"], 0)
        self.assertEqual(notes["components"]["onsetToleranceSeconds"], 0.05)

        bass = bass_pitch_accuracy(self.gold.bassPitches, self.prediction.bassPitches)
        self.assertAlmostEqual(bass["value"], 0.75)
        self.assertAlmostEqual(listening_score(self.listening)["value"], 3.5)
        self.assertEqual(human_time(self.human)["value"], 90)

    def test_half_tempo_does_not_replace_the_raw_bpm_error(self):
        gold = TempoAnnotation(bpm=100, meter="4/4", offsetSeconds=0, downbeats=[0])
        doubled = TempoAnnotation(bpm=200, meter="4/4", offsetSeconds=0, downbeats=[0])
        result = bpm_and_measures(gold, doubled)
        self.assertEqual(result["components"]["bpmAbsoluteError"], 100)
        self.assertEqual(result["components"]["nearestOctaveRelation"], "double")
        self.assertEqual(result["components"]["nearestOctaveAbsoluteError"], 0)

    def test_chord_spellings_and_unparsed_predictions(self):
        self.assertEqual(parse_chord("Bb"), parse_chord("A#"))
        self.assertEqual(canonical_chord(parse_chord("Bbm7")), "A#m7")
        self.assertEqual(canonical_chord(parse_chord("CM7")), "Cmaj7")
        self.assertEqual(canonical_chord(parse_chord("Cm7")), "Cm7")
        self.assertEqual(canonical_chord(parse_chord("N.C.")), "N.C.")
        self.assertIsNone(parse_chord("C?"))
        gold = [ChordAnnotation(start=0, end=2, label="C")]
        pred = [ChordPrediction(start=0, end=2, label="C?", confidence=0.99)]
        result = chord_accuracy(gold, pred)
        self.assertEqual(result["value"], 0)
        self.assertEqual(result["components"]["rootAccuracy"], 0)
        self.assertFalse(contains_key(result, "confidence"))

    def test_empty_predictions_follow_the_formula_and_not_a_perfect_score(self):
        notes = note_f1([], [])
        self.assertEqual(notes["status"], "undefined")
        self.assertIsNone(notes["value"])
        missing_predictions = note_f1([NoteAnnotation(start=0, end=1, midi=40)], [])
        self.assertIsNone(missing_predictions["value"])
        self.assertEqual(missing_predictions["components"]["recall"], 0)
        self.assertIsNone(missing_predictions["components"]["precision"])
        chords = chord_accuracy([ChordAnnotation(start=0, end=2, label="C")], [])
        self.assertEqual(chords["status"], "measured")
        self.assertEqual(chords["value"], 0)

    def test_overlapping_or_mismatched_lyrics_are_not_scored_as_zero_error(self):
        gold = self.gold.chords
        overlapped = [
            ChordPrediction(start=0, end=2, label="C"),
            ChordPrediction(start=1, end=3, label="G"),
        ]
        self.assertEqual(chord_accuracy(gold, overlapped)["status"], "not_evaluated")
        self.assertIsNone(chord_accuracy(gold, overlapped)["value"])
        words = [item.model_copy(update={"granularity": "word"}) for item in self.prediction.lyrics]
        timing, recognition = lyric_metrics(self.gold.lyrics, words)
        self.assertEqual(timing["status"], "not_evaluated")
        self.assertEqual(timing["reason"], "granularity_mismatch")
        self.assertIsNone(timing["value"])
        self.assertEqual(recognition["status"], "measured")

    def test_semantic_section_names_can_be_compared_when_both_use_the_label_set(self):
        gold = [SectionSpan(name="副歌", start=0, end=10)]
        pred = [SectionSpan(name="副歌", start=0, end=10)]
        result = section_boundaries(gold, pred)
        self.assertEqual(result["value"], 0)
        self.assertEqual(result["components"]["semanticNameAgreement"]["value"], 1)

    def test_text_normalization_and_edit_distance(self):
        self.assertEqual(normalize_lyric("Hello, 城市!"), "hello城市")
        self.assertEqual(levenshtein("kitten", "sitting"), 3)
        self.assertEqual(levenshtein("", "a"), 1)

    def test_inconsistent_human_time_is_rejected(self):
        with self.assertRaises(ValidationError):
            HumanEditFile.model_validate({
                "protocol": "basstrace-p0-eval",
                "protocolVersion": "1",
                "trackId": "example01",
                "editorId": "example",
                "startedAt": "2026-01-01T00:00:00+00:00",
                "finishedAt": "2026-01-01T00:00:10+00:00",
                "durationSeconds": 50,
                "activities": ["bpm"],
            })

    def test_gold_refuses_confidence_and_overlapping_chords(self):
        payload = json.loads((FIXTURE / "tracks" / "example01" / "gold.json").read_text(encoding="utf-8"))
        payload["chords"][0]["confidence"] = 1
        with self.assertRaises(ValidationError):
            GoldFile.model_validate(payload)
        payload = json.loads((FIXTURE / "tracks" / "example01" / "gold.json").read_text(encoding="utf-8"))
        payload["chords"][1]["start"] = 1
        with self.assertRaises(ValidationError):
            GoldFile.model_validate(payload)


class RunnerReportTests(unittest.TestCase):
    def test_package_source_does_not_call_models_or_storage(self):
        root = Path(__file__).resolve().parents[1] / "evaluation"
        text = "\n".join(path.read_text(encoding="utf-8") for path in root.glob("*.py"))
        for forbidden in ("subprocess", "WhisperModel", "separate_stems", "soundfile", "backend.audio",
                          "backend.storage", "backend.lyrics", "backend.main"):
            self.assertNotIn(forbidden, text)
        self.assertNotIn("subprocess", inspect.getsource(run_evaluation))

    def test_missing_corpus_is_not_evaluated_and_has_no_scores(self):
        report = run_evaluation(None)
        self.assertEqual(report["status"], "not_evaluated")
        self.assertEqual(exit_code(report), 3)
        self.assertIsNone(report["qualityPassed"])
        self.assertFalse(report["accuracyClaim"])
        self.assertFalse(report["benchmarkComplete"])
        self.assertFalse(report["thisProcess"]["ranDemucs"])
        self.assertFalse(report["thisProcess"]["ranWhisper"])
        self.assertFalse(report["thisProcess"]["downloadedWeights"])
        self.assertFalse(report["thisProcess"]["openedAudio"])
        self.assertFalse(report["projectsRewritten"])
        self.assertFalse(report["mixdownSubstitutedForBass"])
        self.assertFalse(report["confidenceUsedAsAccuracy"])
        self.assertEqual(report["tracks"], [])
        self.assertTrue(all(value is None for value in metric_values(report["metrics"])))
        self.assertIn("corpus_missing", [item["code"] for item in report["gaps"]])
        self.assertEqual(report["productDefaults"]["separation"]["modelName"], "htdemucs")
        self.assertEqual(report["productDefaults"]["lyrics"]["modelName"], "tiny")

    def test_installed_packages_do_not_become_accuracy(self):
        installed = {"installed": True, "version": "9.9.9", "weightsLoaded": False}
        with patch("backend.evaluation.runner.probe_package", return_value=installed):
            report = run_evaluation(None)
        self.assertEqual(report["status"], "not_evaluated")
        self.assertTrue(all(value is None for value in metric_values(report)))
        self.assertEqual(report["scoringEnvironment"]["demucs"]["version"], "9.9.9")
        self.assertFalse(report["scoringEnvironment"]["demucs"]["weightsLoaded"])

    def test_repository_path_is_refused_without_reading_the_fixture(self):
        report = run_evaluation(FIXTURE)
        self.assertEqual(report["status"], "not_evaluated")
        self.assertEqual(report["tracks"], [])
        self.assertIsNone(report["corpusPath"])
        self.assertIn("corpus_inside_repository", [item["code"] for item in report["gaps"]])
        self.assertNotIn(LYRIC_TEXT, json.dumps(report, ensure_ascii=False))
        self.assertTrue(all(value is None for value in metric_values(report["metrics"])))

    def test_synthetic_fixture_outside_the_repo_still_has_no_scores(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._materialize(Path(temporary), synthetic=True)
            with self._forbid_audio_reads():
                report = run_evaluation(root)
        self.assertEqual(report["status"], "not_evaluated")
        self.assertEqual(exit_code(report), 3)
        self.assertEqual(report["tracks"][0]["gold"], "synthetic")
        self.assertTrue(all(value is None for value in metric_values(report)))
        self.assertFalse(contains_key(report, "confidence"))
        self.assertNotIn("0.99", json.dumps(report))
        self.assertNotIn(LYRIC_TEXT, json.dumps(report, ensure_ascii=False))

    def test_non_synthetic_copy_computes_formulas_without_claiming_the_benchmark(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._materialize(Path(temporary), synthetic=False)
            output = Path(temporary) / "report.json"
            with self._forbid_audio_reads(), contextlib.redirect_stdout(io.StringIO()):
                status = main(["--corpus", str(root), "--output", str(output)])
            report = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(status, 4)
        self.assertEqual(report["status"], "incomplete")
        self.assertFalse(report["benchmarkComplete"])
        self.assertIsNone(report["qualityPassed"])
        self.assertFalse(report["accuracyClaim"])
        self.assertFalse(report["thisProcess"]["openedAudio"])
        self.assertFalse(report["projectsRewritten"])
        self.assertFalse(report["mixdownSubstitutedForBass"])
        track = report["tracks"][0]
        self.assertAlmostEqual(track["metrics"]["bpmAndMeasures"]["value"], 0.2)
        self.assertEqual(track["metrics"]["bpmAndMeasures"]["components"]["bpmAbsoluteError"], 60)
        self.assertAlmostEqual(track["metrics"]["sectionBoundaries"]["value"], 0.5)
        self.assertAlmostEqual(track["metrics"]["chordAccuracy"]["value"], 0.5)
        self.assertAlmostEqual(track["metrics"]["lyricTiming"]["value"], 0.2)
        self.assertAlmostEqual(track["metrics"]["singingRecognition"]["value"], 0.125)
        self.assertEqual(track["metrics"]["singingRecognition"]["direction"], "lower")
        self.assertAlmostEqual(track["metrics"]["noteF1"]["value"], 0.4)
        self.assertAlmostEqual(track["metrics"]["bassPitchClass"]["value"], 0.75)
        self.assertAlmostEqual(track["metrics"]["separationListening"]["value"], 3.5)
        self.assertEqual(track["metrics"]["humanCorrectionTime"]["value"], 90)
        self.assertEqual(track["metrics"]["processingTime"]["value"], 24)
        self.assertEqual(sorted(item["code"] for item in report["gaps"]), ["gold_count", "language_coverage", "track_count"])
        self.assertNotIn("threshold", json.dumps(report))
        self.assertNotIn("0.99", json.dumps(report))
        self.assertNotIn(LYRIC_TEXT, json.dumps(report, ensure_ascii=False))
        self.assertFalse(contains_key(report, "confidence"))
        self.assertEqual(report["separationOutcomes"]["completed"], 1)

    def test_failed_separation_does_not_score_bass_from_the_supplied_pitches(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._materialize(Path(temporary), synthetic=False)
            prediction = json.loads((root / "tracks" / "example01" / "prediction.json").read_text(encoding="utf-8"))
            prediction["separation"] = {
                "status": "failed",
                "error": "权重不存在",
                "usedMixdownAsBass": False,
                "stems": {"bass": False, "drums": False, "vocals": False, "other": False},
                "provenance": None,
            }
            prediction["bassPitches"][0]["confidence"] = 0.99
            (root / "tracks" / "example01" / "prediction.json").write_text(
                json.dumps(prediction), encoding="utf-8")
            report = run_evaluation(root)
        bass = report["tracks"][0]["metrics"]["bassPitchClass"]
        notes = report["tracks"][0]["metrics"]["noteF1"]
        self.assertEqual(bass["status"], "not_applicable")
        self.assertEqual(bass["reason"], "separation_failed")
        self.assertIsNone(bass["value"])
        self.assertIsNone(notes["value"])
        self.assertEqual(report["tracks"][0]["separation"]["status"], "failed")
        self.assertFalse(report["tracks"][0]["separation"]["usedMixdownAsBass"])
        self.assertFalse(report["mixdownSubstitutedForBass"])
        self.assertIsNone(report["qualityPassed"])
        self.assertNotEqual(report["status"], "evaluated")
        self.assertEqual(report["separationOutcomes"]["failed"], 1)
        self.assertNotIn("0.99", json.dumps(report))

    def test_mixdown_flag_rejects_the_prediction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._materialize(Path(temporary), synthetic=False)
            prediction = json.loads((root / "tracks" / "example01" / "prediction.json").read_text(encoding="utf-8"))
            prediction["separation"]["usedMixdownAsBass"] = True
            (root / "tracks" / "example01" / "prediction.json").write_text(json.dumps(prediction), encoding="utf-8")
            report = run_evaluation(root)
        self.assertIn("mixdown_rejected", [item["code"] for item in report["gaps"]])
        self.assertTrue(all(value is None for value in metric_values(report["tracks"][0]["metrics"])))
        self.assertIsNone(report["qualityPassed"])
        self.assertFalse(report["mixdownSubstitutedForBass"])

    def test_expired_grant_and_track_mismatch_do_not_score(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self._materialize(Path(temporary), synthetic=False)
            expired = run_evaluation(root, today=date(2028, 1, 1))
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            manifest["authorization"]["coversTrackIds"] = ["other"]
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            mismatch = run_evaluation(root)
        self.assertEqual(expired["status"], "not_evaluated")
        self.assertEqual(expired["tracks"], [])
        self.assertIn("authorization_expired", [item["code"] for item in expired["gaps"]])
        self.assertEqual(mismatch["tracks"], [])
        self.assertIn("authorization_track_mismatch", [item["code"] for item in mismatch["gaps"]])

    def test_schema_dump_is_not_a_measurement_and_repo_output_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            schema_path = Path(temporary) / "schema.json"
            with contextlib.redirect_stdout(io.StringIO()):
                status = main(["--schema", "--output", str(schema_path)])
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertEqual(status, 0)
        self.assertEqual(schema["kind"], "json-schema")
        self.assertFalse(schema["accuracyClaim"])
        self.assertFalse(schema["measured"])
        self.assertIn("manifest", schema["models"])
        self.assertIn("gold", schema["models"])
        refused = Path(__file__).resolve().parents[2] / "eval-report.json"
        with patch("sys.stdout") as stdout:
            code = main(["--output", str(refused)])
        self.assertEqual(code, 3)
        self.assertFalse(refused.exists())
        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        self.assertIn("output_inside_repository", written)
        self.assertIn("not_evaluated", written)

    def _materialize(self, root: Path, synthetic: bool) -> Path:
        target = root / "tracks" / "example01"
        target.mkdir(parents=True)
        source = FIXTURE / "tracks" / "example01"
        for name in ("gold.json", "prediction.json", "listening.json", "human-edit.json"):
            payload = json.loads((source / name).read_text(encoding="utf-8"))
            if name == "gold.json":
                payload["syntheticExample"] = synthetic
            (target / name).write_text(json.dumps(payload), encoding="utf-8")
        audio = target / "audio"
        audio.mkdir()
        (audio / "mix.wav").write_bytes(b"\x00")
        (root / "manifest.json").write_text((FIXTURE / "manifest.json").read_text(encoding="utf-8"), encoding="utf-8")
        return root

    def _forbid_audio_reads(self):
        original = Path.read_text
        original_bytes = Path.read_bytes

        def guarded_text(self, *args, **kwargs):
            if self.suffix.lower() in {".wav", ".mp3", ".flac", ".m4a", ".ogg"}:
                raise AssertionError(f"audio opened: {self}")
            return original(self, *args, **kwargs)

        def guarded_bytes(self, *args, **kwargs):
            if self.suffix.lower() in {".wav", ".mp3", ".flac", ".m4a", ".ogg"}:
                raise AssertionError(f"audio opened: {self}")
            return original_bytes(self, *args, **kwargs)

        return patch.multiple(Path, read_text=guarded_text, read_bytes=guarded_bytes)


if __name__ == "__main__":
    unittest.main()
