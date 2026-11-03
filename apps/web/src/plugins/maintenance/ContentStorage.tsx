import { moteText } from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import {useMaintenanceController,useMaintenanceSnapshot,useMaintenanceWatch} from './hooks';

export function ContentStorage({api,onChange}:{api:Api;onChange?:()=>void}) {
  const controller=useMaintenanceController(api);
  useMaintenanceWatch(controller,'content');
  const snapshot=useMaintenanceSnapshot(controller),state=snapshot.content.data;
  const error=snapshot.contentError||(snapshot.content.error!==undefined?errorMessage(snapshot.content.error):'');
  const busy=snapshot.contentBusy,running=state?.job.state==='running';
  return <section className="owner-section content-storage" aria-labelledby="content-storage-title">
    <h2 id="content-storage-title">{moteText('内容保存')}</h2>
    <label className="check-field"><input type="checkbox" role="switch" aria-label={moteText('加密后续图片与原件')} checked={state?.enabled??false} disabled={!state||busy||running}
      onChange={event=>void controller.setContentEnabled(event.target.checked,onChange)}/><span><strong>{moteText('加密后续图片与原件')}</strong><small>{!state?moteText('正在读取…'):state.enabled?moteText('当前：加密保存'):moteText('当前：明文保存')}</small></span></label>
    <details className="owner-disclosure"><summary>{moteText('已有文件与加密范围')}</summary>
    <p className="fine-print">{moteText("开关立即生效，已有文件保持原格式并可继续读取。记录正文和索引存储在 SQLite 中；客户端的本地存储可在各自开发者选项中设置。")}</p>
    <div className="diagnostics-actions">
      <button className="button primary" disabled={!state||state.enabled||busy||running} onClick={()=>void controller.decrypt(onChange)}>{moteText("一次性批量解密")}</button>
      {running&&<button className="button subtle" disabled={busy} onClick={()=>void controller.cancelDecrypt(onChange)}>{moteText("取消解密")}</button>}
    </div>
    <p className="fine-print">{moteText("关闭上方加密后，可将已有图片、原件和待上传分片逐项转换为明文。任务在后台运行，离开页面仍会继续；取消后保留已完成结果，可再次运行。连接凭据不参与转换。")}</p>
    </details>
    {!state&&!error&&<p role="status">{moteText("正在读取存储设置…")}</p>}
    {state&&state.job.state!=='idle'&&<div role="status" aria-live="polite">
      {running?moteText("正在解密"):state.job.state==='cancelled'?moteText("已取消"):moteText("处理完成")}{' '}{moteText("· 已检查")}{' '}{state.job.processed}/{state.job.total}{' '}{moteText("项 · 已转换")}{' '}{state.job.converted}{' '}{moteText("项 · 无需转换")}{' '}{state.job.skipped}{' '}{moteText("项 · 失败")}{' '}{state.job.failed}{' '}{moteText("项")}{running&&<progress aria-label={moteText("批量解密进度")} value={state.job.processed} max={Math.max(1,state.job.total)}/>}
      {state.job.failed>0&&<p>{moteText("失败项保留原文件，请检查原密钥和存储空间后重试。")}</p>}
    </div>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    {error&&<button className="button subtle" disabled={busy} onClick={()=>controller.reloadContent()}>{moteText('重新读取')}</button>}
  </section>;
}
