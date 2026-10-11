export const HINDSIGHT_BACKUP_IMAGE:string;
export function snapshotHindsight(options:{runtimeDirectory:string;providerDirectory:string;destination:string}):Promise<unknown>;
export function restoreHindsight(options:{archiveDirectory:string;runtimeDirectory:string;providerDirectory:string}):Promise<{
 runtime:{version:1;image:string;identity:string;modelFingerprint:string;instanceFingerprint:string};
 volume:string;
 automaticWork:false;
 credentialsRequired:true;
}>;
