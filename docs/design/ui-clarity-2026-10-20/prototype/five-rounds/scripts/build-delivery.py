#!/usr/bin/env python3
"""Validate frozen review identities and package the five completed UI rounds.

This script validates existing report arithmetic. It never assigns scores,
changes judgments, mutates Git, or modifies a frozen candidate/report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUNDS = tuple(range(30, 35))
PLATFORMS = ('web', 'mac', 'android')
REPOSITORY = 'utopiafar/mote'
EXCLUDED_PARTS = {'.git', '__pycache__', 'node_modules', '.DS_Store'}


def read(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative_file(base: Path, name: str) -> Path:
    value = Path(name)
    require(not value.is_absolute() and '..' not in value.parts, f'Unsafe manifest path: {name}')
    candidate = base / value
    require(candidate.is_file() and not candidate.is_symlink(), f'Missing or linked file: {candidate}')
    require(candidate.resolve().is_relative_to(base.resolve()), f'Path outside frozen input: {candidate}')
    return candidate


def check_hash(path: Path, expected: str, label: str):
    require(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{64}', expected), f'Invalid SHA-256 for {label}')
    require(digest(path) == expected, f'Frozen hash mismatch: {label}')


def validate_round(root: Path, number: int) -> dict:
    folder = root / f'rounds/r{number}'
    manifest = read(folder / 'manifest.json')
    report_folder = folder / 'reports'
    report = read(report_folder / 'independent-evaluation.json')
    freeze = read(report_folder / 'evaluation-freeze.json')
    rubric = read(folder / 'rubric-independent.json')
    require(manifest.get('round') == number and manifest.get('frozen') is True, f'R{number} is not a frozen candidate')
    require(report.get('round') == freeze.get('round') == f'R{number}', f'Round identity mismatch: R{number}')
    require(report.get('evaluator') == freeze.get('evaluator') and bool(report.get('evaluator')), f'Evaluator identity mismatch: R{number}')
    require(report.get('source_sha') == manifest.get('productSourceRevision'), f'Product source revision mismatch: R{number}')
    require(report.get('rubric_id') == rubric.get('rubric_id'), f'Rubric identity mismatch: R{number}')
    require(report.get('status') in ('PASS', 'FAIL'), f'R{number} does not have a final independent status')
    for relative, expected in freeze.get('files', {}).items():
        check_hash(relative_file(report_folder, relative), expected, f'R{number} report/{relative}')
    require({'independent-evaluation.json', 'independent-evaluation.md', 'feature-coverage.json', 'decisions-independent.json'} <= set(freeze.get('files', {})), f'R{number} report freeze is incomplete')
    if freeze.get('candidate_manifest_sha256'):
        check_hash(folder / 'manifest.json', freeze['candidate_manifest_sha256'], f'R{number} candidate manifest')
    for name, expected in manifest.get('sourceHashes', {}).items():
        check_hash(relative_file(folder / 'src', name), expected, f'R{number} source/{name}')
    require(bool(manifest.get('sourceHashes')), f'R{number} source snapshot has no hashes')
    artifacts = {item['platform']: item for item in manifest.get('artifacts', [])}
    require(set(artifacts) == set(PLATFORMS), f'R{number} must contain exactly three candidate artifacts')
    for platform, artifact in artifacts.items():
        file = relative_file(folder, artifact['file'])
        require(artifact['file'] == platform + '.html', f'Unexpected candidate filename: {file}')
        check_hash(file, artifact['sha256'], f'R{number} {platform} candidate')
        require(file.stat().st_size == artifact['bytes'], f'Candidate size mismatch: {file}')
        require(report.get('candidate_sha256', {}).get(platform) == artifact['sha256'], f'Report evaluated another candidate: R{number} {platform}')
    for name, report_key, manifest_key in (
        ('contract/user-features.json', 'contract_sha256', 'inventorySha256'),
        ('contract/journeys.json', 'journeys_sha256', None),
        ('rubric-independent.json', 'rubric_sha256', 'rubricSha256'),
    ):
        check_hash(root / name, report[report_key], f'R{number} {name}')
        if manifest_key:
            require(manifest[manifest_key] == report[report_key], f'Manifest/report identity mismatch: R{number} {name}')
    check_hash(folder / 'rubric-independent.json', report['rubric_sha256'], f'R{number} frozen rubric')
    evidence_manifest = report_folder / 'evidence-manifest.json'
    evidence_count = 0
    if evidence_manifest.exists():
        require('evidence-manifest.json' in freeze['files'], f'Unfrozen evidence manifest: R{number}')
        evidence = read(evidence_manifest)
        for relative, expected in evidence.get('files', {}).items():
            check_hash(relative_file(report_folder, relative), expected, f'R{number} {relative}')
            evidence_count += 1
        if 'file_count' in evidence:
            require(evidence_count == evidence['file_count'], f'Evidence count mismatch: R{number}')
    else:
        require(number == 30, f'Missing independent evidence manifest: R{number}')
    # Pure arithmetic validation of evaluator-authored values; never new scoring.
    weights = {criterion['id']: criterion['weight_percent'] for criterion in rubric['criteria']}
    require(sum(weights.values()) == 100, 'Frozen rubric weights do not total 100')
    require(set(report.get('platforms', {})) == set(PLATFORMS), f'R{number} lacks platform judgments')
    totals = {}
    for platform in PLATFORMS:
        result = report['platforms'][platform]
        require(set(result['scores']) == set(weights), f'Score criteria mismatch: R{number} {platform}')
        values = {key: value['value'] for key, value in result['scores'].items()}
        require(all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 4 and value * 4 == int(value * 4) for value in values.values()), f'Invalid frozen score scale: R{number} {platform}')
        weighted = sum(values[key] / 4 * weight for key, weight in weights.items())
        require(abs(weighted - result['weighted_score_100']) <= 0.001, f'Reported weighted-score arithmetic mismatch: R{number} {platform}')
        totals[platform] = result['weighted_score_100']
    require(abs(sum(totals.values()) / 3 - report['mean_score_100']) <= 0.001, f'Reported mean arithmetic mismatch: R{number}')
    require(report.get('weakest_platform') in totals and totals[report['weakest_platform']] == min(totals.values()), f'Reported weakest platform mismatch: R{number}')
    return {'number': number, 'status': report['status'], 'mean': report['mean_score_100'], 'platforms': totals, 'weakest': report['weakest_platform'], 'reportSha256': digest(report_folder / 'independent-evaluation.json'), 'candidateManifestSha256': digest(folder / 'manifest.json'), 'evidenceManifest': evidence_manifest.exists(), 'independentlyHashedEvidenceFiles': evidence_count, 'coverage': {platform: report['platforms'][platform].get('coverage_counts', {}) for platform in PLATFORMS}}


def validate_gallery(root: Path, rounds: list[dict]):
    html = (root / 'index.html').read_text(encoding='utf-8')
    match = re.search(r'const rounds\s*=\s*', html)
    require(match is not None, 'Gallery has no embedded frozen-round data; run scripts/build-review.py')
    embedded, _ = json.JSONDecoder().raw_decode(html[match.end():])
    require([row['number'] for row in embedded] == list(ROUNDS), 'Gallery does not include all five rounds; run scripts/build-review.py')
    require(read(root / 'review-summary.json') == embedded, 'Gallery/review-summary mismatch; run scripts/build-review.py')
    for summary, checked in zip(embedded, rounds):
        require(summary['status'] == checked['status'] and summary['mean'] == checked['mean'], f'Gallery has stale independent results: R{checked["number"]}')
        for platform in PLATFORMS:
            require(summary['platforms'][platform]['weighted_score_100'] == checked['platforms'][platform], f'Gallery has stale platform score: R{checked["number"]} {platform}')


def publication(root: Path, rounds: list[dict]) -> dict:
    file = root / 'work/publication/progress.json'
    progress = read(file)
    output = []
    for row in rounds:
        key = 'r' + str(row['number'])
        require(key in progress, f'Missing {key} in publication progress; no commit will be invented')
        item = progress[key]
        require(isinstance(item.get('branch'), str) and item['branch'], f'Missing branch for {key}')
        require(all(re.fullmatch(r'[0-9a-f]{40}', item.get(field, '')) for field in ('head', 'tree')), f'Missing or invalid recorded Git identity for {key}')
        output.append({'round': row['number'], 'branch': item['branch'], 'commit': item['head'], 'tree': item['tree'], 'publicationState': item.get('state', ''), 'branchUrl': f'https://github.com/{REPOSITORY}/tree/{item["branch"]}', 'commitUrl': f'https://github.com/{REPOSITORY}/commit/{item["head"]}', 'independentStatus': row['status'], 'independentReportSha256': row['reportSha256'], 'candidateManifestSha256': row['candidateManifestSha256']})
    return {'repository': REPOSITORY, 'source': 'work/publication/progress.json', 'sourceSha256': digest(file), 'verificationScope': 'Recorded review-complete publication commits, before the final delivery-document commit. Branch heads may advance to add delivery documents without changing frozen candidates or reports. This packaging step makes no remote Git request or mutation; publication state is preserved verbatim.', 'rounds': output}


def validate_previews(root: Path) -> dict:
    folder = root / 'previews/r34'
    previews = read(folder / 'manifest.json')['artifacts']
    candidates = {item['platform']: item['sha256'] for item in read(root / 'rounds/r34/manifest.json')['artifacts']}
    scenes = ('first-use', 'import-context', 'library', 'sources')
    require(len(previews) == 12 and {(item['platform'], item['scene']) for item in previews} == {(platform, scene) for platform in PLATFORMS for scene in scenes}, 'R34 preview set must contain three platforms × four scenes')
    for item in previews:
        require(item['candidateSha256'] == candidates[item['platform']], f'Preview references another candidate: {item["file"]}')
        image = relative_file(folder, item['file'])
        require(image.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n', f'Preview is not a PNG: {image}')
        relative_file(folder, str(Path(item['file']).with_suffix('.json')))
    return {'directory': 'previews/r34', 'viewportImages': 12, 'matchingDOMFiles': 12, 'candidateHashesMatched': True}


def readme(rounds: list[dict], commits: dict) -> str:
    latest = rounds[-1]
    verdict = '通过已冻结的 UI 验收门槛' if latest['status'] == 'PASS' else '未通过全部验收门槛'
    lines = ['# Mote · R30–R34 三端 HTML 评审包', '', '本包保留五轮独立迭代的 15 份完整 HTML、每轮源代码、功能契约、评分规则、独立报告及原始观察证据。原型使用合成数据；没有验证后台服务、原生采集、真实模型、OAuth、日历写入或真实设备配对。', '', '仓库保存冻结原型、源码、独立报告、DOM/动作记录与报告引用的截图；离线 ZIP 另外包含本次留存的全部原始截图。', '', '## 打开方式', '', '1. 解压整个 ZIP，保留目录结构，然后用浏览器打开 [index.html](index.html)。', '2. 在页首切换迭代版本、演示内容与平台；“单独打开”进入完整尺寸的页面。切换版本或场景会重置相应演示。', '3. 最后一轮也可直接打开：[Web](rounds/r34/web.html) · [Mac](rounds/r34/mac.html) · [Android](rounds/r34/android.html)。每份候选 HTML 自包含，不依赖在线服务。', '', '若浏览器限制本地 iframe，请直接使用上面的独立 HTML。也可在本目录运行 `python -m http.server 8765 --bind 127.0.0.1`，再打开 `http://127.0.0.1:8765/`。Git 分支链接需要联网，原型本身不需要。', '', '## 五轮独立结果', '', '下表直接采用各轮已冻结的独立报告。打包脚本只核对文件身份与算术，不重新评分、不改判定。均分上升不等同于功能完整性通过。', '', '| 轮次 | Web | Mac | Android | 均分 / 100 | 独立验收 | 报告 |', '|---|---:|---:|---:|---:|---|---|']
    preview_lines = ['', '## R34 视口预览', '', '这些预览由冻结 R34 的实际可见界面生成，采用固定中文字体，先保存 DOM 再保存视口截图。每张 PNG 旁都有同名 DOM JSON；[预览清单](previews/r34/manifest.json)记录对应候选哈希。', '', '| 平台 | 首次使用 | 导入与资料说明 | 资料库 | 来源 |', '|---|---|---|---|---|']
    for platform in PLATFORMS:
        preview_lines.append('| ' + platform + ' | ' + ' | '.join(f'[{label}](previews/r34/{platform}-{scene}.png)' for scene, label in (('first-use', '首次使用'), ('import-context', '导入说明'), ('library', '资料库'), ('sources', '来源'))) + ' |')
    insert_at = lines.index('## 五轮独立结果') - 1
    lines[insert_at:insert_at] = preview_lines + ['']
    for row in rounds:
        label = '通过' if row['status'] == 'PASS' else '未通过全部门槛'
        lines.append(f'| R{row["number"]} | {row["platforms"]["web"]:.3f} | {row["platforms"]["mac"]:.3f} | {row["platforms"]["android"]:.3f} | {row["mean"]:.3f} | {label} | [独立报告](rounds/r{row["number"]}/reports/independent-evaluation.md) |')
    lines += ['', f'**R34 的独立结论：{verdict}。** 具体缺口、未验证项与下一步修正见 [R34 报告](rounds/r34/reports/independent-evaluation.md)；详细功能状态见 [功能覆盖表](rounds/r34/reports/feature-coverage.md)。', '', '| R34 平台 | 已验证 | 部分完成 | 缺失 | 未验证 | 不适用 |', '|---|---:|---:|---:|---:|---:|']
    for platform in PLATFORMS:
        counts = latest['coverage'][platform]
        lines.append('| ' + platform + ' | ' + ' | '.join(str(counts.get(key, 0)) for key in ('verified', 'partial', 'missing', 'untested', 'not_applicable')) + ' |')
    lines += ['', '## 来源、职责与证据', '', '- 具体修改与剩余问题见 [最终报告](final-report.md)。独立首屏观察见 [R34 首屏记录](first-look/r34/first-look.md)，这是 AI 代理观察，不是真人测试。', '- [独立功能清单](contract/user-features.md)与[关键旅程](contract/journeys.json)是功能核对依据；目录入口数量不等同于完整功能数量。', '- Central 接收、导入和整理资料；Mac 与 Android 只采集各自设备授权范围。浏览器文件夹上传属于一次导入。', '- 每轮 `manifest.json` 记录三个候选 HTML 与源代码快照的哈希。`reports/evaluation-freeze.json` 记录独立报告哈希，已有的 `evidence-manifest.json` 记录独立证据哈希。', '- R30 没有单独的独立证据哈希清单。本包验证其原有报告冻结哈希，并为复制的原始证据记录交付时哈希；这不构成追溯性的独立证据冻结。', '- `delivery-manifest.json` 记录本包文件的 SHA-256。候选、报告和证据均按原字节复制，没有把测试字体或查看器脚本注入冻结 HTML。', '- 本地查看器检查在隔离浏览器中阻止外部网络，只在响应内注入固定字体；先保存可见 DOM，再保存视口截图。它属于交付检查，不是独立评分。', '', '## 独立分支与提交', '', '以下身份是各轮评审完成时记录的提交，来自 `work/publication/progress.json`。最后的交付文档提交可以使分支 HEAD 前移，不改变已冻结的候选与报告；这里保留可复现的评审快照。打包脚本不访问远端、不提交、不推送。完整记录和原始发布状态保存在 [round-commits.json](round-commits.json)。', '', '| 轮次 | 分支 | 记录的提交 |', '|---|---|---|']
    for item in commits['rounds']:
        lines.append(f'| R{item["round"]} | [{item["branch"]}]({item["branchUrl"]}) | [{item["commit"][:12]}]({item["commitUrl"]}) |')
    lines += ['', '## 目录与复核', '', '- 本评审包的 `rounds/r30` 至 `rounds/r34`：冻结候选、源代码、变更说明、评分规则、独立报告和本次留存的全部原始证据；Git 中的图片范围以上文说明为准。', '- `contract/`：独立功能与旅程契约；`baseline/`：构建起点；`scripts/`：可读构建、检查与交付脚本。', '- ZIP 与暂存包生成在被 Git 忽略的 `work/delivery-*` 中；不把 ZIP、浏览器运行时、字体缓存或发布 API 分块混入 Git 代码提交。', '', '生成最终包前，应先完成五轮独立报告与发布记录，并刷新查看器：', '', '```sh', 'python scripts/build-review.py', 'node scripts/check-viewer.cjs --expect-rounds 30,31,32,33,34', 'python scripts/build-delivery.py', '```', '', '查看器自动检查需要本项目既有的 Playwright、固定 Chrome 与字体运行时；这些测试依赖不包含在评审 ZIP 中。直接打开 HTML 无需这些依赖。', '']
    return '\n'.join(lines)


def package_files(root: Path) -> list[Path]:
    files = []
    for directory in ('contract', 'baseline', 'scripts', 'previews/r34', 'first-look/r34', 'delivery-checks'):
        files.extend(path for path in (root / directory).rglob('*') if path.is_file())
    for number in ROUNDS:
        files.extend(path for path in (root / f'rounds/r{number}').rglob('*') if path.is_file())
    if (root / 'final-report.md').exists():
        files.append(root / 'final-report.md')
    files.extend(root / name for name in ('index.html', 'review-summary.json', 'rubric-independent.json', 'rubric-independent.md', 'iteration-plan.md', 'review-plan.md'))
    output = []
    for file in sorted(set(files)):
        relative = file.relative_to(root)
        if any(part in EXCLUDED_PARTS for part in relative.parts):
            continue
        require(not file.is_symlink(), f'Delivery does not include symlinks: {relative}')
        require('work' not in relative.parts and file.is_file(), f'Invalid delivery input: {relative}')
        output.append(file)
    require(sum(file.name in ('web.html', 'mac.html', 'android.html') and file.parent.parent.name == 'rounds' for file in output) == 15, 'Delivery must contain exactly fifteen frozen candidate HTML files')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validate-only', action='store_true', help='Validate all five rounds, gallery and recorded publication identities without writing a package')
    parser.add_argument('--output', default='work/delivery-r30-r34', help='Managed output directory directly below work/, beginning with delivery-')
    arguments = parser.parse_args()
    missing = [f'R{number}/{name}' for number in ROUNDS for name in ('manifest.json', 'reports/independent-evaluation.json', 'reports/evaluation-freeze.json') if not (ROOT / f'rounds/r{number}' / name).is_file()]
    require(not missing, 'Final delivery is not ready; missing frozen inputs: ' + ', '.join(missing))
    rounds = [validate_round(ROOT, number) for number in ROUNDS]
    validate_gallery(ROOT, rounds)
    previews = validate_previews(ROOT)
    commits = publication(ROOT, rounds)
    files = package_files(ROOT)
    validation = {'scope': 'Identity and arithmetic validation of independently authored frozen reports; no new scoring', 'rounds': rounds, 'previews': previews, 'inputFiles': len(files)}
    if arguments.validate_only:
        print(json.dumps(validation, ensure_ascii=False, indent=2))
        return
    output = (ROOT / arguments.output).resolve()
    require(output.parent == ROOT / 'work' and output.name.startswith('delivery-'), 'Output must be directly inside work/delivery-*')
    if output.exists():
        require((output / 'delivery-manifest.json').is_file(), 'Refusing to replace an unmanaged output directory')
    stage = Path(tempfile.mkdtemp(prefix='delivery-stage-', dir=ROOT / 'work'))
    archive_temp = ROOT / 'work' / (stage.name + '.zip')
    try:
        manifest_files = {}
        for source in files:
            relative = source.relative_to(ROOT)
            expected = digest(source)
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            require(digest(target) == expected, f'Copied file changed: {relative}')
            manifest_files[relative.as_posix()] = {'sha256': expected, 'bytes': target.stat().st_size}
        for name, content in (('README.md', readme(rounds, commits)), ('round-commits.json', json.dumps(commits, ensure_ascii=False, indent=2) + '\n')):
            target = stage / name
            target.write_text(content, encoding='utf-8')
            manifest_files[name] = {'sha256': digest(target), 'bytes': target.stat().st_size}
        manifest = {'schemaVersion': 1, 'createdAtUTC': datetime.now(timezone.utc).isoformat(), 'generatedBy': 'scripts/build-delivery.py', 'validation': validation, 'excluded': ['work/runtime', 'work/publication payload chunks', '.git', 'node_modules', '__pycache__'], 'files': manifest_files}
        (stage / 'delivery-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        with zipfile.ZipFile(archive_temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for file in sorted(stage.rglob('*')):
                if file.is_file():
                    archive.write(file, Path('mote-ui-r30-r34') / file.relative_to(stage))
        with zipfile.ZipFile(archive_temp) as archive:
            require(archive.testzip() is None, 'ZIP integrity check failed')
            require(len(archive.namelist()) == len(manifest_files) + 1, 'ZIP file count mismatch')
        if output.exists():
            shutil.rmtree(output)
        stage.replace(output)
        archive_path = output.with_suffix('.zip')
        archive_temp.replace(archive_path)
        print(json.dumps({'package': str(output), 'zip': str(archive_path), 'zipSha256': digest(archive_path), 'files': len(manifest_files) + 1, 'rounds': list(ROUNDS), 'readme': str(output / 'README.md'), 'commits': str(output / 'round-commits.json')}, ensure_ascii=False))
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if archive_temp.exists():
            archive_temp.unlink()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        print('Delivery validation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
