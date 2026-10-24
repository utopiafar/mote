#!/usr/bin/env python3
"""Create a self-contained review page from preserved HTML, without rebuilding it."""
from pathlib import Path
import base64
import hashlib
import json

p = Path(__file__).resolve().parent
labels = {0: 'R0 · 源码重建基线', 9: 'R9 · 功能展开', 12: 'R12 · 桌面任务完善', 15: 'R15 · 空态与继续整理'}
records = []
for number, title in labels.items():
    raw = (p / f'dist/rounds/r{number:02}.html').read_bytes()
    records.append({'round': number, 'title': title, 'sha256': hashlib.sha256(raw).hexdigest(),
                    'html': base64.b64encode(raw).decode('ascii')})

shell = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mote · UI 候选对照</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#292723;background:#eae7e1}
header{padding:14px 24px;background:#fffdf9;border-bottom:1px solid #d8d2c8;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
h1{font-size:18px;margin:0}p{margin:3px 0;color:#6e675e}label{display:flex;align-items:center;gap:8px}
select,button{font:inherit;padding:8px 12px;border:1px solid #cfc8bc;border-radius:7px;background:#fffdf9;color:inherit}
select:focus-visible,button:focus-visible{outline:3px solid #aa8adc;outline-offset:2px}.tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-left:auto}
.stage{padding:18px;display:flex;justify-content:center}.frame{width:100%;height:calc(100vh - 150px);min-height:600px;background:white;border:1px solid #d8d2c8;box-shadow:0 4px 18px #30281912;transition:width .15s}
iframe{width:100%;height:100%;border:0}footer{font-size:12px;text-align:center;color:#6e675e;padding:0 16px 12px}
@media(max-width:650px){header{padding:12px}.tools{margin-left:0}.stage{padding:8px}.frame{height:calc(100vh - 200px);min-height:500px}}
</style></head><body>
<header><div><h1>Mote · UI 候选对照</h1><p>保存 4 个阶段，切换后可直接操作。切换候选会重新进入演示。</p></div>
<div class="tools"><label>版本<select id="candidate"></select></label><label>宽度<select id="width"><option value="100%">随窗口</option><option value="1440px">1440</option><option value="768px">768</option><option value="390px">390</option></select></label><button id="reset">重新打开本版</button></div></header>
<main class="stage"><div class="frame" id="frame"><iframe id="preview" sandbox="allow-scripts allow-downloads" title="Mote HTML 交互候选"></iframe></div></main>
<footer>所有数据和连接均为演示状态。R0 为依据源码重建的 HTML；各版本保持已评审的原始字节。<span id="digest"></span></footer>
<script>const candidates=__DATA__;const select=document.getElementById('candidate');
for(const item of candidates){const o=document.createElement('option');o.value=item.round;o.textContent=item.title;select.append(o)}
select.value='15';function openCandidate(){const item=candidates.find(x=>String(x.round)===select.value);const bytes=Uint8Array.from(atob(item.html),c=>c.charCodeAt(0));document.getElementById('preview').srcdoc=new TextDecoder().decode(bytes);document.getElementById('digest').textContent=' SHA-256: '+item.sha256.slice(0,12)+'…';}
select.addEventListener('change',openCandidate);document.getElementById('reset').addEventListener('click',openCandidate);document.getElementById('width').addEventListener('change',e=>{document.getElementById('frame').style.width=e.target.value;document.getElementById('frame').style.maxWidth='100%'});openCandidate();
</script></body></html>'''
output = p / 'dist/mote-ui-comparison.html'
output.write_text(shell.replace('__DATA__', json.dumps(records, ensure_ascii=False, separators=(',', ':'))), encoding='utf-8')
print(json.dumps({'output': str(output), 'bytes': output.stat().st_size,
                  'rounds': list(labels), 'embedded_candidates_keep_original_bytes': True}))
