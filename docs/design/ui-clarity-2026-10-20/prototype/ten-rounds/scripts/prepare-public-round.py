"""Prepare reviewable text files; images and raw traces stay in the evidence bundle."""
import hashlib
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
repo = root.parents[4]
number = int(sys.argv[1])
candidate = root / 'rounds' / f'r{number}'
delivery = root / 'delivery' / f'r{number}'
delivery.mkdir(parents=True, exist_ok=True)
files = []
for p in sorted(candidate.rglob('*')):
    if p.is_file() and p.suffix in {'.md', '.json', '.js', '.css'} and not {'evidence', 'author'}.intersection(p.relative_to(candidate).parts):
        files.append(p)
for name in ['iteration-plan.md', 'rubric-independent.md', 'rubric-independent.json', 'README-harness.md']:
    p = root / name
    if p.exists(): files.append(p)
for name in ['build.py', 'capture-round.cjs', 'prepare-public-round.py']:
    p = root / 'scripts' / name
    if p.exists(): files.append(p)
entries = []
large = []
for p in files:
    entry = {'path': str(p.relative_to(repo)), 'mode': '100644', 'type': 'blob', 'content': p.read_text()}
    if len(json.dumps(entry, ensure_ascii=False).encode()) > 220000:
        large.append({'path': entry['path'], 'local_path': str(p)})
    else: entries.append(entry)
groups = []; current = []; size = 2
for entry in entries:
    amount = len(json.dumps(entry, ensure_ascii=False).encode()) + 2
    if current and size + amount > 220000: groups.append(current); current = []; size = 2
    current.append(entry); size += amount
if current: groups.append(current)
for i, group in enumerate(groups, 1):
    (delivery / f'group-{i}.json').write_text(json.dumps(group, ensure_ascii=False))
blobs = [{'path': str((candidate / f'{s}.html').relative_to(repo)), 'local_path': str(candidate / f'{s}.html')} for s in ['web', 'mac', 'android']] + large
result = {'round': number, 'groups': len(groups), 'text_files': len(entries), 'blobs': blobs}
(delivery / 'plan.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps({k:v for k,v in result.items() if k != 'blobs'}))
