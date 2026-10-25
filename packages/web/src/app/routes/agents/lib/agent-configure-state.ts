import { isNil } from '@activepieces/core-utils';
import {
  Agent,
  AgentConfig,
  AgentIcon,
  AgentVisibility,
  ColorName,
  UpdateAgentRequest,
  formErrors,
} from '@activepieces/shared';
import { z } from 'zod';

import { agentEditState } from './agent-edit-state';

const ConfigureAgentSchema = z.object({
  displayName: z.string().min(1, formErrors.required),
  description: z.string(),
  icon: z.enum(AgentIcon),
  color: z.enum(ColorName),
  visibility: z.enum(AgentVisibility),
  sharedWithUserIds: z.array(z.string()),
  draft: AgentConfig,
});

type ConfigureAgentInput = z.input<typeof ConfigureAgentSchema>;
type ConfigureAgentValues = z.output<typeof ConfigureAgentSchema>;

const toUpdateRequest = (
  values: ConfigureAgentValues,
  agent: Agent,
): UpdateAgentRequest => ({
  goLive: true,
  displayName: values.displayName,
  description: values.description.length > 0 ? values.description : null,
  icon: values.icon,
  color: values.color,
  draft: values.draft,
  ...(values.visibility !== agent.visibility ||
  !agentEditState.sameConfig({
    left: values.sharedWithUserIds,
    right: agent.sharedWithUserIds,
  })
    ? {
        visibility: values.visibility,
        sharedWithUserIds: values.sharedWithUserIds,
      }
    : {}),
});

const formValuesOf = (agent: Agent): ConfigureAgentInput => ({
  displayName: agent.displayName,
  description: agent.description ?? '',
  icon: agent.icon,
  color: agent.color,
  visibility: agent.visibility,
  sharedWithUserIds: agent.sharedWithUserIds,
  draft: AgentConfig.parse(agent.draft),
});

const liveValuesOf = (agent: Agent): ConfigureAgentInput | null =>
  isNil(agent.published)
    ? null
    : { ...formValuesOf(agent), draft: AgentConfig.parse(agent.published) };

export { ConfigureAgentSchema, formValuesOf, liveValuesOf, toUpdateRequest };
export type { ConfigureAgentInput, ConfigureAgentValues };
