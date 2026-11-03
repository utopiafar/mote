import {provideMaintenanceDownload,maintenanceFailure,maintenanceTechnicalFailure} from './maintenance-transfer';
import { getLocale, moteText } from '@mote/shared/i18n';
import { CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";
import { bytes, dateTime, errorMessage, ApiError, type Api, type Status } from "../../api";
import { ErrorNotice } from '../../shell-components';
import {StorageStatistics as StorageDetails} from './StorageStatistics';
import {MaintenanceContext} from './context';
import {useMaintenanceController,useMaintenanceSnapshot,useMaintenanceWatch} from './hooks';
export function Vault({ api, status, refresh, disconnect, embedded = false, children }: {
    children?: ReactNode;
    embedded?: boolean;
    api: Api;
    status: Status;
    refresh: () => void;
    disconnect: () => void;
}) {
    const controller=useMaintenanceController(api,refresh);
    useMaintenanceWatch(controller,'statistics');
    const snapshot=useMaintenanceSnapshot(controller),{transferBusy:busy,transferMessage:message,transferError:error,transferKind:kind}=snapshot,disk=snapshot.statistics;
    const action=(name:string,work:(current:()=>boolean)=>Promise<string>)=>controller.run(name,work);
    const context=useMemo(()=>({controller}),[controller]);
    const input = useRef<HTMLInputElement>(null);
    async function exportArchive(current:()=>boolean,mode?: 'metadata' | 'data') {
        const response = await api.raw(mode ? `/api/export-bundle?mode=${mode}` : "/api/export");
        return provideMaintenanceDownload(response,mode?`mote-${mode}.tar.gz`:`mote-${new Date().toISOString().slice(0,10)}.json`,current);
    }
    async function importFile(file?: File) {
        if (!file)
            return;
        let canClear:()=>boolean=()=>true;
        await action("import", async current => {
            canClear=current;
            const raw = await file.text();
            if(!current())return "";
            const archive = JSON.parse(raw);
            const sections = ['captures', 'sources', 'sourceHeads', 'sourceVersions', 'memories', 'memoryDeletions', 'files', 'captureFiles', 'perceptionResults', 'todos'];
            if (!archive || archive.version !== 2 || !sections.every(key => Array.isArray(archive[key])))
                throw new Error(moteText("请选择 Mote v2 JSON 归档文件。"));
            const result = await api.request<{
                imported: number;
                duplicates: number;
            }>("/api/import", { method: "POST", body: raw });
            if(!Number.isSafeInteger(result.imported)||result.imported<0||!Number.isSafeInteger(result.duplicates)||result.duplicates<0)
                throw new ApiError(moteText('中央响应格式无效，请刷新后重试。'),200,undefined,'invalid_response');
            return moteText("已导入 {0} 条记录，跳过 {1} 条重复记录。", result.imported, result.duplicates);
        });
        if (canClear()&&input.current)
            input.current.value = "";
    }
    const storage=status.storage;
    return <MaintenanceContext.Provider value={context}><div className="vault-content">
      {!embedded&&<h1>{moteText('存储与备份')}</h1>}
      {Boolean(error)&&<><ErrorNotice text={maintenanceFailure(error)}/><details className="owner-disclosure"><summary>{moteText("技术详情")}</summary><pre>{maintenanceTechnicalFailure(error)}</pre></details></>}
      {message&&<p className={kind==='import'?'notice success':'notice'} role="status">{kind==='import'&&<CheckCircle2 size={16}/ >}{message}</p>}
      <div className="owner-metrics owner-storage-metrics">
        <div><span>{moteText('中心已使用')}</span><strong>{!disk.error&&disk.data?bytes(disk.data.bytes):'—'}</strong><small role={disk.error?'alert':undefined}>{disk.error?errorMessage(disk.error):disk.data?.skipped?moteText('部分文件无法读取，统计可能不完整。'):disk.loading?moteText('正在读取…'):moteText('文件与模型 · 当前占用')}</small></div>
        <div><span>{moteText('资料保存')}</span><strong className="owner-metric-text">{status.retentionDays?moteText('{0} 天',status.retentionDays):moteText('持续保留')}</strong><small>{status.retentionDays?moteText('保留周期'):moteText('未启用自动删除')}</small></div>
        <div><span>{moteText('检索方式')}</span><strong className="owner-metric-text">{status.index.mode==='hybrid'?moteText('全文 + 向量检索'):moteText('文本检索')}</strong><small>{status.index.model||moteText('可选择配置 Embedding 模型')}</small></div>
      </div>
      <section className="owner-section transfer-panel"><h2>{moteText('备份与迁移')}</h2>
        <div className="owner-row"><div><h3>{moteText('导出资料')}</h3><p>{moteText('记录、影像和校验信息')}</p></div><button className="button" disabled={!!busy} onClick={()=>void action('export',current=>exportArchive(current))}>{busy==='export'?<LoaderCircle size={16} className="spin"/>:moteText('导出')}</button></div>
        <div className="owner-row"><div><h3>{moteText('导入 Mote 归档')}</h3><p>{moteText('合并记录，跳过重复内容')}</p></div><button className="button" disabled={!!busy} onClick={()=>input.current?.click()}>{busy==='import'?<LoaderCircle size={16} className="spin"/>:moteText('选择归档')}</button><input ref={input} className="hidden" type="file" accept="application/json,.json" aria-label={moteText('导入 Mote 归档')} onChange={event=>void importFile(event.target.files?.[0])}/></div>
        <details className="owner-disclosure"><summary>{moteText('大资料库与完整运行备份')}</summary><p className="fine-print">{moteText('网页导出受中央节点归档大小限制。需要完整备份或迁移加密数据时，在中央节点运行：')}</p><code>npm run backup -- --help</code><div className="diagnostics-actions"><button className="button" disabled={!!busy} onClick={()=>void action('export',current=>exportArchive(current,'metadata'))}>{moteText('导出元数据')}</button><button className="button" disabled={!!busy} onClick={()=>void action('export',current=>exportArchive(current,'data'))}>{moteText('导出资料与附件')}</button></div></details>
      </section>
      {children}
      <details className="owner-disclosure"><summary>{moteText('存储空间明细')}</summary>
        <StorageDetails api={api} embedded onUsage={()=>{window.location.hash='#/system/usage';}}/>
        <dl className="storage-stats"><div><dt>{moteText('上下文记录')}</dt><dd>{storage.captures.toLocaleString(getLocale())}</dd></div><div><dt>{moteText('独立影像对象')}</dt><dd>{storage.blobs.toLocaleString(getLocale())}</dd></div><div><dt>{moteText('影像原始大小')}</dt><dd>{bytes(storage.imageBytes)}</dd></div><div><dt>{moteText('最早记录')}</dt><dd>{storage.firstCaptureAt?dateTime(storage.firstCaptureAt):moteText('尚无记录')}</dd></div></dl>
        <p className="fine-print">{moteText('相同影像共享一份存储，每次采样仍保留独立观察记录。')}{storage.imageCaptures!==undefined&&moteText('已复用 {0} 次影像。',Math.max(0,storage.imageCaptures-storage.blobs))}</p><a href="#/system" className="text-button">{moteText('按文件类型')} · {moteText('按日期')} →</a>
      </details>
      <details className="owner-disclosure"><summary>{moteText('高级：保留与容量')}</summary>
      <div><h3>{moteText('检索索引')}</h3><p>{status.index.model||moteText('文本检索')}</p><div className="index-statuses">{storage.indexing.map(row=><span key={row.status}>{({pending:moteText('等待索引'),indexed:moteText('已建立向量索引'),text_ready:moteText('文本就绪'),failed:moteText('索引失败')} as Record<string,string>)[row.status]||row.status} <strong>{row.count}</strong></span>)}</div>
        <button className="button" disabled={!!busy||status.index.mode!=='hybrid'} onClick={()=>void action('retry',async()=>{const result=await api.request<{queued:number}>('/api/index/retry',{method:'POST',body:'{}'});return moteText('已将 {0} 条记录加入索引队列。',result.queued);})}><RefreshCw size={14} className={busy==='retry'?'spin':''}/>{moteText('重试索引')}</button><a className="text-button" href="#/system/models?category=embedding">{moteText('检索索引')} →</a>
      </div>
      <p>{moteText('存储空间')} {bytes(storage.bytes)}{storage.maxBytes?'/ '+bytes(storage.maxBytes):''}</p><p>{status.retentionDays?moteText('{0} 天',status.retentionDays):moteText('持续保留 · 未启用自动删除')}</p><a className="text-button" href="#/system/models?category=storage">{moteText('保留与容量')} →</a><dl><dt>{moteText('推理模型')}</dt><dd>{status.agent.model||moteText('尚未配置')}</dd><dt>{moteText('自动回顾')}</dt><dd>{status.insightIntervalHours?moteText('每 {0} 小时且有足够新增资料',status.insightIntervalHours):moteText('手动生成')}</dd></dl><p className="fine-print">{moteText('当前服务（中央节点）')} · {window.location.origin}</p><button className="text-button" onClick={disconnect}>{moteText('退出登录')}</button></details>
    </div></MaintenanceContext.Provider>;
}
