from pathlib import Path
import hashlib,json,zipfile,re,datetime

root=Path(__file__).resolve().parent.parent
design=root.parent.parent
repo=design.parents[2]
assert repo.name=='mote-ui-work',repo
assert (root/'final-report.md').exists()
final_sha='8cabb1d2c2914170a5b00dad56a7814bbb21e28fead38ecb59f894658cbcb7bf'
for f in [root/'dist/r19.html',root/'dist/mote-ui-final.html',root.parent/'dist/mote-ui-final.html']:
    assert hashlib.sha256(f.read_bytes()).hexdigest()==final_sha
files=[]
for f in design.rglob('*'):
    if not f.is_file() or f.is_symlink():continue
    rel=f.relative_to(design)
    if any(part in {'node_modules','.git','__pycache__'} for part in rel.parts):continue
    if f.suffix in {'.zip','.pyc'}:continue
    if 'continuation/delivery/' in str(rel):continue
    if f.name in {'artifact-manifest.json','delivery-checksums.txt','delivery-result.json'}:continue
    files.append(f)
entries=[{'path':str(f.relative_to(repo)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(files)]
manifest={'scope':'Actual available design artifacts, including new R16–R19 evidence and preserved older files. Missing R9–R14 originals are not fabricated. Synthetic HTML fixtures only.','created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'final_candidate_sha256':final_sha,'file_count':len(entries),'files':entries}
manifest_path=root/'artifact-manifest.json'
manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
checksums=root/'delivery-checksums.txt'
checksums.write_text('\n'.join(x['sha256']+'  '+x['path'] for x in entries)+'\n')
archive=root/'dist/mote-ui-final-evidence.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files)+[manifest_path,checksums]:z.write(f,str(f.relative_to(repo)))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert len(z.namelist())==len(files)+2
result={'archive':str(archive.relative_to(repo)),'bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'archive_entries':len(files)+2,'manifest_entries':len(files),'final_candidate_sha256':final_sha,'scope':'Downloadable local evidence package. Not uploaded as a compressed archive to GitHub.'}
(root/'delivery-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
