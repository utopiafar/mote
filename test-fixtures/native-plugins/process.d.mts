export interface PrivateProcessOptions {
  version?:string;
  directory?:string;
  healthTimeoutMs?:number;
  stopTimeoutMs?:number;
  entry?:string;
  /** Extra top-level YAML document fields, applied to the first boot and every restart. */
  extraDocument?:Record<string,unknown>;
}
export interface StopOutcome {exited:boolean;code?:number|null;signal?:string|null;forced:boolean;timeout:boolean}
export interface PrivateProcess {
  runId:string;candidateSha:string;version:string;dataDir:string;configFile:string;token:string;
  readonly url:string;readonly output:string;
  metadata():{runId:string;candidateSha:string;version:string};
  request(path:string,options?:{method?:string;body?:unknown;token?:string;headers?:Record<string,string>}):Promise<unknown>;
  writeNote(note:unknown):Promise<unknown>;
  readNote(id:string):Promise<unknown>;
  stop():Promise<StopOutcome>;
  restart():Promise<PrivateProcess>;
  close(options?:{remove?:boolean;strict?:boolean}):Promise<void>;
}
export function createPrivateProcess(options?:PrivateProcessOptions):Promise<PrivateProcess>;
