import type {DatabaseSync} from 'node:sqlite';
export interface NativeApplicationBackupDescriptor {paths:string[];controls:Array<{package_id:string;installation_id:string;instance_id:string;key:string;json:string;bytes:number;revision:number;updated_at:string;value:{version:1;identity:string;accepted?:string;pending?:string;writer?:{pid:number;token:string}}}>;}
export function safeNativeApplicationBackupPath(path:string):boolean;
export function assertNativeApplicationBackupLock(path:string):Promise<string>;
export function nativeApplicationBackup(source:string,db:DatabaseSync,options?:{dataKey?:string}):Promise<NativeApplicationBackupDescriptor>;
export function sanitizeNativeApplicationSnapshot(db:DatabaseSync,descriptor:NativeApplicationBackupDescriptor):void;
