#!/usr/bin/env python3
"""Build immutable, self-contained three-platform candidates from frozen R29."""
import argparse, hashlib, json, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('round', type=int, choices=range(30, 35))
    parser.add_argument('--freeze', action='store_true')
    args = parser.parse_args()
    contract = ROOT / 'contract/user-features.json'
    if not contract.exists():
        raise SystemExit('Independent feature inventory must be frozen before building.')
    target = ROOT / ('rounds' if args.freeze else 'work') / f'r{args.round}'
    if args.freeze and target.exists():
        raise SystemExit('Frozen round exists; do not overwrite.')
    target.mkdir(parents=True, exist_ok=True)
    source_names = ['focus.css', 'focus.js']
    if args.round >= 31:
        for layer in ('native-semantics', 'central-semantics'):
            source_names += [layer+ext for ext in ('.css','.js') if (ROOT/'src'/(layer+ext)).exists()]
    css = '\n'.join((ROOT/'src'/n).read_text() for n in source_names if n.endswith('.css'))
    js = '\n'.join((ROOT/'src'/n).read_text() for n in source_names if n.endswith('.js'))
    for platform in ('web', 'mac', 'android'):
        html = (ROOT / f'baseline/r29-{platform}.html').read_text()
        html = html.replace('window.MOTE_ROUND=29;', f'window.MOTE_ROUND={args.round};', 1)
        html = html.replace('const REV = 29;', f'const REV = {args.round};', 1)
        marker = '<script data-iteration-start="true">'
        if html.count(marker) != 1:
            raise SystemExit('Baseline bootstrap changed.')
        html = html.replace(marker, '<style data-focus-layer="true">\n'+css+'\n</style>\n<script data-focus-layer="true">\n'+js+'\n</script>\n'+marker)
        (target / f'{platform}.html').write_text(html)
    if args.freeze:
        (target / 'src').mkdir()
        for name in source_names:
            shutil.copyfile(ROOT/'src'/name, target/'src'/name)
        for name in ('rubric-independent.json', 'rubric-independent.md'):
            shutil.copyfile(ROOT / name, target / name)
        change = ROOT / f'changes/r{args.round}.json'
        if not change.exists():
            raise SystemExit('A round needs its concrete changes before freezing.')
        shutil.copyfile(change, target / 'changes.json')
    manifest = {
        'round': args.round, 'frozen': args.freeze,
        'productSourceRevision': '81a73c0ec81af876d6eeef71451b75cd51684b34',
        'prototypeBaselineRevision': '9aec3d55d9e6af391c0cc5c2b1dbca8b2936a0e1',
        'inventorySha256': sha(contract),
        'rubricSha256': sha(ROOT / 'rubric-independent.json'),
        'scope': 'HTML UI simulation; synthetic data; no backend, native or live-model validation',
        'artifacts': [{'platform': p, 'file': p+'.html', 'sha256': sha(target/(p+'.html')), 'bytes': (target/(p+'.html')).stat().st_size} for p in ('web','mac','android')],
        'sourceHashes': {name:sha(ROOT/'src'/name) for name in source_names}
    }
    (target/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'round':args.round,'frozen':args.freeze,'path':str(target),'artifacts':manifest['artifacts']},ensure_ascii=False))

if __name__ == '__main__':
    main()
