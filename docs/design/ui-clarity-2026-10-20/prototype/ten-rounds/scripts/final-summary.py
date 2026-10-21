#!/usr/bin/env python3
"""Summarize recorded round scores and evidence without generating new ratings."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SURFACES = ("web", "mac", "android")
LABELS = {"web": "Web", "mac": "Mac", "android": "Android"}
NEWCOMER = ("purpose", "first_action", "permissions_setup", "first_value_verify", "progressive_disclosure")
EXPECTED_ROUNDS = tuple(range(20, 30))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def display(value: float | int | None) -> str:
    if value is None:
        return "未记录"
    return str(Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def numeric(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def require_equal(actual: float, expected: float, context: str) -> None:
    if not math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError(f"Recorded arithmetic mismatch: {context}: {actual} versus {expected}")


def load_actions(path: Path) -> list[dict]:
    content = json.loads(path.read_text())
    if isinstance(content, list):
        records = content
    elif isinstance(content, dict) and isinstance(content.get("actions"), list):
        records = content["actions"]
    else:
        raise ValueError("Unknown action-record schema: " + str(path))
    if not all(isinstance(record, dict) and "action" in record for record in records):
        raise ValueError("Missing action description in: " + str(path))
    return records


def checked_path(directory: Path, relative: str) -> Path:
    path = (directory / relative).resolve()
    if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
        raise ValueError("Missing or out-of-scope evidence reference: " + str(path))
    return path


def gate_cell(value: object) -> str:
    return {True: "通过", False: "未通过", "pass": "通过", "fail": "未通过", "not_verified": "未验证"}.get(value, str(value))


def fresh_review_inventory() -> list[dict]:
    reviews = []
    for folder in sorted((ROOT / "reports").glob("fresh*")):
        if not folder.is_dir():
            continue
        first_look = sorted(p for p in folder.glob("first-look.*") if p.is_file())
        action_files = []
        for name in ("actions.json", "actions.jsonl", "action-log.json", "rawtrace.json", "actions.md"):
            path = folder / name
            if not path.is_file():
                continue
            item = {"path": str(path.relative_to(ROOT)), "bytes": path.stat().st_size, "sha256": sha256(path)}
            if path.suffix == ".jsonl":
                item["serialized_record_entries"] = len([line for line in path.read_text().splitlines() if line.strip()])
            elif path.suffix == ".json":
                data = json.loads(path.read_text())
                if isinstance(data, list):
                    item["serialized_record_entries"] = len(data)
                elif isinstance(data, dict):
                    item["top_level_keys"] = list(data)
            action_files.append(item)
        traces = [{"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size, "sha256": sha256(p)} for p in sorted(folder.glob("*trace.zip"))]
        report = folder / "report.md"
        reviews.append({"name": folder.name, "report": str(report.relative_to(ROOT)) if report.exists() else None,
                        "first_look_files": [str(p.relative_to(ROOT)) for p in first_look], "action_artifacts": action_files,
                        "png_file_count": sum(1 for p in folder.rglob("*.png") if p.is_file()), "trace_archives": traces,
                        "scope": "Separate fresh-context review inventory; serialization and screenshot-file counts are retained as file counts."})
    return reviews


def read_round(number: int, rubric_weights: dict[str, float]) -> dict:
    folder = ROOT / "rounds" / f"r{number}"
    manifest_path = folder / "manifest.json"
    report_path = folder / "reports/independent-evaluation.json"
    manifest = json.loads(manifest_path.read_text())
    report = json.loads(report_path.read_text())
    if report["weights"] != rubric_weights:
        raise ValueError(f"Rubric weights differ in R{number}")
    if sum(report["weights"].values()) != 100:
        raise ValueError(f"Weight sum is not 100 in R{number}")
    output = {
        "round": number,
        "report": str(report_path.relative_to(ROOT)),
        "report_sha256": sha256(report_path),
        "manifest": str(manifest_path.relative_to(ROOT)),
        "manifest_sha256": sha256(manifest_path),
        "frozen_at_utc": manifest["frozen_at_utc"],
        "evaluation_started_at_utc": report.get("started_at_utc"),
        "evaluation_finished_at_utc": report.get("finished_at_utc"),
        "scope": report.get("scope"),
        "overall_gate_reported": report["critical_gate"],
        "platforms": {},
        "findings": report.get("findings", []),
        "resolved_from_previous": report.get("resolved_from_previous", []),
        "next_priority": report.get("next_priority", []),
    }
    for surface in SURFACES:
        item = report["platforms"][surface]
        digest = sha256(folder / f"{surface}.html")
        if manifest["candidates"][surface]["sha256"] != digest or report["candidate_sha256"][surface] != digest or item["candidate_sha256"] != digest:
            raise ValueError(f"Candidate identity mismatch: R{number} {surface}")
        dimensions = item["dimension_scores"]
        subscores = item["newcomer_subscores"]
        if not all(numeric(dimensions.get(key)) and 0 <= dimensions[key] <= 4 for key in rubric_weights):
            raise ValueError(f"Incomplete dimension scores in R{number} {surface}")
        if not all(numeric(subscores.get(key)) and 0 <= subscores[key] <= 4 for key in NEWCOMER):
            raise ValueError(f"Incomplete newcomer subscores in R{number} {surface}")
        calculated = sum(rubric_weights[key] * dimensions[key] / 4 for key in rubric_weights)
        require_equal(calculated, item["weighted_total"], f"R{number} {surface} weighted score")
        require_equal(sum(subscores[key] for key in NEWCOMER) / 5, dimensions["new_user_friendliness"], f"R{number} {surface} newcomer mean")
        actions_path = checked_path(folder, item["actions_file"])
        actions = load_actions(actions_path)
        if "actual_action_records" in item and item["actual_action_records"] != len(actions):
            raise ValueError(f"Action count mismatch: R{number} {surface}")
        screenshots = list(dict.fromkeys(item.get("screenshots", [])))
        screenshot_paths = [checked_path(folder, value) for value in screenshots]
        first_look = checked_path(folder, item["first_look_file"])
        dom_paths = set()
        action_screens = set()
        outcomes = Counter()
        for action in actions:
            if action.get("evidence"):
                relative = str(actions_path.parent.relative_to(ROOT) / action["evidence"])
                dom_paths.add(str(checked_path(ROOT, relative).relative_to(ROOT)))
            if action.get("screenshot"):
                relative = str(actions_path.parent.relative_to(ROOT) / action["screenshot"])
                action_screens.add(str(checked_path(ROOT, relative).relative_to(ROOT)))
            if "outcome" in action:
                outcomes[str(action["outcome"])] += 1
        observed_blocker = item.get("observed_critical_blocker")
        conditions = {
            "functionality_at_least_3": dimensions["functionality"] >= 3,
            "clarity_at_least_3": dimensions["clarity"] >= 3,
            "new_user_friendliness_at_least_3": dimensions["new_user_friendliness"] >= 3,
            "no_observed_critical_blocker": not observed_blocker if isinstance(observed_blocker, bool) else "not_verified",
        }
        derived_gate = "fail" if False in conditions.values() else "not_verified" if "not_verified" in conditions.values() else "pass"
        output["platforms"][surface] = {
            "candidate_sha256": digest,
            "dimension_scores_raw": dimensions,
            "newcomer_subscores_raw": subscores,
            "weighted_total_raw": item["weighted_total"],
            "weighted_total_display": display(item["weighted_total"]),
            "newcomer_score_raw": dimensions["new_user_friendliness"],
            "newcomer_score_display": display(dimensions["new_user_friendliness"]),
            "gate_reported": item["critical_gate"],
            "gate_conditions_from_record": conditions,
            "gate_derived_from_record": derived_gate,
            "gate_agrees_with_recorded_conditions": item["critical_gate"] == derived_gate,
            "tasks": item.get("tasks", {}),
            "findings": item.get("findings", []),
            "browser_errors": item.get("browser_errors", []),
            "evidence": {
                "actions_file": str(actions_path.relative_to(ROOT)),
                "actions_sha256": sha256(actions_path),
                "actual_action_records": len(actions),
                "reported_action_records": item.get("actual_action_records"),
                "explicit_action_outcomes": dict(outcomes),
                "action_records_without_explicit_outcome": len(actions) - sum(outcomes.values()),
                "first_look_file": str(first_look.relative_to(ROOT)),
                "first_look_sha256": sha256(first_look),
                "reported_unique_screenshot_count": len(screenshot_paths),
                "reported_unique_screenshot_paths": [str(p.relative_to(ROOT)) for p in screenshot_paths],
                "action_screenshot_reference_count": len(action_screens),
                "action_dom_reference_count": len(dom_paths),
            },
        }
    totals = [output["platforms"][surface]["weighted_total_raw"] for surface in SURFACES]
    mean = sum(totals) / 3
    require_equal(mean, report["equal_platform_mean"], f"R{number} equal-platform mean")
    require_equal(min(totals), report["minimum_platform_score"], f"R{number} minimum-platform score")
    output.update({"equal_platform_mean_raw": report["equal_platform_mean"], "equal_platform_mean_display": display(mean),
                   "minimum_platform_score_raw": report["minimum_platform_score"], "minimum_platform_score_display": display(min(totals)),
                   "action_records_total": sum(output["platforms"][s]["evidence"]["actual_action_records"] for s in SURFACES),
                   "reported_screenshot_count_total": sum(output["platforms"][s]["evidence"]["reported_unique_screenshot_count"] for s in SURFACES)})
    return output


def markdown(summary: dict) -> str:
    rounds = summary["rounds"]
    label = "阶段性汇总" if summary["partial"] else "十轮最终汇总"
    lines = [f"# R20–R29 三端 UI：{label}", "", f"已纳入 **{len(rounds)} / 10 轮**、**{len(rounds)*3} 个候选**。生成时间（UTC）：{summary['generated_at_utc']}。", ""]
    if summary["missing_rounds"]:
        lines += ["待纳入：" + "、".join("R"+str(n) for n in summary["missing_rounds"]) + "。", ""]
    lines += ["本表读取独立评估原件，复核候选身份和计分公式。显示值按四舍五入保留一位小数，JSON 同时保存原始值。操作记录、截图和 DOM 证据分别计数。", "", "## 各轮总分与门槛", "", "| 轮次 | Web | Mac | Android | 三端均值 | 最低端 | Web 门槛 | Mac 门槛 | Android 门槛 | 总门槛 |", "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |"]
    for r in rounds:
        p = r["platforms"]
        cells = [f"[R{r['round']}](../{r['report']})"] + [p[s]["weighted_total_display"] for s in SURFACES] + [r["equal_platform_mean_display"], r["minimum_platform_score_display"]] + [gate_cell(p[s]["gate_reported"]) for s in SURFACES] + [gate_cell(r["overall_gate_reported"])]
        lines.append("| " + " | ".join(cells) + " |")
    lines += ["", "## 新用户友好度的五个子项", "", "五个子项各占该维度 20%，维度总权重为 25%。所有子项保留独立评估原分。", "", "| 轮次 / 端 | 用途理解 | 第一步 | 权限与设置 | 首次价值与核对 | 渐进披露 | 新用户友好度 / 4 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for r in rounds:
        for s in SURFACES:
            p = r["platforms"][s]
            lines.append("| " + " | ".join([f"R{r['round']} / {LABELS[s]}"] + [display(p["newcomer_subscores_raw"][k]) for k in NEWCOMER] + [p["newcomer_score_display"]]) + " |")
    lines += ["", "## 每端门槛明细", "", "| 轮次 / 端 | 功能性 ≥ 3 | 清晰度 ≥ 3 | 新用户友好度 ≥ 3 | 已观察范围无关键阻断 | 报告门槛 |", "| --- | --- | --- | --- | --- | --- |"]
    for r in rounds:
        for s in SURFACES:
            p = r["platforms"][s]
            lines.append("| " + " | ".join([f"R{r['round']} / {LABELS[s]}"] + [gate_cell(v) for v in p["gate_conditions_from_record"].values()] + [gate_cell(p["gate_reported"])]) + " |")
    lines += ["", "## 实际证据计数", "", "| 轮次 / 端 | 实际操作记录 | 报告引用的独立截图文件 | 操作引用的 DOM 文件 | 首屏理解记录 |", "| --- | ---: | ---: | ---: | --- |"]
    for r in rounds:
        for s in SURFACES:
            e = r["platforms"][s]["evidence"]
            lines.append(f"| R{r['round']} / {LABELS[s]} | {e['actual_action_records']} | {e['reported_unique_screenshot_count']} | {e['action_dom_reference_count']} | [已保存](../{e['first_look_file']}) |")
    totals = summary["evidence_totals"]
    lines += ["", f"合计：**{totals['actual_action_records']} 条操作记录**、**{totals['reported_unique_screenshot_files']} 个报告引用截图文件**、**{totals['first_look_records']} 份首屏理解记录**。操作中的明确结果字段按原样另存于 JSON；未填写该字段的记录保持未标注。", "", "## 最后纳入一轮的六维原分", "", "| 维度 | 权重 | Web / 4 | Mac / 4 | Android / 4 |", "| --- | ---: | ---: | ---: | ---: |"]
    latest = rounds[-1]
    names = {"design": "视觉设计", "originality": "产品独特性", "craft": "完成度", "functionality": "功能性", "clarity": "逻辑清晰度", "new_user_friendliness": "新用户友好度"}
    for key, weight in summary["weights"].items():
        lines.append("| " + " | ".join([names[key], str(weight)+"%"] + [display(latest["platforms"][s]["dimension_scores_raw"][key]) for s in SURFACES]) + " |")
    lines += ["", f"最后纳入的候选：R{latest['round']}。每项发现、已解决项、任务结果、浏览器错误和证据路径保留在汇总 JSON 及各轮原报告中。", ""]
    if summary.get("fresh_review_evidence"):
        lines += ["## 新上下文评估的独立资料", "", "以下目录单独列出，纵向评估的操作总数只统计前面的逐轮记录。", "", "| 评估目录 | 报告 | PNG 文件数 | 追踪归档数 |", "| --- | --- | ---: | ---: |"]
        for fresh in summary["fresh_review_evidence"]:
            link = "[已保存](../" + fresh["report"] + ")" if fresh["report"] else "待保存"
            lines.append(f"| {fresh['name']} | {link} | {fresh['png_file_count']} | {len(fresh['trace_archives'])} |")
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-partial", action="store_true", help="Explicitly label and summarize currently completed rounds")
    args = parser.parse_args()
    rubric = json.loads((ROOT / "rubric-independent.json").read_text())
    weights = {item["id"]: item["weight_percent"] for item in rubric["dimensions"]}
    completed = []
    missing = []
    for number in EXPECTED_ROUNDS:
        folder = ROOT / "rounds" / f"r{number}"
        if not (folder / "manifest.json").exists() or not (folder / "reports/independent-evaluation.json").exists():
            missing.append(number)
            continue
        completed.append(read_round(number, weights))
    if missing and not args.allow_partial:
        raise SystemExit("Final summary requires all ten rounds; missing: " + ", ".join("R"+str(n) for n in missing))
    if not completed:
        raise SystemExit("No completed independent round reports available")
    screenshots = {p for r in completed for s in SURFACES for p in r["platforms"][s]["evidence"]["reported_unique_screenshot_paths"]}
    report = {"schema": "mote-ten-rounds-scores-evidence-summary-v1", "generated_at_utc": datetime.now(timezone.utc).isoformat(), "partial": bool(missing),
              "requested_rounds": list(EXPECTED_ROUNDS), "included_rounds": [r["round"] for r in completed], "missing_rounds": missing,
              "weights": weights, "platform_aggregation": "equal arithmetic mean; minimum platform reported separately", "rounding": "Display one decimal with ROUND_HALF_UP; raw numbers retained; gates use raw numbers.",
              "scope": "Reads actual independent evaluations and their referenced artifacts; adds no new user study, score, or task execution.",
              "evidence_totals": {"actual_action_records": sum(r["action_records_total"] for r in completed), "reported_unique_screenshot_files": len(screenshots), "first_look_records": len(completed)*3,
                                  "candidate_hashes_verified": len(completed)*3, "independent_reports": len(completed)},
              "overall_gate_counts": dict(Counter(r["overall_gate_reported"] for r in completed)), "rounds": completed,
              "fresh_review_evidence": fresh_review_inventory()}
    reports = ROOT / "reports"
    reports.mkdir(exist_ok=True)
    stem = "scores-evidence-summary.partial" if args.allow_partial else "scores-evidence-summary"
    json_path = reports / (stem + ".json")
    md_path = reports / (stem + ".md")
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    md_path.write_text(markdown(report))
    print(json.dumps({"partial": report["partial"], "included_rounds": report["included_rounds"], "missing_rounds": missing,
                      "evidence_totals": report["evidence_totals"], "json": str(json_path), "markdown": str(md_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
