#!/usr/bin/env python3
"""Freeze one three-surface Mote UI candidate without overwriting history."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT.parent / "continuation/dist/r19.html"
BASELINE_SHA = "8cabb1d2c2914170a5b00dad56a7814bbb21e28fead38ecb59f894658cbcb7bf"
SOURCES = ("common.css", "platform.css", "common.js", "platform.js")
SURFACES = ("web", "mac", "android")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_html(base: str, sources: dict[str, bytes], round_number: int, surface: str) -> bytes:
    html = base.replace("const REV = 19;", f"const REV = {round_number};", 1)
    parameter_line = "const parameters = new URLSearchParams(location.search);"
    if html.count(parameter_line) != 1:
        raise ValueError("Expected one baseline parameter declaration")
    parameter_setup = (
        parameter_line
        + f"\nparameters.set('surface', {json.dumps(surface)});"
        + "\nif (!parameters.has('state')) parameters.set('state', 'empty');"
    )
    html = html.replace(parameter_line, parameter_setup, 1)
    html = html.replace("'mote-prototype-'+REV", "'mote-prototype-'+REV+'-" + surface + "'")
    html = html.replace("'mote-prototype-accounts-'+REV", "'mote-prototype-accounts-'+REV+'-" + surface + "'")
    tail = "render();\n</script>"
    tail_at = html.rfind(tail)
    if tail_at < 0:
        raise ValueError("Expected final baseline render call")
    html = html[:tail_at] + "/* Initial render is owned by the iteration initializer. */\n</script>" + html[tail_at + len(tail):]
    css = "\n".join(sources[name].decode("utf-8") for name in ("common.css", "platform.css"))
    html = html.replace("</head>", '<style data-iteration-style="true">\n' + css + "\n</style>\n</head>", 1)
    config = (
        '<script data-iteration-config="true">'
        f"window.MOTE_ROUND={round_number};window.MOTE_SURFACE={json.dumps(surface)};"
        "</script>\n"
    )
    html = html.replace("<script>\n'use strict';", config + "<script>\n'use strict';", 1)
    extra = "\n<script>state.surface=window.MOTE_SURFACE;</script>\n"
    for name in ("common.js", "platform.js"):
        js = sources[name].decode("utf-8")
        if re.search(r"</script\s*>", js, re.IGNORECASE):
            raise ValueError(f"Unsafe inline script terminator in {name}")
        extra += f'<script data-iteration-layer="{name}">\n{js}\n</script>\n'
    extra += (
        '<script data-iteration-start="true">\n'
        "document.documentElement.dataset.round=String(window.MOTE_ROUND);\n"
        "document.documentElement.dataset.surface=window.MOTE_SURFACE;\n"
        "if(typeof window.initializeMoteIteration==='function') window.initializeMoteIteration();\n"
        "else {render();if(typeof window.enhancePlatformUI==='function')window.enhancePlatformUI();}\n"
        "</script>\n"
    )
    html = html.replace("</body>", extra + "</body>", 1)
    html = re.sub(r"<title>.*?</title>", f"<title>Mote · {surface.title()} · R{round_number}</title>", html, count=1, flags=re.S)
    return html.encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round", type=int, required=True, dest="round_number")
    parser.add_argument("--changes", required=True, type=Path, help="JSON object describing this candidate's changes and triggering feedback")
    args = parser.parse_args()
    if not 20 <= args.round_number <= 29:
        parser.error("round must be from 20 through 29")
    change_path = args.changes.resolve()
    change_bytes = change_path.read_bytes()
    changes = json.loads(change_bytes)
    if not isinstance(changes, dict):
        parser.error("change request must be a JSON object")
    target = ROOT / "rounds" / f"r{args.round_number}"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise SystemExit(f"REFUSED: {target} already exists; frozen candidates cannot be overwritten.")
    base_bytes = BASELINE.read_bytes()
    if sha256(base_bytes) != BASELINE_SHA:
        raise SystemExit("REFUSED: frozen R19 baseline checksum changed")
    source_bytes = {name: (ROOT / "src" / name).read_bytes() for name in SOURCES}
    staging = Path(tempfile.mkdtemp(prefix=f".r{args.round_number}-", dir=target.parent))
    try:
        (staging / "src").mkdir()
        for name, content in source_bytes.items():
            (staging / "src" / name).write_bytes(content)
        (staging / "changes.json").write_bytes(change_bytes)
        for name in ("rubric-independent.md", "rubric-independent.json"):
            if (ROOT / name).exists():
                (staging / name).write_bytes((ROOT / name).read_bytes())
        candidates = {}
        for surface in SURFACES:
            content = build_html(base_bytes.decode("utf-8"), source_bytes, args.round_number, surface)
            (staging / f"{surface}.html").write_bytes(content)
            candidates[surface] = {"path": f"{surface}.html", "bytes": len(content), "sha256": sha256(content), "default_state": "empty", "default_surface": surface}
        manifest = {
            "schema": "mote-three-surface-round-v1",
            "round": args.round_number,
            "frozen_at_utc": datetime.now(timezone.utc).isoformat(),
            "baseline": {"path": "../../../continuation/dist/r19.html", "bytes": len(base_bytes), "sha256": BASELINE_SHA},
            "candidates": candidates,
            "sources": {name: {"path": "src/" + name, "bytes": len(content), "sha256": sha256(content)} for name, content in source_bytes.items()},
            "change_request": {"path": "changes.json", "sha256": sha256(change_bytes)},
            "evaluation": "Independent evaluations are appended under evidence/ and reports/; these candidate files remain frozen.",
            "scope": "Self-contained HTML UI simulations with synthetic data. Web, Mac, and Android have isolated round/platform session storage.",
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        if target.exists():
            raise RuntimeError("Round appeared while building; preserving it")
        os.rename(staging, target)
        print(json.dumps({"round": args.round_number, "directory": str(target), "candidates": candidates}, ensure_ascii=False))
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == "__main__":
    main()
