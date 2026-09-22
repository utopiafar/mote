/** Immutable host measurements accompanying one generated review. Gaps describe
 * absent sampling only; they never establish inactivity or actual work time. */
export type InsightSnapshot={
 schemaVersion:1;id:string;seriesId:string;version:number;previousRunId?:string;asOf:string;
 scope:{after?:string;before:string;deviceId?:string;timeZone:string};watermark:number;scopeFingerprint:string;
 coverage:{records:number;referenceOnlyRecords:number;pendingProcessing:number;
  sourceStates:{id:string;state:string;lastSyncAt?:string}[];
  measured:{observedDurationMs:number;deviceDurationMs:number;overlapDurationMs:number;unobservedDurationMs:number|null;accounting:'union_across_devices';coverage:'observed_intervals_only'};
  limitations:string[];
 };
};
