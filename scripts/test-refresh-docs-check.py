#!/usr/bin/env python3
"""Offline regressions: a stable index must not hide a changed payment contract."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("freshness", Path(__file__).with_name("refresh-docs-check.py"))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
INDEX = b"# Docs\n- [POS](https://developer.peachpayments.com/docs/pos-integrations-api.md)\n"
BODY = b"# Payment\nAmount is decimal major units.\n"
URL = "https://developer.peachpayments.com/docs/pos-integrations-api.md"


class FreshnessTests(unittest.TestCase):
    def source(self, body=BODY, kind="markdown", url=URL):
        return {"url": url, "kind": kind, "sha256": f.digest(body, kind)}

    def test_body_change_detected_despite_unchanged_index(self):
        index = f.inspect_source(self.source(INDEX, "index", f.INDEX_URL), lambda _: INDEX)
        body = f.inspect_source(self.source(), lambda _: b"# Payment\nAmount is cents.\n")
        self.assertEqual(index[0], "same")
        code, output = f.summarize([index, body], "tracked bodies + index")
        self.assertEqual(code, 1)
        self.assertIn("DOCS-FRESHNESS: DRIFT", output)

    def test_readme_metadata_does_not_hide_body_changes(self):
        wrapped = b"---\nupdatedAt: today\nagentTools:\n  projectIndex: ignored\n---\n\n" + BODY
        self.assertEqual(f.digest(BODY, "markdown"), f.digest(wrapped, "markdown"))
        self.assertNotEqual(f.digest(BODY, "markdown"), f.digest(wrapped.replace(b"major", b"minor"), "markdown"))

    def test_playground_only_normalizes_generated_example_values(self):
        old = b'# Example\n{"accepted_at": "2026-09-08T17:01:45.138Z", "id": "cus_new_user_abc123", "amount": 100}'
        new = old.replace(b'2026-09-08T17:01:45.138Z', b'2026-10-07T09:36:09.956Z').replace(b'abc123', b'xyz987')
        self.assertEqual(f.digest(old, "playground"), f.digest(new, "playground"))
        self.assertNotEqual(f.digest(old, "playground"), f.digest(new.replace(b'100', b'10000'), "playground"))
        self.assertNotEqual(f.digest(old, "markdown"), f.digest(new, "markdown"))

    def test_index_membership_not_readme_formatting(self):
        restyled = INDEX.replace(b"- [POS]", b"  - [POS API]") + b"\n"
        self.assertEqual(f.digest(INDEX, "index"), f.digest(restyled, "index"))
        changed = INDEX + b"- [New](https://developer.peachpayments.com/docs/new.md)\n"
        self.assertNotEqual(f.digest(INDEX, "index"), f.digest(changed, "index"))

    def test_unknown_for_html_and_empty_responses(self):
        for body in [b"", b"<!DOCTYPE html><html>404 fallback</html>", b"---\nupdatedAt: now\n---\n"]:
            with self.subTest(body=body):
                result = f.inspect_source(self.source(), lambda _: body)
                self.assertEqual(result[0], "unknown")

    def test_missing_baseline_never_becomes_ok(self):
        source = self.source()
        source["sha256"] = None
        result = f.inspect_source(source, lambda _: BODY)
        self.assertEqual(result[0], "unknown")
        self.assertEqual(f.summarize([result], "test")[0], 0)
        self.assertIsNone(source["sha256"])

    def test_unreachable_source_is_fail_open_but_not_ok(self):
        def offline(_):
            raise OSError("offline")
        result = f.inspect_source(self.source(), offline)
        code, output = f.summarize([result], "test")
        self.assertEqual(code, 0)
        self.assertIn("DOCS-FRESHNESS: UNKNOWN", output)

    def test_partial_failure_cannot_mask_known_drift(self):
        self.assertEqual(f.summarize([("changed", URL, "abc"), ("unknown", f.INDEX_URL, "offline")], "test")[0], 1)

    def test_normal_checks_do_not_write_any_baseline(self):
        data = {"sources": [self.source(INDEX, "index", f.INDEX_URL)]}
        original = json.dumps(data)
        with patch.object(f, "load_baseline", return_value=data), patch.object(f, "inspect_source", return_value=("same", f.INDEX_URL, "hash")), patch.object(Path, "write_text", side_effect=AssertionError("unexpected write")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(f.main([]), 0)
        self.assertEqual(json.dumps(data), original)

    def test_missing_manifest_fail_open_without_creating_it(self):
        with patch.object(f, "load_baseline", side_effect=FileNotFoundError()), patch.object(Path, "write_text", side_effect=AssertionError("unexpected write")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(f.main([]), 0)
        self.assertIn("UNKNOWN", output.getvalue())

    def test_accept_requires_review_details(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            f.main(["--accept", URL])
        self.assertEqual(caught.exception.code, 2)

    def test_accept_uses_reviewed_local_bytes_not_live_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "reviewed.md"
            source_path.write_bytes(BODY)
            with patch.object(f, "fetch", side_effect=AssertionError("unexpected fetch")):
                data = f.accept({"sources": [self.source(b"# Old")]}, URL, source_path, "Reviewed amount contract", "2026-10-07")
            self.assertEqual(data["sources"][0]["sha256"], f.digest(BODY, "markdown"))
            self.assertEqual(data["sources"][0]["baseline_date"], "2026-10-07")

    def test_invalid_manifest_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text(json.dumps({"schema_version": 1, "sources": [self.source(url="http://localhost/private")]}))
            with self.assertRaises(ValueError):
                f.load_baseline(path)

    def test_offline_validation_reads_real_manifest_without_network_or_writes(self):
        with patch.object(f, "fetch", side_effect=AssertionError("unexpected fetch")), patch.object(Path, "write_text", side_effect=AssertionError("unexpected write")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(f.main(["--validate-baseline"]), 0)
        self.assertIn("DOCS-BASELINE: VALID", output.getvalue())

    def test_offline_validation_rejects_missing_or_malformed_manifest(self):
        for error in [FileNotFoundError(), ValueError("invalid schema"), KeyError("sources"), TypeError("invalid source type")]:
            with self.subTest(error=type(error).__name__), patch.object(f, "load_baseline", side_effect=error), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(f.main(["--validate-baseline"]), 2)
            self.assertIn("UNKNOWN", output.getvalue())

    def test_offline_validation_cannot_fetch_or_accept(self):
        for args in [["--validate-baseline", "--deep"], ["--validate-baseline", "--accept", URL]]:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                f.main(args)
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
