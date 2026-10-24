#!/usr/bin/env python3
"""Package the 30 HTML candidates and readable review documents, without bulky evidence."""
from __future__ import annotations

import importlib.util
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mote_full_package", Path(__file__).with_name("package.py"))
full = importlib.util.module_from_spec(spec)
spec.loader.exec_module(full)


def main() -> None:
    rounds = full.verify_rounds()
    gallery = json.loads((ROOT / "dist/gallery-manifest.json").read_text())
    if gallery["rounds"] != 10 or gallery["candidates"] != 30 or gallery.get("build_status", {}).get("partial"):
        raise SystemExit("Light review package requires the final ten-round gallery")
    paths = set()
    required = ["final-report.md", "rubric-independent.md", "rubric-independent.json", "iteration-plan.md", "round-commits.json",
                "reports/scores-evidence-summary.json", "reports/scores-evidence-summary.md",
                "dist/mote-rounds-gallery.html", "dist/mote-rounds-portable.html", "dist/mote-three-platforms.html", "dist/gallery-manifest.json",
                "reports/fresh-android-r20/report.md", "reports/fresh-web-r22/report.md",
                "reports/fresh-mac-r23/report.md", "reports/fresh-android-advanced-r25/report.md",
                "reports/final-reachability/index.json",
                "rounds/r29/author/native-checks/platform-delivery-summary.md", "rounds/r29/author/native-checks/result.json"]
    for surface in ("web", "mac", "android"):
        required.append(f"dist/mote-{surface}-final.html")
        required.append(f"reports/final-reachability/{surface}/feature-reachability.json")
    for relative in required:
        path = ROOT / relative
        if not path.is_file():
            raise SystemExit("Required review artifact missing: " + relative)
        paths.add(path)
    for number in range(20, 30):
        directory = ROOT / "rounds" / f"r{number}"
        for name in ("web.html", "mac.html", "android.html", "manifest.json", "changes.json", "rubric-independent.md", "rubric-independent.json", "reports/independent-evaluation.json", "reports/independent-evaluation.md"):
            path = directory / name
            if path.is_file():
                paths.add(path)
        paths.update(p for p in (directory / "src").rglob("*") if p.is_file() and not p.is_symlink())
    paths.update(p for p in (ROOT / "context").rglob("*") if p.is_file() and not p.is_symlink())
    entries = [{"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size, "sha256": full.digest(p)} for p in sorted(paths)]
    manifest = {"schema": "mote-ten-rounds-light-review-v1", "created_at_utc": datetime.now(timezone.utc).isoformat(), "rounds": 10, "candidates": 30,
                "scope": "HTML candidates, frozen sources, scores and readable reports. Screenshots, DOM/action evidence and browser traces are in the full evidence package.",
                "verified_rounds": rounds, "files": entries}
    (ROOT / "review-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    table = "\n".join(f"| R{n} | [Web](rounds/r{n}/web.html) | [Mac](rounds/r{n}/mac.html) | [Android](rounds/r{n}/android.html) | [独立评估](rounds/r{n}/reports/independent-evaluation.md) |" for n in range(20, 30))
    readme = (
        "# Mote 三端 UI：R20–R29 轻量评审包\n\n"
        "这个包保存十轮的 30 个 HTML 候选、冻结源码、修改原因、评分规则、独立报告和功能基线。截图、可见 DOM、完整操作记录与浏览器追踪收录在完整证据包 `mote-ui-r20-r29-evidence.zip` 中。\n\n"
        "## 打开效果\n\n"
        "- [最终三个端并排查看](dist/mote-three-platforms.html)\n"
        "- [十轮候选查看器](dist/mote-rounds-gallery.html)\n"
        "- [十轮便携查看器](dist/mote-rounds-portable.html)\n"
        "- [最终报告](final-report.md)\n"
        "- [评分与证据汇总](reports/scores-evidence-summary.md)\n"
        "- [评估指标](rubric-independent.md)\n"
        "- [功能与旅程基线](context/feature-inventory.md)\n"
        "- [78 项功能清单](context/feature-manifest.json)\n"
        "- [HTML 设计提案与现有能力的差异](context/known-proposal-gaps.md)\n\n"
        "各报告中的截图、可见 DOM、操作记录和浏览器追踪链接仅在完整证据包中提供。本包保留目录检查结果、三端作者总结和四次新上下文复核的文字报告。\n\n"
        "解压后保持目录结构，直接用浏览器打开 HTML。每轮、每端的演示状态分别保存。\n\n"
        "| 轮次 | Web | Mac | Android | 报告 |\n| --- | --- | --- | --- | --- |\n" + table + "\n\n"
        "文件校验清单见 [review-manifest.json](review-manifest.json)。\n"
    )
    archive = ROOT / "dist/mote-ui-r20-r29-review.zip"
    temporary = archive.with_suffix(".zip.tmp")
    prefix = "mote-ui-r20-r29-review/"
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path in sorted(paths):
            output.write(path, prefix + str(path.relative_to(ROOT)))
        output.writestr(prefix + "README.md", readme)
        output.write(ROOT / "review-manifest.json", prefix + "review-manifest.json")
    with zipfile.ZipFile(temporary) as check:
        failed = check.testzip()
        if failed:
            raise SystemExit("Light review archive CRC failure: " + failed)
        archive_entries = len(check.infolist())
    temporary.replace(archive)
    result = {"archive": str(archive.relative_to(ROOT)), "bytes": archive.stat().st_size, "sha256": full.digest(archive), "archive_entries": archive_entries,
              "rounds": 10, "candidates": 30, "scope": "Lightweight local downloadable HTML/review archive; no screenshot or trace files."}
    (ROOT / "review-delivery-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
