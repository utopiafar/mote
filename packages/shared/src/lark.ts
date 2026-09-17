export interface LarkSelection {documents:string[];calendarIds:string[];pastDays:number;futureDays:number;timeZone:string;autoSync:boolean}
export interface LarkJob {id:string;kind:'install'|'setup'|'configure'|'login'|'selection'|'sync';state:'running'|'waiting'|'completed'|'failed'|'cancelled';authorizationUrl?:string;expiresAt?:string;error?:string;result?:{imported:number;duplicates:number}}
export interface LarkStatus {installed:boolean;version?:string;configured:boolean;connected:boolean;accountName?:string;missingScopes:string[];selection:LarkSelection;job?:LarkJob;lastSyncAt?:string;error?:string}
export interface LarkCalendar {id:string;name:string;primary:boolean}
