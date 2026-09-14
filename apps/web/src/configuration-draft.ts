import type {ServerConfiguration} from '@mote/shared';
export type DraftValues = Record<string, string>;
export function effectiveValues(config: ServerConfiguration): DraftValues {
  return Object.fromEntries(config.groups.flatMap(group => group.fields).filter(field => field.envVar && field.visibility !== 'secret-status').map(field => [field.envVar!, field.unit === 'bytes' && typeof field.value === 'number' ? String(field.value / 1048576) : Array.isArray(field.value) ? field.value.join(',') : typeof field.value === 'boolean' ? field.value ? '1' : '0' : String(field.value ?? '')]));
}
/** A config fragment, never a shell script. Literal newlines are rejected to prevent extra variables. */
export function environmentFragment(changes: DraftValues): string {
  const rows = Object.entries(changes).map(([key, value]) => {
    if (!/^MOTE_[A-Z0-9_]+$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('配置值不能包含换行或控制字符。');
    if (!value.includes("'")) return `${key}='${value}'`;
    if (!value.includes('"')) return `${key}="${value}"`;
    throw new Error('配置值不能同时包含两种引号，请在部署机器中手动设置该项。');
  });
  return '# Mote configuration changes — merge into the existing deployment .env file.\n# Restart that node to apply. Do not replace the entire existing file.\n' + rows.join('\n') + '\n';
}
