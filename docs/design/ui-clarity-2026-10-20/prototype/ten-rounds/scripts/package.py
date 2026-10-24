#!/usr/bin/env python3
"""Verify and package every frozen round, evaluation, and UI deliverable."""
from __future__ import annotations

import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SURFACES = ("web", "mac", "android")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_rounds() -> list[dict]:
    output = []
    for number in range(20, 30):
        directory = ROOT / "rounds" / f"r{number}"
        manifest = json.loads((directory / "manifest.json").read_text())
        report = json.loads((directory / "reports/independent-evaluation.json").read_text())
        for surface in SURFACES:
            expected = manifest["candidates"][surface]["sha256"]
            actual = digest(directory / f"{surface}.html")
            if actual != expected:
                raise SystemExit(f"Frozen candidate was modified: R{number} {surface}")
            assessed = report.get("candidate_sha256", {}).get(surface) or report.get("platforms", {}).get(surface, {}).get("candidate_sha256")
            if assessed != actual:
                raise SystemExit(f"Independent report candidate identity mismatch: R{number} {surface}")
        for name, item in manifest["sources"].items():
            if digest(directory / item["path"]) != item["sha256"]:
                raise SystemExit(f"Frozen source was modified: R{number} {name}")
        output.append({"round": number, "candidates": {s: manifest["candidates"][s]["sha256"] for s in SURFACES}, "evaluation_sha256": digest(directory / "reports/independent-evaluation.json")})
    return output


def included(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    if path.is_symlink() or not path.is_file():
        return False
    if any(part in {".git", "__pycache__", "node_modules", "delivery", "tmp"} or part.startswith(".r") for part in relative.parts):
        return False
    if path.suffix == ".zip":
        return path.name.endswith("trace.zip") and relative.parts[0] in {"reports", "rounds"}
    if path.suffix in {".pyc", ".tmp"}:
        return False
    if str(relative) in {"artifact-manifest.json", "delivery-checksums.txt", "delivery-result.json"}:
        return False
    return True


def main() -> None:
    rounds = verify_rounds()
    for required in ("README.md", "final-report.md", "dist/mote-three-platforms.html", "dist/mote-rounds-gallery.html"):
        if not (ROOT / required).exists():
            raise SystemExit("Missing delivery file: " + required)
    paths = sorted(p for p in ROOT.rglob("*") if included(p))
    entries = [{"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size, "sha256": digest(p)} for p in paths]
    manifest = {"schema": "mote-ten-rounds-delivery-v1", "packaged_at_utc": datetime.now(timezone.utc).isoformat(), "round_count": 10,
                "candidate_count": 30, "independent_evaluation_count": 10, "verified_rounds": rounds, "files": entries,
                "scope": "HTML UI simulations and their evaluation evidence; synthetic data. Native runtimes and live service execution are outside this artifact."}
    manifest_path = ROOT / "artifact-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    checksums = ROOT / "delivery-checksums.txt"
    checksums.write_text("\n".join(item["sha256"] + "  " + item["path"] for item in entries) + "\n")
    archive = ROOT / "dist/mote-ui-r20-r29-evidence.zip"
    temporary = archive.with_suffix(".zip.tmp")
    prefix = "mote-ui-r20-r29/"
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for path in paths + [manifest_path, checksums]:
            output.write(path, prefix + str(path.relative_to(ROOT)))
    with zipfile.ZipFile(temporary) as check:
        failed = check.testzip()
        if failed:
            raise SystemExit("Archive CRC failure: " + failed)
        count = len(check.infolist())
    temporary.replace(archive)
    result = {"archive": str(archive.relative_to(ROOT)), "bytes": archive.stat().st_size, "sha256": digest(archive), "archive_entries": count,
              "rounds": 10, "candidates": 30, "independent_evaluations": 10, "scope": "Local downloadable archive; publish readable files separately to GitHub."}
    (ROOT / "delivery-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
