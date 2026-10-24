#!/usr/bin/env python3
"""Build review galleries from frozen three-surface candidates and real reports."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SURFACES = ("web", "mac", "android")


def safe_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def gather(allow_partial: bool) -> list[dict]:
    rounds = []
    for n in range(20, 30):
        folder = ROOT / "rounds" / f"r{n}"
        if not (folder / "manifest.json").exists():
            if allow_partial:
                continue
            raise SystemExit(f"Missing frozen round: R{n}")
        manifest = json.loads((folder / "manifest.json").read_text())
        for platform in SURFACES:
            data = (folder / f"{platform}.html").read_bytes()
            if hashlib.sha256(data).hexdigest() != manifest["candidates"][platform]["sha256"]:
                raise SystemExit(f"Frozen checksum mismatch: R{n} {platform}")
        changes = json.loads((folder / "changes.json").read_text())
        report_path = folder / "reports/independent-evaluation.json"
        evaluation = json.loads(report_path.read_text()) if report_path.exists() else None
        rounds.append({"round": n, "manifest": manifest, "changes": changes, "evaluation": evaluation,
                       "evaluationPath": f"../rounds/r{n}/reports/independent-evaluation.json" if evaluation else None})
    if not rounds:
        raise SystemExit("No frozen candidates available")
    return rounds


TEMPLATE = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mote · 三端 UI 迭代档案</title>
<style>
:root{color-scheme:light;--ink:#25252b;--muted:#77747c;--line:#dedbe4;--paper:#fff;--base:#f5f4f7;--accent:#7654a5}*{box-sizing:border-box}body{margin:0;background:var(--base);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}button,select{font:inherit}button,select,a{outline-offset:4px}button{cursor:pointer}a{color:var(--accent);text-decoration:none}header{padding:28px 32px 20px;background:var(--paper);border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;color:var(--accent);font-weight:650;letter-spacing:.08em}h1{font-size:27px;line-height:1.35;margin:8px 0;font-weight:650;letter-spacing:-.7px}p{margin:7px 0;color:var(--muted)}.headrow,.row,.controls,.links{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.headrow{justify-content:space-between}.chip{padding:4px 9px;border-radius:100px;font-size:12px;background:#efeaf6;color:#69488d}.links a{font-size:12px}.controls{padding:14px 32px;background:var(--paper);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}.controls label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px}.controls select,.controls button{background:white;border:1px solid var(--line);border-radius:7px;padding:7px 10px;color:var(--ink);min-height:38px}.controls .tabs{display:flex;gap:3px;border:1px solid var(--line);padding:3px;border-radius:9px}.tabs button{border:0;min-height:32px;padding:4px 12px}.tabs button[aria-pressed=true]{background:#ece5f5;color:#5d387f}.content{padding:22px 24px 35px}.summary{display:grid;grid-template-columns:1.5fr 1fr;gap:20px;background:white;border:1px solid var(--line);border-radius:12px;padding:20px 23px;margin:0 8px 22px}.summary h2{font-size:17px;margin:0 0 8px}.summary p{font-size:13px}.summary ul{margin:8px 0 0;padding-left:19px;color:#5e5968;font-size:13px}.meta{font-size:12px;color:var(--muted);margin-top:10px}.scorebox{border-left:1px solid var(--line);padding-left:22px}.scorebox h3{font-size:13px;margin:0 0 12px}.scoreline{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:5px 0}.scoreline strong{font-variant-numeric:tabular-nums;color:#51405e}.canvas{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;align-items:start}.surface-card{min-width:0;background:white;border:1px solid var(--line);border-radius:12px;overflow:hidden}.surface-title{padding:13px 15px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);font-size:14px}.surface-title strong{font-weight:650}.surface-title small{display:block;color:var(--muted);font-size:11px}.surface-title a{font-size:12px}.frame-stage{overflow:hidden;position:relative;background:#ebe8ed}.frame-stage iframe{border:0;display:block;transform-origin:top left;background:white}.surface-foot{padding:10px 15px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);overflow-wrap:anywhere}.canvas.solo{display:block}.canvas.solo .surface-card{max-width:1442px;margin:auto}.canvas.solo.android .surface-card{max-width:430px}.canvas.solo.mac .surface-card{max-width:1282px}.archive{margin:30px 8px 0;background:white;border:1px solid var(--line);border-radius:12px;overflow:hidden}.archive h2{font-size:17px;margin:18px 20px}.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;border-top:1px solid var(--line);padding:11px 18px;vertical-align:top}th{font-weight:550;color:var(--muted);background:#fbfafc}td:first-child{white-space:nowrap}.roundlink{border:0;background:#efeaf6;color:#68448c;padding:4px 10px;border-radius:6px;cursor:pointer}.archive td a{margin-right:10px;white-space:nowrap}.footer{margin:20px 8px;color:var(--muted);font-size:12px}.hidden{display:none!important}@media(max-width:950px){.canvas{grid-template-columns:1fr}.surface-card{max-width:800px;width:100%;margin:auto}.surface-card[data-surface=android]{max-width:430px}.summary{grid-template-columns:1fr}.scorebox{border:0;border-top:1px solid var(--line);padding:15px 0 0}.controls{position:static;padding:12px 18px}header{padding:22px 20px}.content{padding:18px 10px}.summary{padding:18px}.controls .tabs{width:100%;justify-content:space-between}}@media(prefers-reduced-motion:no-preference){button,a{transition:background .15s,color .15s}}
</style></head><body>
<header><div class="headrow"><div><div class="eyebrow">MOTE / UI ITERATION ARCHIVE</div><h1>三个端，一套清楚的使用逻辑</h1><p>逐轮查看 Web、Mac 和 Android 的 HTML 交互原型。每轮候选独立保存，评估记录与对应版本绑定。</p></div><span class="chip" id="archiveCount"></span></div><div class="links"><a href="../final-report.md">完整报告</a><a href="../rubric-independent.md">六维评估指标</a><a href="../README.md">交付索引</a></div><p class="review-note">评审提示：R27–R29 Web 的“服务器文件夹持续接收”为额外设计提案。仓库当前的普通浏览器用户可一次导入选定文件或文件夹。<a href="../context/known-proposal-gaps.md">查看与现有能力的差异</a></p></header>
<div class="controls"><label>迭代版本<select id="round"></select></label><label>初始状态<select id="state"><option value="empty">新用户 · 空白资料库</option><option value="populated">已有资料 · 日常使用</option></select></label><label>外观<select id="theme"><option value="light">浅色</option><option value="dark">深色</option></select></label><div class="tabs" role="group" aria-label="预览端"><button data-mode="all" aria-pressed="true">三端并排</button><button data-mode="web" aria-pressed="false">Web</button><button data-mode="mac" aria-pressed="false">Mac</button><button data-mode="android" aria-pressed="false">Android</button></div><button id="restart">重新载入本轮</button></div>
<main class="content"><section class="summary"><div><h2 id="roundTitle"></h2><p id="roundSummary"></p><ul id="changeList"></ul><div class="meta" id="freezeTime"></div></div><div class="scorebox"><h3>独立评估记录</h3><div id="scores"></div><div class="meta"><a id="reportLink">查看原始评估 JSON</a></div></div></section><div class="canvas" id="canvas"></div><section class="archive"><h2>完整的逐轮候选</h2><div class="tablewrap"><table><thead><tr><th>轮次</th><th>本轮修改</th><th>三个端的原型</th><th>评估</th></tr></thead><tbody id="archiveRows"></tbody></table></div></section><p class="footer">视图可以点击操作。并排时按真实视口等比例缩放；选择单个端可放大查看。原型采用合成数据，各轮与各端的会话状态相互隔离。</p></main>
<script type="application/json" id="archiveData">__DATA__</script><script type="application/json" id="embeddedSources">__SOURCES__</script><script type="application/json" id="portableAttachments">__ATTACHMENTS__</script><script type="application/json" id="buildStatus">__BUILD_STATUS__</script>
<script>
'use strict';const records=JSON.parse(document.getElementById('archiveData').textContent),embedded=JSON.parse(document.getElementById('embeddedSources').textContent),attachments=JSON.parse(document.getElementById('portableAttachments').textContent),buildStatus=JSON.parse(document.getElementById('buildStatus').textContent);let current=records[records.length-1],mode='all',generation=0;const names={web:'Web 工作台',mac:'Mac 客户端',android:'Android 客户端'},sizes={web:[1440,1000],mac:[1280,900],android:[390,844]};const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function summary(record){return record.changes.summary||record.changes.title||record.changes.purpose||record.changes.goal||'本轮候选与评估已单独保存。'}function updates(record){const value=record.changes.changes||record.changes.updates||record.changes.fixes||[];return Array.isArray(value)?value.map(x=>typeof x==='string'?x:x.summary||x.change||x.title||JSON.stringify(x)):Object.entries(value).map(([k,v])=>k+'：'+(typeof v==='string'?v:JSON.stringify(v)));}function scores(record){const ev=record.evaluation;if(!ev)return '<p>候选已冻结；独立评估记录尚未写入。</p>';const p=ev.platforms||ev.platform_scores||{};return ['web','mac','android'].map(id=>{const v=p[id]||{},total=v.weighted_total??v.total??v.score??v.weighted_score;return '<div class="scoreline"><span>'+names[id]+'</span><strong>'+(typeof total==='number'?total.toFixed(1)+' / 100':'已有独立记录')+'</strong></div>';}).join('');}function candidateUrl(record,id){return '../rounds/r'+record.round+'/'+id+'.html';}function bindPortableLinks(){if(!Object.keys(embedded).length)return;document.querySelectorAll('a[href]').forEach(a=>{const raw=a.getAttribute('href'),att=attachments[raw],match=raw.match(/rounds\/r(\d+)\/(web|mac|android)\.html/);if(att){a.href=URL.createObjectURL(new Blob([att.body],{type:att.mime}));a.download=att.name;}else if(match&&embedded['r'+match[1]+'/'+match[2]]){a.href=URL.createObjectURL(new Blob([embedded['r'+match[1]+'/'+match[2]]],{type:'text/html'}));}else if(raw.startsWith('../')&&!a.classList.contains('open-original')){a.removeAttribute('href');a.title='此文件收录在完整下载包中';}});}function query(){return '?state='+document.getElementById('state').value+'&theme='+document.getElementById('theme').value+'&reset=1';}function scaleFrames(){document.querySelectorAll('.surface-card').forEach(card=>{const stage=card.querySelector('.frame-stage'),frame=stage.querySelector('iframe'),size=sizes[card.dataset.surface],scale=Math.min(1,stage.clientWidth/size[0]);frame.style.width=size[0]+'px';frame.style.height=size[1]+'px';frame.style.transform='scale('+scale+')';stage.style.height=(size[1]*scale)+'px';if(scale===1&&stage.clientWidth>size[0])frame.style.marginLeft=((stage.clientWidth-size[0])/2)+'px';else frame.style.marginLeft='0';});}function render(){generation++;document.getElementById('roundTitle').textContent='R'+current.round+' · 三端候选';document.getElementById('roundSummary').textContent=summary(current);document.getElementById('changeList').innerHTML=updates(current).slice(0,5).map(x=>'<li>'+esc(x)+'</li>').join('');document.getElementById('freezeTime').textContent='冻结时间：'+new Date(current.manifest.frozen_at_utc).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）';document.getElementById('scores').innerHTML=scores(current);const report=document.getElementById('reportLink');report.classList.toggle('hidden',!current.evaluationPath);if(current.evaluationPath)report.href=current.evaluationPath;const canvas=document.getElementById('canvas');canvas.className='canvas'+(mode==='all'?'':' solo '+mode);const platforms=mode==='all'?['web','mac','android']:[mode];canvas.innerHTML=platforms.map(id=>'<section class="surface-card" data-surface="'+id+'"><div class="surface-title"><div><strong>'+names[id]+'</strong><small>'+sizes[id][0]+' × '+sizes[id][1]+' · R'+current.round+'</small></div><a class="open-original" data-surface="'+id+'" href="'+candidateUrl(current,id)+query()+'" target="_blank" rel="noopener">独立打开 ↗</a></div><div class="frame-stage"><iframe title="'+names[id]+' R'+current.round+'" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"></iframe></div><div class="surface-foot">SHA-256 '+esc(current.manifest.candidates[id].sha256.slice(0,24))+'…</div></section>').join('');for(const card of canvas.children){const id=card.dataset.surface,frame=card.querySelector('iframe'),source=embedded['r'+current.round+'/'+id];if(source){const configured=source.replaceAll('new URLSearchParams(location.search)','new URLSearchParams('+JSON.stringify(query())+')');frame.srcdoc=configured;const blob=new Blob([configured],{type:'text/html'});card.querySelector('.open-original').href=URL.createObjectURL(blob);}else frame.src=candidateUrl(current,id)+query()+'&view='+generation;frame.addEventListener('load',scaleFrames);}document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));scaleFrames();bindPortableLinks();}document.getElementById('archiveCount').textContent=(buildStatus.partial?'阶段预览 · ':'')+records.length+' 轮 · '+(records.length*3)+' 个冻结候选';document.getElementById('round').innerHTML=records.map(r=>'<option value="'+r.round+'" '+(r===current?'selected':'')+'>R'+r.round+'</option>').join('');document.getElementById('archiveRows').innerHTML=records.map(r=>'<tr><td><button class="roundlink" data-round="'+r.round+'">R'+r.round+'</button></td><td>'+esc(summary(r))+'</td><td>'+['web','mac','android'].map(id=>'<a href="'+candidateUrl(r,id)+'" target="_blank" rel="noopener">'+names[id]+'</a>').join('')+'</td><td>'+(r.evaluation?'<a href="'+r.evaluationPath+'">独立评估</a>':'待记录')+'</td></tr>').join('');document.getElementById('round').addEventListener('change',e=>{current=records.find(x=>x.round===Number(e.target.value));render();});document.getElementById('state').addEventListener('change',render);document.getElementById('theme').addEventListener('change',render);document.getElementById('restart').addEventListener('click',render);document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;render();}));document.querySelectorAll('[data-round]').forEach(b=>b.addEventListener('click',()=>{current=records.find(x=>x.round===Number(b.dataset.round));document.getElementById('round').value=current.round;render();window.scrollTo({top:0,behavior:'smooth'});}));new ResizeObserver(scaleFrames).observe(document.getElementById('canvas'));render();
</script></body></html>'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-partial", action="store_true")
    parser.add_argument("--embed-all", action="store_true", help="Also create an offline single-file gallery containing every candidate")
    args = parser.parse_args()
    rounds = gather(args.allow_partial)
    build_status = {"partial": len(rounds) < 10 or any(r["evaluation"] is None for r in rounds), "frozen_rounds": len(rounds), "evaluated_rounds": sum(r["evaluation"] is not None for r in rounds)}
    out = ROOT / "dist"
    out.mkdir(exist_ok=True)
    plain = TEMPLATE.replace("__DATA__", safe_json(rounds)).replace("__SOURCES__", "{}").replace("__ATTACHMENTS__", "{}").replace("__BUILD_STATUS__", safe_json(build_status))
    (out / "mote-rounds-gallery.html").write_text(plain)
    attachments = {}
    for name in ("final-report.md", "rubric-independent.md", "README.md", "context/known-proposal-gaps.md"):
        path = ROOT / name
        if path.exists():
            attachments["../" + name] = {"body": path.read_text(), "mime": "text/markdown;charset=utf-8", "name": path.name}
    for record in rounds:
        if record["evaluation"]:
            attachments[record["evaluationPath"]] = {"body": json.dumps(record["evaluation"], ensure_ascii=False, indent=2), "mime": "application/json", "name": f"r{record['round']}-independent-evaluation.json"}
    latest = rounds[-1]
    embedded_final = {f"r{latest['round']}/{s}": (ROOT / "rounds" / f"r{latest['round']}" / f"{s}.html").read_text() for s in SURFACES}
    final = TEMPLATE.replace("__DATA__", safe_json([latest])).replace("__SOURCES__", safe_json(embedded_final)).replace("__ATTACHMENTS__", safe_json(attachments)).replace("__BUILD_STATUS__", safe_json(build_status))
    (out / "mote-three-platforms.html").write_text(final)
    if args.embed_all:
        sources = {f"r{r['round']}/{s}": (ROOT / "rounds" / f"r{r['round']}" / f"{s}.html").read_text() for r in rounds for s in SURFACES}
        portable = TEMPLATE.replace("__DATA__", safe_json(rounds)).replace("__SOURCES__", safe_json(sources)).replace("__ATTACHMENTS__", safe_json(attachments)).replace("__BUILD_STATUS__", safe_json(build_status))
        (out / "mote-rounds-portable.html").write_text(portable)
    for surface in SURFACES:
        (out / f"mote-{surface}-final.html").write_bytes((ROOT / "rounds" / f"r{latest['round']}" / f"{surface}.html").read_bytes())
    outputs = [{"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in out.glob("*.html")]
    (out / "gallery-manifest.json").write_text(json.dumps({"rounds": len(rounds), "candidates": len(rounds)*3, "latest_round": latest["round"], "build_status": build_status, "files": outputs}, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"rounds": len(rounds), "latest_round": latest["round"], "files": outputs}, ensure_ascii=False))


if __name__ == "__main__":
    main()
