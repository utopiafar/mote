/** Presentation based only on observed app identity and time, never inferred intent. */
export const CAPTURE_SESSION_GAP_MS = 5 * 60_000;
export interface SessionSample {
  id: string; deviceId: string; appId: string; appName: string; capturedAt: string; hasImage: boolean;
}
export interface CaptureSession {
  id: string; deviceId: string; appId: string; appName: string;
  firstAt: string; capturedAt: string; after: string; before: string;
  count: number; imageCount: number;
}
/** Group before pagination or app filtering: A → B → A is three sessions. */
export function captureSessions(samples: Iterable<SessionSample>): CaptureSession[] {
  const rows = [...samples].sort((a,b) => a.deviceId.localeCompare(b.deviceId) || Date.parse(a.capturedAt)-Date.parse(b.capturedAt) || a.id.localeCompare(b.id));
  const sessions: CaptureSession[] = [];
  let current: CaptureSession | undefined;
  for (const row of rows) {
    const at = Date.parse(row.capturedAt);
    if (!Number.isFinite(at)) throw new Error('Invalid session sample time');
    if (!current || current.deviceId !== row.deviceId || !row.appId || current.appId !== row.appId || at-Date.parse(current.capturedAt)>CAPTURE_SESSION_GAP_MS) {
      current = {id:row.id,deviceId:row.deviceId,appId:row.appId,appName:row.appName,firstAt:row.capturedAt,capturedAt:row.capturedAt,after:new Date(at).toISOString(),before:new Date(at+1).toISOString(),count:0,imageCount:0};
      sessions.push(current);
    }
    current.capturedAt=row.capturedAt;current.before=new Date(at+1).toISOString();current.count++;current.imageCount+=Number(row.hasImage);
  }
  return sessions.sort((a,b)=>Date.parse(b.firstAt)-Date.parse(a.firstAt)||a.id.localeCompare(b.id));
}
