#!/usr/bin/env python3
"""Detect source drift, not correctness. No credentials, transactions, or implicit writes."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

BASELINE = Path(__file__).with_name("docs-baseline.json")
INDEX_URL = "https://developer.peachpayments.com/llms.txt"
MAX_SOURCES = 48


def normalize(body, kind):
    text = body.decode("utf-8").replace("\r\n", "\n")
    if not text.strip() or re.search(r"<!doctype html|<html\b", text[:1000], re.I):
        raise ValueError("empty response or HTML fallback, expected source text")
    if kind == "index":
        # ReadMe changes indentation and summaries independently of source pages.
        urls = sorted(set(re.findall(r"^\s*- \[[^\]\n]*\]\((https://[^)\s]+)\)", text, re.M)))
        if not urls:
            raise ValueError("documentation index has no page links")
        return "\n".join(urls)
    if kind == "json":
        return json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))
    if kind not in ("markdown", "playground"):
        raise ValueError("unknown normalization kind")
    # Only discard generated ReadMe metadata and its exact boilerplate prefix.
    # All headings, tables, examples and other body text remain part of the hash.
    text = re.sub(r"\A---\n.*?\n---\n", "", text, count=1, flags=re.S)
    text = re.sub(r"^Fetch the complete documentation index at: https://developer\.peachpayments\.com/llms\.txt\..*\n", "", text, flags=re.M)
    if not text.strip():
        raise ValueError("empty document body")
    if kind == "playground":
        # The public llms-full document regenerates these two example values on
        # every request. Only these fixture-shaped values are normalized.
        text = re.sub(r'("accepted_at": ")\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(")', r'\1<generated-example-time>\2', text)
        text = re.sub(r'("id": "cus_new_user_)[a-z0-9]+(")', r'\1<generated-example-id>\2', text)
    return text.strip()


def digest(body, kind):
    return hashlib.sha256(normalize(body, kind).encode()).hexdigest()


def load_baseline(path=BASELINE):
    data = json.loads(path.read_text())
    sources = data["sources"]
    if data.get("schema_version") != 1 or not isinstance(sources, list) or not 1 <= len(sources) <= MAX_SOURCES:
        raise ValueError("invalid baseline schema or source count")
    seen = set()
    for source in sources:
        url = source["url"]
        if not re.fullmatch(r"https://(?:developer|playground)\.peachpayments\.com/[A-Za-z0-9_./-]+", url):
            raise ValueError("baseline contains a URL outside the public docs")
        if url in seen or source["kind"] not in ("index", "markdown", "playground", "json"):
            raise ValueError("duplicate URL or invalid source kind")
        seen.add(url)
        sha = source.get("sha256")
        if sha is not None and not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ValueError("invalid baseline hash")
    if INDEX_URL not in seen:
        raise ValueError("baseline is missing the index")
    return data


def fetch(url):
    # curl bounds the entire transfer including DNS/redirects. subprocess timeout
    # is a second ceiling, unlike a socket timeout that resets on every read.
    result = subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3",
        "--connect-timeout", "3", "--max-time", "8", "--max-filesize", "8000000", url,
    ], capture_output=True, timeout=9, check=False)
    if result.returncode:
        raise ValueError("fetch failed (curl %s)" % result.returncode)
    return result.stdout


def inspect_source(source, fetcher=fetch):
    try:
        sha = digest(fetcher(source["url"]), source["kind"])
        if source.get("sha256") is None:
            return "unknown", source["url"], "no reviewed baseline"
        return ("same" if sha == source["sha256"] else "changed"), source["url"], sha
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return "unknown", source["url"], str(error)


def summarize(results, scope):
    changed = [r for r in results if r[0] == "changed"]
    unknown = [r for r in results if r[0] == "unknown"]
    state = "DRIFT" if changed else "UNKNOWN" if unknown else "OK"
    lines = ["DOCS-FRESHNESS: %s (%s; %d changed, %d unavailable/unbaselined, %d checked)" % (
        state, scope, len(changed), len(unknown), len(results))]
    for _, url, _ in changed:
        lines.append("  CHANGED " + url)
    for _, url, reason in unknown:
        lines.append("  UNKNOWN %s: %s" % (url, reason))
    lines.append("  Scope: unchanged hashes do not verify facts, sandbox behavior, or untracked pages.")
    if scope == "index only":
        lines.append("  Run --deep for tracked page bodies, including POS pages missing from the index.")
    if changed:
        lines.append("  Review source changes and update affected references before explicit --accept; checks never advance the baseline.")
    return (1 if changed else 0), "\n".join(lines)


def accept(data, url, source_file, note, reviewed_on):
    # Accept exactly the locally reviewed bytes, never a second live fetch that
    # might have changed since review. The output target is fixed inside scripts/.
    datetime.date.fromisoformat(reviewed_on)
    source = next((s for s in data["sources"] if s["url"] == url), None)
    if source is None:
        raise ValueError("URL is not tracked; add a manifest entry before reviewing it")
    sha = digest(Path(source_file).read_bytes(), source["kind"])
    source.update(sha256=sha, baseline_date=reviewed_on, review_note=note)
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Default: one index GET. --deep: at most 48 sources, 8 workers, "
        "9 seconds per transfer (54 seconds worst case). Requires Python 3 and curl. "
        "Review: save the changed source, inspect its diff, update affected references, "
        "then --accept URL --from-file FILE --review-note TEXT --reviewed-on YYYY-MM-DD. "
        "No automatic baseline; legacy .last-llms-hash is ignored."))
    parser.add_argument("--deep", action="store_true", help="also compare tracked source bodies")
    parser.add_argument("--validate-baseline", action="store_true", help="validate the shipped manifest offline; exit 2 if missing or invalid")
    parser.add_argument("--accept", metavar="URL", help="explicitly accept one reviewed tracked source")
    parser.add_argument("--from-file", help="local bytes that were actually reviewed")
    parser.add_argument("--review-note", help="what changed and which references were updated")
    parser.add_argument("--reviewed-on", help="review date in YYYY-MM-DD")
    args = parser.parse_args(argv)
    if args.validate_baseline and (args.deep or args.accept):
        parser.error("--validate-baseline cannot be combined with --deep or --accept")
    if args.accept and (args.deep or not all((args.from_file, args.review_note, args.reviewed_on))):
        parser.error("--accept requires --from-file, --review-note and --reviewed-on; do not use --deep")
    if not args.accept and any((args.from_file, args.review_note, args.reviewed_on)):
        parser.error("review arguments require --accept")
    try:
        data = load_baseline()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("DOCS-FRESHNESS: UNKNOWN (baseline unavailable/invalid: %s)" % error)
        return 2 if args.accept or args.validate_baseline else 0
    if args.validate_baseline:
        print("DOCS-BASELINE: VALID (%d tracked sources; offline schema check only)" % len(data["sources"]))
        return 0
    if args.accept:
        try:
            updated = accept(data, args.accept, args.from_file, args.review_note, args.reviewed_on)
            BASELINE.write_text(json.dumps(updated, indent=2) + "\n")
        except (OSError, ValueError) as error:
            parser.error(str(error))
        print("DOCS-BASELINE: ACCEPTED " + args.accept)
        return 0
    sources = data["sources"] if args.deep else [s for s in data["sources"] if s["url"] == INDEX_URL]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(inspect_source, sources))
    code, output = summarize(results, "tracked bodies + index" if args.deep else "index only")
    print(output)
    return code


if __name__ == "__main__":
    sys.exit(main())
