import type {DatabaseSync} from 'node:sqlite';
export function safePluginBackupPath(name:string):boolean;
export function canonicalNativeExport(binding:unknown,controlMemories:unknown[],records:unknown[],providers:unknown[]):unknown;
export function pluginMemoryBackup(source:string,db:DatabaseSync):Promise<{
 paths:string[];
 databases:string[];
 providers:unknown[];
 nativeSnapshots:{runtimeDirectory:string;providerDirectory:string;relative:string}[];
 canonical?:unknown;
 canonicalFromNative?:{binding:unknown;controlMemories:unknown[];relative:string};
}>;
