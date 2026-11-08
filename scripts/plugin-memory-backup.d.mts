import type {DatabaseSync} from 'node:sqlite';
export function safePluginBackupPath(name:string):boolean;
export function pluginMemoryBackup(source:string,db:DatabaseSync):Promise<{
 paths:string[];
 databases:string[];
 providers:unknown[];
}>;
