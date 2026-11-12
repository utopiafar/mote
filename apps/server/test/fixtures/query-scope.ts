/** Generated examples for consumers of the currently defined time/device
 * history bounds. Source/root and all/selection examples await the shared DTO. */
export const selectedHistoryScope={deviceId:'generated-device',after:'2026-10-01T00:00:00Z',before:'2026-10-10T00:00:00Z'};
export const permittedHistoryScopes=[
  {...selectedHistoryScope},
  {deviceId:selectedHistoryScope.deviceId,after:'2026-10-01T08:00:00+08:00',before:'2026-10-09T00:00:00Z'},
  {deviceId:selectedHistoryScope.deviceId,after:'2026-10-02T00:00:00Z',before:selectedHistoryScope.before},
];
export const deniedHistoryScopes=[
  {},{...selectedHistoryScope,deviceId:'other-device'},
  {deviceId:selectedHistoryScope.deviceId,before:selectedHistoryScope.before},
  {deviceId:selectedHistoryScope.deviceId,after:selectedHistoryScope.after},
  {...selectedHistoryScope,after:'2026-09-30T23:59:59Z'},
  {...selectedHistoryScope,before:'2026-10-10T00:00:01Z'},
  {...selectedHistoryScope,after:'invalid'},
  {...selectedHistoryScope,after:selectedHistoryScope.before},
];
