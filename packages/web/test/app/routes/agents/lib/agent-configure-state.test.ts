import {
  Agent,
  AgentConfig,
  AgentIcon,
  AgentVisibility,
  ColorName,
} from '@activepieces/shared';
import { describe, expect, it } from 'vitest';

import {
  ConfigureAgentSchema,
  formValuesOf,
  toUpdateRequest,
} from '@/app/routes/agents/lib/agent-configure-state';

const agent = {
  id: 'agent-1',
  displayName: 'Adder',
  description: null,
  icon: AgentIcon.BOT,
  color: ColorName.PURPLE,
  visibility: AgentVisibility.RESTRICTED,
  sharedWithUserIds: ['already-shared'],
  draft: AgentConfig.parse({ instructions: 'Add two numbers.' }),
} as Agent;

describe('agent configuration save', () => {
  it('does not rewrite sharing when publishing an unchanged visibility or existing named shares', () => {
    const request = toUpdateRequest(
      ConfigureAgentSchema.parse(formValuesOf(agent)),
      agent,
    );
    expect(request.goLive).toBe(true);
    expect(request).not.toHaveProperty('visibility');
    expect(request).not.toHaveProperty('sharedWithUserIds');
    expect(request.icon).toBe(agent.icon);
    expect(request.color).toBe(agent.color);
  });

  it('includes an intentional Command Center sharing change and clears named shares', () => {
    const values = ConfigureAgentSchema.parse({
      ...formValuesOf(agent),
      visibility: AgentVisibility.PROJECT,
      sharedWithUserIds: [],
    });
    expect(toUpdateRequest(values, agent)).toMatchObject({
      visibility: AgentVisibility.PROJECT,
      sharedWithUserIds: [],
    });
  });

  it('can explicitly make an existing named-share configuration private', () => {
    const values = ConfigureAgentSchema.parse({
      ...formValuesOf(agent),
      sharedWithUserIds: [],
    });
    expect(toUpdateRequest(values, agent)).toMatchObject({
      visibility: AgentVisibility.RESTRICTED,
      sharedWithUserIds: [],
    });
  });

  it('normalizes absent model config defaults without changing the agent’s saved appearance', () => {
    const values = formValuesOf(agent);
    expect(values.draft.tools).toEqual([]);
    expect(values.draft.maxSteps).toBeGreaterThan(0);
    expect(values.icon).toBe(agent.icon);
    expect(values.color).toBe(agent.color);
    expect(
      ConfigureAgentSchema.safeParse({ ...values, displayName: '' }).success,
    ).toBe(false);
  });
});
