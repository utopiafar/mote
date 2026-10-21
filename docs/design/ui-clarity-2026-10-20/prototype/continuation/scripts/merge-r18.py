from pathlib import Path
import json, hashlib, datetime

root = Path(__file__).resolve().parent.parent
base = root / 'dist/r17.html'
html = base.read_text()
assert hashlib.sha256(base.read_bytes()).hexdigest() == '290534ad7b054e1349ca836e13e7c30d3913860964479517052c8523031d7c6c'
applied = []
for family in ['memory-context-r18', 'source-r18', 'settings-r18']:
    data = json.loads((root / 'reports' / (family + '-replacements.json')).read_text())
    replacements = data['replacements'] if isinstance(data, dict) else data
    for index, item in enumerate(replacements):
        before = item.get('before', item.get('old'))
        after = item.get('after', item.get('new'))
        expected = item.get('count', 1)
        actual = html.count(before)
        assert actual == expected, f'{family} #{index+1}: expected {expected}, found {actual}; {before[:150]}'
        html = html.replace(before, after)
        applied.append({'family': family, 'index': index + 1, 'count': actual, 'label': item.get('purpose', item.get('label', ''))})
assert html.count('const REV = 17;') == 1
html = html.replace('const REV = 17;', 'const REV = 18;', 1)
candidate = root / 'dist/r18.html'
if candidate.exists():
    assert candidate.read_text() == html, 'Frozen R18 already exists with different bytes'
else:
    candidate.write_text(html)
(root / 'work/integration.html').write_text(html)
meta = {'candidate': 'continuation/dist/r18.html', 'revision': 18, 'sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(), 'bytes': candidate.stat().st_size, 'base_sha256': hashlib.sha256(base.read_bytes()).hexdigest(), 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': 'Self-contained HTML mock UI. No live backend or system permission validation.', 'applied_replacements': applied}
(root / 'reports/r18-freeze.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k:v for k,v in meta.items() if k != 'applied_replacements'}, ensure_ascii=False))
