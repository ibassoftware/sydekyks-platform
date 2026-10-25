import { AIProviderName, isNil } from '@activepieces/core-utils';
import { ModelChoice } from '@activepieces/shared';

function sameConfig({
  left,
  right,
}: {
  left: unknown;
  right: unknown;
}): boolean {
  // PostgreSQL JSONB can reorder object keys on every round trip. Tool order
  // still matters, but serialization order inside a config does not.
  const stableJson = (value: unknown) =>
    JSON.stringify(value, (_key, item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  return stableJson(left) === stableJson(right);
}

function serverSyncDecision({
  fromServer,
  lastSeen,
  currentValues,
  pendingWrite,
  unsavedTyping,
}: {
  fromServer: unknown;
  lastSeen: unknown;
  currentValues: unknown;
  pendingWrite: unknown | null;
  unsavedTyping: boolean;
}): 'unchanged' | 'acknowledged' | 'conflict' | 'replace' {
  if (sameConfig({ left: fromServer, right: lastSeen })) return 'unchanged';
  if (
    (pendingWrite !== null &&
      sameConfig({ left: fromServer, right: pendingWrite })) ||
    sameConfig({ left: fromServer, right: currentValues })
  ) {
    return 'acknowledged';
  }
  return unsavedTyping ? 'conflict' : 'replace';
}

function modelPickChanged({
  picked,
  current,
}: {
  picked: ModelPick;
  current: ModelPick;
}): boolean {
  const same = (left?: string | null, right?: string | null) =>
    (left ?? null) === (right ?? null);
  return !(
    same(picked.provider, current.provider) &&
    same(picked.modelName, current.modelName) &&
    same(picked.providerConfigId, current.providerConfigId) &&
    same(picked.modelTierId, current.modelTierId)
  );
}

function hasModel({ config }: { config: ModelPick }): boolean {
  return (
    !isNil(config.modelTierId) ||
    (!isNil(config.provider) && !isNil(config.modelName))
  );
}

function modelChoiceOf({ config }: { config: ModelPick }): ModelChoice | null {
  if (!isNil(config.modelTierId)) {
    return { type: 'tier', tierId: config.modelTierId };
  }
  const provider = Object.values(AIProviderName).find(
    (name) => name === config.provider,
  );
  if (isNil(provider) || isNil(config.modelName)) {
    return null;
  }
  return {
    type: 'model',
    provider,
    providerConfigId: config.providerConfigId ?? '',
    modelId: config.modelName,
  };
}

function modelPickOf({ choice }: { choice: ModelChoice }): ModelPick {
  return choice.type === 'tier'
    ? {
        provider: null,
        modelName: null,
        providerConfigId: null,
        modelTierId: choice.tierId,
      }
    : {
        provider: choice.provider,
        modelName: choice.modelId,
        providerConfigId: choice.providerConfigId,
        modelTierId: null,
      };
}

function serverMovedWhileTyping({
  fromServer,
  lastSeen,
  unsavedTyping,
}: {
  fromServer: unknown;
  lastSeen: unknown;
  unsavedTyping: boolean;
}): boolean {
  return unsavedTyping && !sameConfig({ left: fromServer, right: lastSeen });
}

function leaveGuard({
  blockerState,
  exitRequested,
}: {
  blockerState: string;
  exitRequested: boolean;
}): LeaveGuard {
  if (blockerState !== 'blocked' && !exitRequested) {
    return { open: false, discardAction: 'none' };
  }
  return {
    open: true,
    discardAction: blockerState === 'blocked' ? 'proceed' : 'exit',
  };
}

function createWriteLock(): WriteLock {
  let held = false;
  return {
    claim: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
    held: () => held,
  };
}

export const agentEditState = {
  sameConfig,
  serverSyncDecision,
  serverMovedWhileTyping,
  modelPickChanged,
  hasModel,
  modelChoiceOf,
  modelPickOf,
  leaveGuard,
  createWriteLock,
};

export type ModelPick = {
  provider?: string | null;
  modelName?: string | null;
  providerConfigId?: string | null;
  modelTierId?: string | null;
};
export type LeaveGuard = {
  open: boolean;
  discardAction: 'proceed' | 'exit' | 'none';
};
export type WriteLock = {
  claim: () => boolean;
  release: () => void;
  held: () => boolean;
};
