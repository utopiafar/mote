"""Write independently authored judgments without deriving scores from app code.

Input decisions must come from rendered UI observations. Unmentioned assertions
and journeys remain untested. Candidate bytes are read only to calculate hashes.
"""
from __future__ import annotations
import collections
import hashlib
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PLATFORMS = ('web', 'mac', 'android')
NATIVE = {'web': 'central-web', 'mac': 'macos', 'android': 'android'}
STATUSES = {'verified', 'partial', 'missing', 'untested', 'not_applicable'}


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def applicable(feature, platform):
    return feature['id'].startswith('UF-') or NATIVE[platform] in feature['platforms']


def main():
    round_dir = Path(sys.argv[1]).resolve()
    decisions = read(Path(sys.argv[2]).resolve())
    contract = read(BASE / 'contract/user-features.json')
    journey_contract = read(BASE / 'contract/journeys.json')
    rubric = read(BASE / 'rubric-independent.json')
    weights = {c['id']: c['weight_percent'] for c in rubric['criteria']}
    coverage = []
    overrides = decisions.get('feature_observations', {})
    for feature in contract['features']:
        row = {'feature_id': feature['id'], 'family_id': feature['familyId'], 'goal': feature['userGoal'], 'platform_evidence': {}}
        for platform in PLATFORMS:
            use = applicable(feature, platform)
            value = overrides.get(feature['id'], {}).get(platform, {})
            default = 'untested' if use else 'not_applicable'
            assertions = []
            for kind, items in feature['mustKeep'].items():
                for index, label in enumerate(items):
                    key = f'{kind}:{index}'
                    judgment = value.get('assertions', {}).get(key, {})
                    if isinstance(judgment, str):
                        judgment = {'status': judgment}
                    status = judgment.get('status', default)
                    if status not in STATUSES:
                        raise ValueError(f'Invalid assertion status: {feature["id"]} {platform} {key}')
                    evidence = judgment.get('evidence', value.get('evidence', []))
                    if status == 'verified' and not evidence:
                        raise ValueError(f'Verified assertion has no evidence: {feature["id"]} {platform} {key}')
                    assertions.append({'key': key, 'kind': kind, 'assertion': label, 'status': status, 'evidence': evidence, 'observation': judgment.get('observation', '')})
            statuses = [a['status'] for a in assertions]
            status = value.get('status')
            if not use:
                status = 'not_applicable'
            elif status is None:
                status = 'verified' if statuses and all(s == 'verified' for s in statuses) else 'untested' if all(s == 'untested' for s in statuses) else 'missing' if statuses and all(s == 'missing' for s in statuses) else 'partial'
            if status == 'verified' and not all(s == 'verified' for s in statuses):
                raise ValueError(f'Feature pass has incomplete assertions: {feature["id"]} {platform}')
            if status not in STATUSES:
                raise ValueError(f'Invalid feature status: {feature["id"]} {platform}')
            row['platform_evidence'][platform] = {'status': status, 'reason': value.get('reason', 'Not exercised to contract depth in this round.' if use else 'The frozen native contract does not apply this feature to this platform.'), 'evidence': value.get('evidence', []), 'assertions': assertions}
        coverage.append(row)
    journey_items = journey_contract.get('journeys', [])
    journeys = []
    feature_map = {f['id']: f for f in contract['features']}
    for journey in journey_items:
        row = {'journey_id': journey['id'], 'feature_ids': journey['featureIds'], 'priority': journey.get('priority'), 'scenario': journey.get('scenario'), 'platform_evidence': {}}
        for platform in PLATFORMS:
            use = any(applicable(feature_map[f], platform) for f in journey['featureIds'])
            observation = decisions.get('journey_observations', {}).get(journey['id'], {}).get(platform, {})
            row['platform_evidence'][platform] = {'status': observation.get('status', 'untested' if use else 'not_applicable'), 'reason': observation.get('reason', 'Not completed to the required scenario in this round.' if use else 'No applicable feature on this platform.'), 'evidence': observation.get('evidence', [])}
        journeys.append(row)
    platform_results = {}
    for platform in PLATFORMS:
        scores = decisions['platforms'][platform]['scores']
        if set(scores) != set(weights):
            raise ValueError(f'Wrong score criteria: {platform}')
        values = {key: value['value'] if isinstance(value, dict) else value for key, value in scores.items()}
        if any(v < 0 or v > 4 or v * 4 != int(v * 4) for v in values.values()):
            raise ValueError(f'Scores must use frozen quarter-point scale: {platform}')
        counts = dict(collections.Counter(row['platform_evidence'][platform]['status'] for row in coverage))
        complete = all(row['platform_evidence'][platform]['status'] in ('verified', 'not_applicable') for row in coverage)
        if values['functionality'] >= 3 and not complete:
            raise ValueError(f'Functionality anchor 3 requires complete semantic evidence: {platform}')
        threshold = all(values[key] >= 3 for key in ('new_user', 'functionality', 'simplicity', 'clarity'))
        journey_pass = all(row['platform_evidence'][platform]['status'] in ('verified', 'not_applicable') for row in journeys)
        central_gate = decisions['platforms'][platform].get('central_collection_gate', 'untested')
        platform_results[platform] = {**decisions['platforms'][platform], 'weighted_score_100': round(sum(values[key] / 4 * weights[key] for key in weights), 3), 'coverage_counts': counts, 'hard_gates': {'platform_thresholds': 'pass' if threshold else 'fail', 'semantic_completeness': 'pass' if complete else 'fail', 'critical_journeys': 'pass' if journey_pass else 'fail', 'no_central_local_collection': central_gate}}
        if 'scope_integrity_gate' in decisions['platforms'][platform]:
            platform_results[platform]['hard_gates']['scope_integrity'] = decisions['platforms'][platform]['scope_integrity_gate']
    passed = all(all(v == 'pass' for v in p['hard_gates'].values()) for p in platform_results.values())
    identity = {'round': decisions['round'], 'evaluator': decisions.get('evaluator', '/root/r30_34_independent_review'), 'source_sha': contract['sourceSha'], 'candidate_sha256': {p: digest(round_dir / f'{p}.html') for p in PLATFORMS}, 'contract_sha256': digest(BASE / 'contract/user-features.json'), 'journeys_sha256': digest(BASE / 'contract/journeys.json'), 'rubric_sha256': digest(BASE / 'rubric-independent.json'), 'rubric_id': rubric['rubric_id']}
    report = {'schema_version': 1, **identity, 'status': 'PASS' if passed else 'FAIL', 'platforms': platform_results, 'mean_score_100': round(sum(p['weighted_score_100'] for p in platform_results.values()) / 3, 3), 'weakest_platform': min(platform_results, key=lambda p: platform_results[p]['weighted_score_100']), 'findings': decisions.get('findings', []), 'screen_inspection': decisions.get('screen_inspection', {}), 'limits': decisions.get('limits', []), 'next_corrections': decisions.get('next_corrections', [])}
    output = round_dir / 'reports'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'independent-evaluation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (output / 'feature-coverage.json').write_text(json.dumps({'schema_version': 1, **identity, 'applicability': 'UF semantics apply to every exposed shared Central workspace; NAT follows exact platform applicability.', 'features': coverage}, ensure_ascii=False, indent=2) + '\n')
    (output / 'journey-coverage.json').write_text(json.dumps({'schema_version': 1, **identity, 'journeys': journeys}, ensure_ascii=False, indent=2) + '\n')
    rows = [f'# {decisions["round"]} independent evaluation', '', f'**Decision: {report["status"]}. Mean: {report["mean_score_100"]}/100.**', '', '| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | /100 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for platform, result in platform_results.items():
        values = result['scores']
        rows.append('| ' + platform + ' | ' + ' | '.join(str(values[k]['value'] if isinstance(values[k], dict) else values[k]) for k in ('new_user', 'functionality', 'simplicity', 'clarity', 'design', 'craft', 'originality')) + f' | {result["weighted_score_100"]} |')
    rows += ['', 'A score does not override a failed gate. Unverified required assertions remain incomplete.', '', '## Findings', '']
    for finding in report['findings']:
        rows += ['### ' + finding['id'] + ' — ' + finding['title'], '', finding['observed'], '', '**Correction:** ' + finding['correction'], '', '**Evidence:** ' + ', '.join(f'[{Path(e).name}]({e})' for e in finding.get('evidence', [])), '']
    rows += ['## Evidence scope', ''] + ['- ' + limit for limit in report['limits']] + ['', '## Coverage and identity', '', '- [Feature assertions](feature-coverage.json)', '- [Journey coverage](journey-coverage.json)', '- [Complete scores, gates, and artifact identities](independent-evaluation.json)', '']
    (output / 'independent-evaluation.md').write_text('\n'.join(rows) + '\n')
    rows = [f'# {decisions["round"]} semantic coverage', '', 'The complete assertion-level evidence is in [feature-coverage.json](feature-coverage.json). A route, a label, or a generic success message does not establish a feature pass.', '', '| Feature | Web | Mac | Android |', '|---|---|---|---|']
    for row in coverage:
        rows.append('| ' + row['feature_id'] + ' | ' + ' | '.join(row['platform_evidence'][p]['status'] for p in PLATFORMS) + ' |')
    (output / 'feature-coverage.md').write_text('\n'.join(rows) + '\n')
    rows = [f'# {decisions["round"]} journey coverage', '', 'Scenario-specific outcomes are recorded independently from navigation coverage. Partial or untested required journeys block completeness.', '', '| Journey | Web | Mac | Android |', '|---|---|---|---|']
    for row in journeys:
        rows.append('| ' + row['journey_id'] + ' | ' + ' | '.join(row['platform_evidence'][p]['status'] for p in PLATFORMS) + ' |')
    (output / 'journey-coverage.md').write_text('\n'.join(rows) + '\n')
    print(json.dumps({'round': decisions['round'], 'status': report['status'], 'mean': report['mean_score_100'], 'platforms': {p: {'score': r['weighted_score_100'], 'gates': r['hard_gates'], 'coverage': r['coverage_counts']} for p, r in platform_results.items()}}))


if __name__ == '__main__':
    main()
