/** Explicit pins are followed continuously. Discovery snapshots follow provider activity. */
export interface LarkSelection {
  documents:string[];calendarIds:string[];pastDays:number;futureDays:number;timeZone:string;autoSync:boolean;
  /** Omitted on an existing selection means discovery was not authorized. */
  documentDiscovery?:{created:boolean;edited:boolean;opened:boolean;firstSyncDays:number};
  folders?:string[];wikiRoots?:string[];excludedDocuments?:string[];
}
export interface LarkDocumentSyncStatus {sourceId?:string;confirmed?:boolean;preview?:Array<{reference:string;title?:string}>;previewTotal?:number;previewAt?:string;documents:number;activities:number;failed:number;pending:number;errors:Array<{reference:string;code:string}>;lastAttemptAt?:string}
export interface LarkJob {id:string;kind:'install'|'setup'|'configure'|'login'|'selection'|'preview'|'sync';state:'running'|'waiting'|'completed'|'failed'|'cancelled';authorizationUrl?:string;expiresAt?:string;error?:string;result?:{imported:number;duplicates:number;discovered?:number;activities?:number;documentFailures?:number}}
export interface LarkStatus {installed:boolean;version?:string;configured:boolean;connected:boolean;accountName?:string;missingScopes:string[];calendarWriteAuthorized?:boolean;selection:LarkSelection;job?:LarkJob;lastSyncAt?:string;error?:string;documentSync?:LarkDocumentSyncStatus;syncIntervalSeconds?:number}
export interface LarkCalendar {id:string;name:string;primary:boolean}
