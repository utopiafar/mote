import type {AgentOptions} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import type {BackgroundModelAuthorization, ModelConnection} from './background-model-authorization.js';
import type {ModelAgentHostHooks} from './model-agent.js';
import type {ProviderAdmission} from './provider-admission.js';

export interface AgentModelHostDependencies {
  readonly authorization: Pick<BackgroundModelAuthorization, 'assertCurrent'>;
  readonly admission: Pick<ProviderAdmission, 'check'>;
  readonly runModelFor: (settings: ModelSettings, connection: ModelConnection) => NonNullable<AgentOptions['runModel']>;
  readonly authorizeModelRequest: NonNullable<AgentOptions['authorizeModelRequest']>;
}

/** Central owns admission and disclosure for every native HTTP attempt. DSH
 * invokes this before initial sends, SDK retries, repairs and image turns. */
export function createAgentModelHost(settings: ModelSettings, connection: ModelConnection, dependencies: AgentModelHostDependencies): ModelAgentHostHooks {
  const assertCurrent = () => {
    dependencies.authorization.assertCurrent(connection);
    dependencies.admission.check(settings);
  };
  return {
    runModel: dependencies.runModelFor(settings, connection),
    async authorizeModelRequest() {
      assertCurrent();
      await dependencies.authorizeModelRequest();
      assertCurrent();
    },
  };
}
