from pathlib import Path
import json,hashlib

root=Path(__file__).resolve().parent.parent
repo=root.parents[4]
assert repo.name=='mote-ui-work',repo
design=root.parent.parent
paths=set()
def add(f):
    if f.is_file():paths.add(f)
for f in [design/'README.md',design/'final-report.md',root/'README.md',root/'final-report.md',root/'delivery-result.json',root/'dist/review.html',root/'dist/review-r15-r18-relative.html',root/'delivery/final-report-template.md',root/'delivery/pr-body.md']:
    add(f)
for f in (root/'scripts').glob('*'):
    if f.suffix in {'.py','.cjs','.mjs','.js','.json','.tsv','.md'}:add(f)
for f in (root/'reports').glob('*'):
    if f.suffix in {'.md','.json','.js','.tsv'} and f.name not in {'independent-feature-review.json','english-inventory.json','r17-remote-blob.json','r18-remote-blob.json'}:add(f)
for folder in ['evidence/r18/source','evidence/r18/focused','evidence/r18/memory-context','evidence/r18/memory-notes-account','evidence/r18/visuals','evidence/r18/settings','evidence/r18/comparison','evidence/r19/visuals','evidence/r19/comparison']:
    for f in (root/folder).glob('*.json'):
        if f.name in {'index.json','settings-r18-dom.json','capture-summary.json','comparison-smoke.json','build-metadata.json','r18-archive-restoration.json'} or f.name.endswith('.actions.json'):add(f)
for label in 'abc':
    for f in (root/f'evidence/blind-r18-{label}').glob('*.json'):add(f)
for f in (root/'evidence/neutral-comparison').glob('*/*.json'):add(f)
for rel in ['evidence/independent/r17/natural-tasks.trace.json','evidence/independent/r17-supplement/natural-tasks.trace.json','evidence/independent/r18/natural-tasks.compact.json','evidence/independent/r18/mobile-visual-recheck.json','evidence/independent/r19/natural-tasks.trace.json','evidence/r18/feature-coverage-summary.json']:
    add(root/rel)
staging=root/'delivery';staging.mkdir(exist_ok=True)
groups=[];current=[];size=0;large=[];manifest=[]
for f in sorted(paths):
    content=f.read_text()
    e={'path':str(f.relative_to(repo)),'mode':'100644','type':'blob','content':content}
    n=len(json.dumps(e,ensure_ascii=False).encode())
    manifest.append({'path':e['path'],'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'transport':'separate readable blob' if n>245000 else 'readable tree entry'})
    if n>245000:
        large.append({'path':e['path'],'local_path':str(f),'sha256':manifest[-1]['sha256']});continue
    if current and size+n>245000:groups.append(current);current=[];size=0
    current.append(e);size+=n
if current:groups.append(current)
for i,g in enumerate(groups):(staging/f'remote-stage2-{i+1}.json').write_text(json.dumps(g,ensure_ascii=False))
(staging/'remote-large-files.json').write_text(json.dumps(large,ensure_ascii=False,indent=2)+'\n')
plan={'scope':'Readable synthetic HTML design artifacts and evidence. Complete PNG screenshots and large raw traces remain in the downloadable package. No compressed archive upload.','groups':len(groups),'large_files':large,'files':manifest}
(root/'public-file-manifest.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(paths),'groups':len(groups),'group_bytes':[len(json.dumps(g,ensure_ascii=False).encode()) for g in groups],'large_files':[{'path':x['path'],'bytes':Path(x['local_path']).stat().st_size} for x in large]},ensure_ascii=False))
