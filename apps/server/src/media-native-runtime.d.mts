import type {ChildProcess} from 'node:child_process';
export type NativeMediaRole='ocr'|'dialogue'|'local-image';
export interface PreparedMediaRuntime {python:string;version:string;generation:string;created:boolean}
export interface MediaRuntimeOptions {
 repository:string;directory:string;role:NativeMediaRole;signal?:AbortSignal;allowInstall?:boolean;sourcePython?:string;
 onStage?:(stage:'dependencies'|'verifying_dependencies')=>void;env?:NodeJS.ProcessEnv;fetchImpl?:typeof fetch;
 run?:(command:string,args:string[],options?:{env?:NodeJS.ProcessEnv;signal?:AbortSignal;cwd?:string;timeoutMs?:number;maxBytes?:number})=>Promise<Buffer>;
}
export const MEDIA_UV_VERSION:string;
export function nativeMediaPlatform(platform?:string,arch?:string):Readonly<{target:string;bytes:number;sha256:string}>;
export function prepareNativeMediaRuntime(options:MediaRuntimeOptions):Promise<PreparedMediaRuntime>;
export function mediaRoleSupported(role:string,platform?:string,arch?:string):boolean;
export function mediaWorkerLaunch(role:NativeMediaRole,options:{repository:string;modelDirectory:string;ocrPort:number;asrPort:number;localImagePort?:number}):string[];
export function mediaWorkerEnvironment(directory:string,python:string,token:string,env?:NodeJS.ProcessEnv):NodeJS.ProcessEnv;
export interface MediaProcess {child:ChildProcess;done:Promise<void>;readonly error?:Error;close():Promise<void>}
export function spawnMediaProcess(command:string,args:string[],options?:{cwd?:string;env?:NodeJS.ProcessEnv;graceMs?:number}):MediaProcess;
