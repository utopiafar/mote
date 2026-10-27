import { moteText } from '@mote/shared/i18n';
import { useId } from 'react';
import { useResource } from './useResource';
import { DEPLOYMENT_MODEL_PROFILE_ID, type ModelFeature, type ModelSettingsView } from '@mote/shared/models';
import { type Api, errorMessage } from './api';
export function ModelSelector({ api, feature, value, onChange, disabled, model, onModelChange, detachedFromForm }: {
    api: Api;
    feature: ModelFeature;
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
    model?: string;
    onModelChange?: (value: string) => void;
    /** Inside another form, keep the model ID field out of it so Enter or a datalist pick never submits that form. */
    detachedFromForm?: boolean;
}) {
    const settings = useResource<ModelSettingsView>(api, '/api/model-settings'), view = settings.data;
    const profiles = view?.profiles ?? [], defaultId = view?.defaults[feature] ?? DEPLOYMENT_MODEL_PROFILE_ID, selected = profiles.find(p => p.id === defaultId), providerId = value || defaultId;
    const catalog = useResource<{
        items: {
            id: string;
            name: string;
        }[];
    }>(api, onModelChange && view ? `/api/model-settings/profiles/${encodeURIComponent(providerId)}/models` : null), models = catalog.data?.items ?? [];
    const error = settings.error || catalog.error, modelListId = useId();
    const profile = profiles.find(item => item.id === providerId);
    const defaultCaption = moteText("功能默认") + (selected ? ' · ' + selected.name + ((view?.defaultModels[feature] || selected.settings.model) ? ' / ' + (view?.defaultModels[feature] || selected.settings.model) : '') : '');
    const selectionCaption = !value ? defaultCaption : profile ? profile.name + ' · ' + (profile.settings.model || moteText("未配置")) : moteText("配置已不可用，请重新选择");
    const catalogMessage = catalog.error && profile && (!profile.settings.baseUrl || !profile.settings.model) ? moteText("请先在「设置 → 模型与服务 → 模型 Provider」配置服务地址和模型。尚未配置时，模型目录不可读取。") : catalog.error instanceof Error && catalog.error.message === 'model_catalog_unavailable' ? moteText("暂时无法读取服务商模型目录。请检查已配置的地址、凭据和服务商支持情况；也可填写模型 ID。") : errorMessage(error);
    return <label className="model-selector"><span>{moteText("本次模型")}</span><select aria-label={moteText("本次模型")} value={value} disabled={disabled || settings.loading && !view} onChange={e => { onChange(e.target.value); onModelChange?.(''); }}><option value="">{defaultCaption}</option>{value && !profiles.some(p => p.id === value) && <option value={value}>{moteText("配置已不可用，请重新选择")}</option>}{profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {p.settings.model || moteText("未配置")}</option>)}</select><span className="model-selector-selection" aria-hidden="true">{selectionCaption}</span>{onModelChange && <><span>Provider → {moteText("模型")}</span><input aria-label={moteText("临时模型 ID")} form={detachedFromForm ? `${modelListId}-detached` : undefined} placeholder={(!value ? view?.defaultModels[feature] : undefined) || profiles.find(p => p.id === providerId)?.settings.model || moteText("模型 ID")} list={modelListId} disabled={disabled} value={model ?? ''} maxLength={512} onChange={e => onModelChange(e.target.value)}/><datalist id={modelListId}>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist></>}{!!error && <small role="alert">{moteText("无法读取模型列表：")}{catalogMessage}</small>}</label>;
}
