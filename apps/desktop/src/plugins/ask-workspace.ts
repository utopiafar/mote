/** Mac Ask workspace plugin: owns the Ask controller, its login transaction
 * handoff and the only Ask IPC surface. The renderer receives one declared
 * command service; owner credentials and fixed endpoints stay in main. */
import type {Config} from '../contracts';
import {AskController} from '../ask-controller';
import type {BrowserLogin} from '../central-navigation';
import {askWorkspaceChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

export const askCapability = 'ask.command';
export {askWorkspaceChannels};

export interface AskWorkspaceOptions {
  readonly settings: () => Config;
  readonly installLogin: (token: string, durationMs?: number) => Promise<void>;
  readonly endLogin: () => Promise<void>;
  readonly browserLogin: BrowserLogin;
  /** Shared recovery fence owned by the shell. */
  readonly guard?: () => void;
}

export function createAskWorkspacePlugin(options: AskWorkspaceOptions): BuiltinDesktopPlugin {
  const controller = new AskController({
    settings: options.settings,
    installLogin: options.installLogin,
    endLogin: options.endLogin,
    browserLogin: options.browserLogin,
  });
  return {
    id: 'mote.ask',
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({instanceId: 'mote.ask', capabilities: [askCapability]});
      const outcome = await host.startPlugin(scope, plugin => {
        plugin.registerIpc({
          channel: askWorkspaceChannels.request,
          capability: askCapability,
          windowRoles: ['main'],
          callerCapability: askCapability,
          roleFrameUrls: {main: [pageUrl]},
        }, (_view, args) => {
          options.guard?.();
          return controller.request(args[0], args[1]);
        });
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
