"""Trusted Memex Markdown Source Pack. Parse format only; never infer meaning.

The host supplies staged paths, original relative names and importedAt.
config.timeZoneOffset is required because the export has naive wall times.
"""
import hashlib
import json
import posixpath
import re
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

DATE = re.compile(r"# (\d{4}-\d{2}-\d{2})[ \t]*\r?\n")
TIME = re.compile(r"## (\d{2}:\d{2}:\d{2})[ \t]*(?:\r?\n|$)")
IMAGE = re.compile(r"!\[[^\]\r\n]*\]\(([^)\r\n]+)\)")
FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")


def blocks(raw):
    heading = DATE.match(raw)
    if not heading:
        raise ValueError("missing_date_heading")
    datetime.strptime(heading[1], "%Y-%m-%d")
    headings, offset, fence = [], 0, None
    for line in raw.splitlines(keepends=True):
        marker = FENCE.match(line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                if not line[marker.end():].strip():
                    fence = None
        elif marker:
            fence = marker[1]
        else:
            clock = TIME.fullmatch(line)
            if clock:
                headings.append((offset, offset + len(line), clock[1]))
        offset += len(line)
    if not headings or raw[heading.end():headings[0][0]].strip():
        raise ValueError("unmapped_preamble_or_missing_entries")
    seen = {}
    result = []
    for i, (_, start, clock) in enumerate(headings):
        end = headings[i + 1][0] if i + 1 < len(headings) else len(raw)
        local = heading[1] + "T" + clock
        datetime.strptime(local, "%Y-%m-%dT%H:%M:%S")
        seen[clock] = seen.get(clock, 0) + 1
        text = raw[start:end]
        if not text.strip() or len(text.encode("utf-16-le")) // 2 > 100000:
            raise ValueError("empty_or_oversized_entry")
        result.append((local, seen[clock], start, end, text))
    return heading[1], result


def parse(request):
    settings = request.get("config", {})
    offset = settings.get("timeZoneOffset", "")
    if set(settings) != {"timeZoneOffset"} or not re.fullmatch(r"[+-]\d{2}:\d{2}", offset):
        raise ValueError("explicit_time_zone_offset_required")
    hour, minute = map(int, offset[1:].split(":"))
    if hour > 14 or minute > 59 or hour == 14 and minute or offset == "-00:00":
        raise ValueError("invalid_time_zone_offset")
    imported_at = request["importedAt"]
    datetime.fromisoformat(imported_at.replace("Z", "+00:00"))
    inputs = request["inputs"]
    by_name = {item["relativePath"]: item for item in inputs}
    if len(by_name) != len(inputs):
        raise ValueError("duplicate_input_name")
    records, dispositions, warnings, attached = [], {}, [], set()
    for item in inputs:
        name = item["relativePath"]
        parts = PurePosixPath(name).parts
        index = item["index"]
        if "__MACOSX" in parts or parts[-1] == ".DS_Store":
            dispositions[index] = ("excluded", "Operating-system export metadata retained as an original.")
            continue
        if parts[-1] == "README.md":
            dispositions[index] = ("excluded", "Export guide retained as an original; not a dated diary document.")
            continue
        if name.lower().endswith(".zip"):
            dispositions[index] = ("container", "ZIP retained; host-expanded members are accounted for individually.")
            continue
        if not name.endswith(".md"):
            continue
        try:
            raw = Path(item["path"]).read_bytes().decode("utf-8")
            day, entries = blocks(raw)
            if PurePosixPath(name).stem != day:
                raise ValueError("path_date_mismatch")
        except (UnicodeError, ValueError) as error:
            dispositions[index] = ("unsupported", "The document does not match the declared dated Markdown format.")
            warnings.append("Input %d was not parsed: %s" % (index, type(error).__name__))
            continue
        dispositions[index] = ("parsed", "Exact timestamped Markdown blocks; no semantic classification.")
        for local, occurrence, start, end, text in entries:
            attachment_indexes, attachment_hashes = [], []
            # Links remain in the exact original text; names only resolve within staged inputs.
            for target in IMAGE.findall(text):
                url = urlsplit(target)
                path = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(url.path)))
                match = by_name.get(path) if not (url.scheme or url.netloc or url.query or url.fragment) else None
                if not match or PurePosixPath(path).suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                    warnings.append("An image reference in input %d could not be resolved to an included image." % index)
                    continue
                attached.add(match["index"])
                if match["index"] not in attachment_indexes:
                    attachment_indexes.append(match["index"])
                    attachment_hashes.append(hashlib.sha256(Path(match["path"]).read_bytes()).hexdigest())
            identity = "%s#%s/%s" % (name, local, occurrence)
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            records.append({
                "item": {
                    "externalId": "memex:" + hashlib.sha256(identity.encode("utf-8")).hexdigest(),
                    "revision": hashlib.sha256(json.dumps([local, offset, text, attachment_hashes], ensure_ascii=False).encode("utf-8")).hexdigest(),
                    "observedAt": imported_at, "kind": "file", "layer": "original",
                    "mimeType": "text/markdown", "title": local.replace("T", " "), "text": text,
                    "document": {
                        "recordedAt": local + offset, "timeBasis": "recorded", "contentRole": "authored",
                        "originalMetadata": {
                            "parser": "memex-markdown@1", "sourceLocalTime": local,
                            "timeZoneOffset": offset, "timeZoneBasis": "parser_configuration",
                            "sourceSlice": {"unit": "unicode_code_points", "start": start, "end": end, "sha256": digest},
                        },
                    },
                },
                "evidenceIndexes": [index], "attachmentIndexes": attachment_indexes,
            })
    for item in inputs:
        index = item["index"]
        if index not in dispositions:
            dispositions[index] = ("attachment", "Referenced original image.") if index in attached else (
                "unsupported", "No declared mapping; original retained for review.")
    warnings = list(dict.fromkeys(warnings))
    complete = bool(records) and not warnings and all(role not in ("unsupported", "excluded") for role, _ in dispositions.values())
    if len(records) > 1000 or len(warnings) > 200:
        raise ValueError("output_limit")
    return {
        "summary": "Parsed %d timestamped entries with %d linked images. Original text is unchanged; times use the explicitly configured offset." % (len(records), len(attached)),
        "warnings": warnings,
        "reviewDecision": {
            "confidence": "high" if complete else "low", "ambiguous": not complete,
            "reason": "All inputs have exact structural mappings." if complete else "Review unresolved references, unsupported files or excluded system metadata before publishing.",
        },
        "dispositions": [{"index": index, "status": status, "reason": reason} for index, (status, reason) in sorted(dispositions.items())],
        "records": records,
    }


if __name__ == "__main__":
    print(json.dumps(parse(json.loads(Path("request.json").read_text(encoding="utf-8"))), ensure_ascii=False))
