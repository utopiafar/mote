#!/usr/bin/env python3
"""Compare frontend entry bytes with an explicit Git baseline, using identical installed dependencies.
The temporary baseline build is retained so benchmark-web-startup.cjs can use it.
"""
import pathlib,subprocess,tempfile,tarfile,io,json,re,gzip,shutil,argparse
parser=argparse.ArgumentParser()
parser.add_argument('--baseline',required=True)
parser.add_argument('--out',type=pathlib.Path,required=True)
args=parser.parse_args()
repo=pathlib.Path(__file__).resolve().parent.parent;scratch=pathlib.Path(tempfile.mkdtemp(prefix='mote-web-baseline-')).resolve()
archive=subprocess.check_output(['git','-C',str(repo),'archive',args.baseline,'apps/web'])
with tarfile.open(fileobj=io.BytesIO(archive)) as t:
 for entry in t.getmembers():
  assert not entry.issym() and not entry.islnk() and (scratch/entry.name).resolve().is_relative_to(scratch)
 t.extractall(scratch)
shutil.copyfile(repo/'package.json',scratch/'package.json');(scratch/'node_modules').symlink_to(repo/'node_modules',target_is_directory=True)
with open(scratch/'build.log','w') as log:subprocess.run(['node',str(repo/'node_modules/vite/bin/vite.js'),'build'],cwd=scratch/'apps/web',stdout=log,stderr=subprocess.STDOUT,check=True)
def measure(dist):
 html=(dist/'index.html').read_text();scripts=re.findall(r'(?:src|href)="(/assets/[^\"]+\.js)"',html)
 return {'entryAssets':[{ 'name':name,'bytes':len((dist/name.lstrip('/')).read_bytes()),'gzipBytes':len(gzip.compress((dist/name.lstrip('/')).read_bytes(),mtime=0))}for name in scripts], 'allJavaScriptBytes':sum(p.stat().st_size for p in (dist/'assets').glob('*.js'))}
r={'baselineFrontendCommit':args.baseline,'baselineDirectory':str(scratch/'apps/web/dist'),'currentDirectory':str(repo/'apps/web/dist'),'dependencyNote':'Both frontend builds use the same currently installed dependencies and shared library build; isolates frontend code changes. No runtime latency or model claims.','baseline':measure(scratch/'apps/web/dist'),'current':measure(repo/'apps/web/dist')}
args.out.write_text(json.dumps(r,indent=2));print(json.dumps(r))
