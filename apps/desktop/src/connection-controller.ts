import { moteText } from '@mote/shared/i18n';
import { ConnectionError, ConnectionOnboarding, testConnection } from './connection';
import { agentRuntimeStatusSummary, readAgentRuntimeStatus } from './agent-runtime-status';
import { updateConfig } from './config';
import type { Config, Platform } from './contracts';
import type { ConnectionStatus } from './contracts/connection';
import type { SettingsCoordinator } from './settings-coordinator';

export interface ConnectionDependencies {
  settings(): Config;
  status(): ConnectionStatus;
  installStatus(status: ConnectionStatus): void;
  secretStorageAvailable(): boolean;
  platform: Platform;
  coordinator: Pick<SettingsCoordinator, 'connectionChange' | 'commitConnection'>;
  onboarding: ConnectionOnboarding;
}

/** Invitation confirmation and connection checks, independent of native dialogs and IPC delivery. */
export class ConnectionController {
  constructor(private readonly dependencies: ConnectionDependencies) {}

  async confirm(id: unknown, origin: unknown, deviceName: unknown): Promise<void> {
    const d = this.dependencies;
    await d.coordinator.connectionChange(async () => {
      if (!d.secretStorageAvailable()) throw new Error(moteText('系统加密存储不可用，不能交换并保存凭据'));
      if (typeof deviceName !== 'string') throw new Error('Invalid device name');
      const named = updateConfig(d.settings(), { ...d.settings(), deviceName });
      const result = await d.onboarding.redeem(id, origin, named, d.platform);
      const updated = { ...updateConfig(d.settings(), { ...named, serverUrl: result.serverUrl, token: result.token }), credentialScope: result.scope, authSignedOut: false, authExpiresAt: undefined, authSessionOnly: false };
      const identity = await testConnection(updated);
      if (identity.credential.id !== result.credentialId || identity.credential.scope !== 'owner') throw new Error(moteText('中央凭据身份确认不一致，原连接未修改；请重新生成邀请'));
      await d.coordinator.commitConnection(updated, origin === d.settings().serverUrl, true);
      d.installStatus({ state: 'connected', message: moteText('登录成功，可使用所有中央功能。'), checkedAt: new Date().toISOString(), identity });
    }, origin === d.settings().serverUrl, true);
  }

  async test(): Promise<ConnectionStatus> {
    const d = this.dependencies;
    if (d.status().state === 'checking') return d.status();
    const requested = d.settings(); d.installStatus({ state: 'checking', message: moteText('正在验证已保存连接与权限…') });
    try {
      const identity = await testConnection(requested);
      let runtime = '';
      try { runtime = ' · ' + agentRuntimeStatusSummary(await readAgentRuntimeStatus(requested)); } catch { runtime = ' · ' + moteText('当前生效值') + '：' + moteText('不可用'); }
      if (d.settings() === requested) d.installStatus({ state: 'connected', message: moteText('管理员连接正常 · 可访问完整中央仓库') + runtime, checkedAt: new Date().toISOString(), identity });
    } catch (error) {
      if (d.settings() === requested) d.installStatus({ state: 'error', message: error instanceof ConnectionError ? error.message : moteText('连接检查失败；已保存配置未改变'), checkedAt: new Date().toISOString() });
    }
    return d.status();
  }
}
