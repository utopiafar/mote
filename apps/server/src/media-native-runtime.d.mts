import type {ChildProcess} from 'node:child_process';
export type NativeMediaRole='ocr'|'dialogue'|'local-image';
export interface PreparedMediaRuntime {python:string;version:string;generation:string;created:boolean}
export interface MediaRuntimeOptions {repository:string;directory:string;role:NativeMediaRole;signal?:AbortSignal;allowInstall?:boolean;sourcePython?:string;onStage?:(stage:'dependencies'|'verifying_dependencies')=>void;env?:NodeJS.ProcessEnv}
export function prepareNativeMediaRuntime(options:MediaRuntimeOptions):Promise<PreparedMediaRuntime>;
export function mediaRoleSupported(role:string,platform?:string,arch?:string):boolean;
export function mediaWorkerLaunch(role:NativeMediaRole,options:{repository:string;modelDirectory:string;ocrPort:number;asrPort:number;localImagePort?:number}):string[];
export function mediaWorkerEnvironment(directory:string,python:string,token:string,env?:NodeJS.ProcessEnv):NodeJS.ProcessEnv;
export interface MediaProcess {child:ChildProcess;done:Promise<void>;readonly error?:Error;close():Promise<void>}
export function spawnMediaProcess(command:string,args:string[],options?:{cwd?:string;env?:NodeJS.ProcessEnv;graceMs?:number}):MediaProcess;
