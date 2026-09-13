import { join } from 'node:path';
import { defaultConfig, isLoopback, updateConfig, validateServerUrl } from './config';
import type { Config } from './contracts';

export interface DesktopProfile { name: string; legacy: boolean; dataDirectory: string; defaultServerUrl: string }
/** Resolve before Electron acquires its instance lock or creates a browser session. */
export function resolveProfile(argv: readonly string[], env: NodeJS.ProcessEnv, legacyDirectory: string): DesktopProfile {
  const selected: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('请为 --profile 指定环境短名');
      selected.push(argv[++i]);
    } else if (argv[i].startsWith('--profile=')) selected.push(argv[i].slice('--profile='.length));
  }
  if (selected.length > 1) throw new Error('只允许指定一个 profile');
  const name = selected[0] ?? env.MOTE_PROFILE ?? 'legacy';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Profile 需为 1–32 个小写字母、数字、下划线或连字符');
  const legacy = name === 'legacy';
  return { name, legacy, dataDirectory: legacy ? legacyDirectory : join(`${legacyDirectory}-profiles`, name),
    defaultServerUrl: `http://127.0.0.1:${legacy || name === 'prod' ? 47832 : name === 'test' ? 47852 : 47842}` };
}
/** Environment is a bootstrap for a new profile. Saved node credentials always stay together. */
export function profileDefaults(profile: DesktopProfile, env: NodeJS.ProcessEnv): Config {
  const config = defaultConfig();
  const sameProfile = env.MOTE_PROFILE === profile.name || (profile.legacy && !env.MOTE_PROFILE);
  config.serverUrl = validateServerUrl((sameProfile && env.MOTE_URL) || profile.defaultServerUrl);
  const origin = new URL(config.serverUrl);
  if (!profile.legacy && profile.name !== 'prod' && isLoopback(origin.hostname) && origin.port === '47832') {
    throw new Error('开发或测试环境不能自动连接日常节点 47832；请使用独立节点，或在应用设置中明确配置');
  }
  // A command-line profile override must not inherit the previous profile's credentials.
  config.token = sameProfile && env.MOTE_URL && env.MOTE_TOKEN ? env.MOTE_TOKEN : undefined;
  return updateConfig(config, config);
}
