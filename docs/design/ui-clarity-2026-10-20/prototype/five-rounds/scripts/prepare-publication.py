#!/usr/bin/env python3
"""Prepare readable Git API payloads without altering a frozen UI candidate."""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = next(p for p in ROOT.parents if (p / '.git').exists())

def main():
    p = argparse.ArgumentParser()
    p.add_argument('round', type=int)
    p.add_argument('--evidence', action='store_true')
    p.add_argument('--review', action='store_true')
    p.add_argument('--delivery', action='store_true')
    args = p.parse_args()
    candidate = ROOT / f'rounds/r{args.round}'
    files = []
    for f in (candidate / 'reports' if args.review else candidate).rglob('*'):
        if not f.is_file():
            continue
        is_evidence = 'evidence' in f.relative_to(candidate).parts
        if not args.review and is_evidence != args.evidence:
            continue
        if args.review and f.suffix == '.png':
            continue
        if f.suffix == '.png' and not args.evidence:
            continue
        files.append(f)
    if args.review:
        for report in (candidate / 'reports').rglob('*.md'):
            for link in re.findall(r'\]\(([^)]+\.(?:png|json))\)', report.read_text()):
                target = (report.parent / link).resolve()
                image = target if target.suffix == '.png' else target.with_suffix('.png')
                if image.exists():
                    files.append(image)
    if not args.evidence and not args.review:
        files += [ROOT / f'changes/r{args.round}.json']
        files += [f for f in (ROOT / 'scripts').glob('*') if f.is_file()]
    if args.delivery:
        files = [ROOT / name for name in ('README.md', 'index.html', 'review-summary.json', 'round-commits.json', 'final-report.md')]
        files += [f for f in (ROOT / 'scripts').glob('*') if f.is_file()]
        for directory in ('previews/r34', 'first-look/r34', 'delivery-checks'):
            files += [f for f in (ROOT / directory).rglob('*') if f.is_file()]
    chunks, batch, length, manifest = [], [], 0, []
    for f in sorted(set(files)):
        data = f.read_bytes()
        binary = f.suffix.lower() in {'.png', '.wav'}
        content = base64.b64encode(data).decode() if binary else data.decode()
        path = str(f.relative_to(REPO))
        manifest.append({'path': path, 'bytes': len(data), 'binary': binary,
                         'sha256': hashlib.sha256(data).hexdigest(),
                         'gitBlobSha': hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()})
        for offset in range(0, len(content), 100000):
            item = {'path': path, 'binary': binary, 'offset': offset,
                    'content': content[offset:offset+100000]}
            size = len(json.dumps(item, ensure_ascii=False))
            if batch and length + size > 250000:
                chunks.append(batch)
                batch, length = [], 0
            batch.append(item)
            length += size
    if batch:
        chunks.append(batch)
    target = ROOT / 'work/publication' / (f'r{args.round}-delivery' if args.delivery else f'r{args.round}-review' if args.review else f'r{args.round}-evidence' if args.evidence else f'r{args.round}')
    target.mkdir(parents=True, exist_ok=True)
    for i, chunk in enumerate(chunks):
        (target / f'{i}.json').write_text(json.dumps(chunk, ensure_ascii=False))
    (target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    (target / 'count.txt').write_text(str(len(chunks)))
    print(json.dumps({'path': str(target), 'files': len(manifest), 'chunks': len(chunks),
                      'bytes': sum(x['bytes'] for x in manifest)}))

if __name__ == '__main__':
    main()
