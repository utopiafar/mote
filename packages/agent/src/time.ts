/** Explicit display time for evidence; storage and filtering continue to use UTC. */
export function displayTime(instant: string, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
    timeZoneName:'longOffset',
  }).formatToParts(new Date(instant));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}
