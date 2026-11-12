import type {FilePolicy,FileProcessingSettings,ProcessingService,ProcessorParameter} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
export type PublicProcessingService=Omit<ProcessingService,'apiKey'>&{apiKeyConfigured:boolean;apiKey?:string|null};
export type FileSettingsView={revision:string;settings:Omit<FileProcessingSettings,'apiKey'|'localWorkerApiKey'>&{apiKeyConfigured?:boolean;localWorkerApiKeyConfigured?:boolean};policy:Omit<FilePolicy,'services'>&{services:PublicProcessingService[]};policyConfigured:boolean;processors:{id:string;name:string;stage:string;serviceKind?:string;localOnly?:boolean;optionalService?:boolean;mediaTypes:string[];parameters?:ProcessorParameter[];dialogue?:boolean;allowSummary?:boolean}[]};
export function processingProfileLabel(profile:{name:string;processorId:string}){
 if(profile.name!==profile.processorId)return profile.name;
 return ({'audio.local-dialogue':moteText('本地转写与匿名说话人分离'),'audio.http':moteText('使用转写服务'),'text.utf8':moteText('文本提取'),'document.generic':moteText('文档文字提取'),archive:moteText('仅保存原件')} as Record<string,string>)[profile.processorId]??profile.name;
}
