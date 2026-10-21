from pathlib import Path
import hashlib,json,datetime

root=Path(__file__).resolve().parent.parent
base=root/'dist/r18.html'
before=base.read_text()
assert hashlib.sha256(base.read_bytes()).hexdigest()=='9009f6bb9d2ee17e250c395be9bed21aab4a26670ffe9bebca13f934c2817095'
css='\n/* R19: keep long, user-authored conversation titles inside the history rail. */\n.chat-history .btn[data-action="open-chat"]{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;line-height:1.6;max-width:100%}\n'
assert before.count('</style>')==1 and before.count('const REV = 18;')==1
after=before.replace('</style>',css+'</style>',1).replace('const REV = 18;','const REV = 19;',1)
candidate=root/'dist/r19.html'
if candidate.exists():assert candidate.read_text()==after,'Frozen R19 has different bytes'
else:candidate.write_text(after)
assert after.replace(css,'',1).replace('const REV = 19;','const REV = 18;',1)==before
meta={'round':19,'candidate':'dist/r19.html','sha256':hashlib.sha256(candidate.read_bytes()).hexdigest(),'bytes':candidate.stat().st_size,'base_sha256':hashlib.sha256(base.read_bytes()).hexdigest(),'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'HTML UI only. Narrow visual correction found by blind-r18-c. No feature or state transition changes.','exact_delta':{'added_css':css,'revision_namespace':'18 -> 19'},'evidence_inheritance':'R18 semantic, feature and behavioral observations remain attached to R18; R19 separately verifies long titles and relevant rendered scenes. Same application JavaScript apart from REV is proven by byte reversal.'}
(root/'reports/r19-freeze.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
(root/'work/integration.html').write_text(after)
print(json.dumps({k:meta[k] for k in ['candidate','sha256','bytes','base_sha256']},ensure_ascii=False))
