import {
  AgentActionKind,
  AgentActionOutcome,
  ApplicationEvent,
  ApplicationEventName,
  FlowOperationType,
  FlowUpdatedEvent,
} from '@activepieces/shared';
import { t } from 'i18next';

export function summarizeAuditEvent(event: ApplicationEvent) {
  switch (event.action) {
    case ApplicationEventName.FLOW_UPDATED: {
      return convertUpdateActionToDetails(event);
    }
    case ApplicationEventName.FLOW_RUN_STARTED:
      return t('Flow run {value0} is started', {
        value0: event.data.flowRun.id,
      });
    case ApplicationEventName.FLOW_RUN_FINISHED: {
      return t('Flow run {value0} is finished', {
        value0: event.data.flowRun.id,
      });
    }
    case ApplicationEventName.FLOW_RUN_RESUMED: {
      return t('Flow run {value0} is resumed', {
        value0: event.data.flowRun.id,
      });
    }
    case ApplicationEventName.FLOW_RUN_RETRIED: {
      return t('Flow run {value0} is retried from a failed step', {
        value0: event.data.flowRun.id,
      });
    }
    case ApplicationEventName.FLOW_CREATED:
      return t('Flow {value0} is created', { value0: event.data.flow.id });
    case ApplicationEventName.FLOW_PIECES_UPGRADED: {
      const upgradedCount = event.data.steps.filter(
        (step) => step.decision === 'UPGRADED',
      ).length;
      const keptCount = event.data.steps.length - upgradedCount;
      return t(
        'Flow {value0} piece versions upgraded ({value1} upgraded, {value2} kept)',
        { value0: event.data.flowId, value1: upgradedCount, value2: keptCount },
      );
    }
    case ApplicationEventName.FLOW_PIECES_REVERTED:
      return t('Flow {value0} piece versions reverted ({value1} steps)', {
        value0: event.data.flowId,
        value1: event.data.steps.length,
      });
    case ApplicationEventName.FLOW_DELETED:
      return t('Flow {value0} ({value1}) is deleted', {
        value0: event.data.flow.id,
        value1: event.data.flowVersion.displayName,
      });
    case ApplicationEventName.FLOW_PUBLISHED:
      return t('Flow "{value0}" was published', {
        value0: event.data.flowVersion.displayName,
      });
    case ApplicationEventName.FLOW_ACTIVATED:
      return t('Flow "{value0}" was activated', {
        value0: event.data.flowVersion.displayName,
      });
    case ApplicationEventName.FLOW_DEACTIVATED:
      return t('Flow "{value0}" was deactivated', {
        value0: event.data.flowVersion.displayName,
      });
    case ApplicationEventName.FOLDER_CREATED:
      return t('{value0} is created', {
        value0: event.data.folder.displayName,
      });
    case ApplicationEventName.FOLDER_UPDATED:
      return t('{value0} is updated', {
        value0: event.data.folder.displayName,
      });
    case ApplicationEventName.FOLDER_DELETED:
      return t('{value0} is deleted', {
        value0: event.data.folder.displayName,
      });
    case ApplicationEventName.CONNECTION_UPSERTED:
      return t('{value0} ({value1}) is updated', {
        value0: event.data.connection.displayName,
        value1: event.data.connection.externalId,
      });
    case ApplicationEventName.CONNECTION_DELETED:
      return t('{value0} ({value1}) is deleted', {
        value0: event.data.connection.displayName,
        value1: event.data.connection.externalId,
      });
    case ApplicationEventName.AGENT_CREATED:
      return t('Agent {value0} is created', {
        value0: event.data.agent.displayName,
      });
    case ApplicationEventName.AGENT_UPDATED:
      return t('Agent {value0} is updated', {
        value0: event.data.agent.displayName,
      });
    case ApplicationEventName.AGENT_DELETED:
      return t('Agent {value0} is deleted', {
        value0: event.data.agent.displayName,
      });
    case ApplicationEventName.AGENT_PUBLISHED:
      return t('Agent {value0} is published', {
        value0: event.data.agent.displayName,
      });
    case ApplicationEventName.AGENT_UNPUBLISHED:
      return t('Agent {value0} is taken offline', {
        value0: event.data.agent.displayName,
      });
    case ApplicationEventName.AGENT_ACTION_EXECUTED: {
      const who = event.data.agent?.displayName ?? t('An agent');
      const what =
        event.data.action.kind === AgentActionKind.FLOW
          ? t('the flow {value0}', { value0: event.data.action.displayName })
          : t('{value0}: {value1}', {
              value0: event.data.action.pieceDisplayName,
              value1: event.data.action.displayName,
            });
      const verb =
        event.data.outcome === AgentActionOutcome.FAILED
          ? 'tried to run'
          : 'ran';
      return t('{value0} {value1} {value2}', {
        value0: who,
        value1: verb,
        value2: what,
      });
    }
    case ApplicationEventName.VARIABLE_UPSERTED:
      return t('Variable {value0} is created or updated', {
        value0: event.data.variable.name,
      });
    case ApplicationEventName.VARIABLE_DELETED:
      return t('Variable {value0} is deleted', {
        value0: event.data.variable.name,
      });
    case ApplicationEventName.VARIABLE_VALUE_REVEALED:
      return t('Variable {value0} value was revealed', {
        value0: event.data.variable.name,
      });
    case ApplicationEventName.USER_SIGNED_IN:
      return t('User {value0} signed in', { value0: event.userEmail });
    case ApplicationEventName.USER_PASSWORD_RESET:
      return t('User {value0} reset password', { value0: event.userEmail });
    case ApplicationEventName.USER_EMAIL_VERIFIED:
      return t('User {value0} verified email', { value0: event.userEmail });
    case ApplicationEventName.USER_SIGNED_UP:
      return t('User {value0} signed up using email from {value1}', {
        value0: event.userEmail,
        value1: event.data.source,
      });
    case ApplicationEventName.AUDIT_LOG_RETENTION_UPDATED:
      return t('Audit log retention updated');
    case ApplicationEventName.SIGNING_KEY_CREATED:
      return t('{value0} is created', {
        value0: event.data.signingKey.displayName,
      });
    case ApplicationEventName.PROJECT_ROLE_CREATED:
      return t('{value0} is created', { value0: event.data.projectRole.name });
    case ApplicationEventName.PROJECT_ROLE_UPDATED:
      return t('{value0} is updated', { value0: event.data.projectRole.name });
    case ApplicationEventName.PROJECT_ROLE_DELETED:
      return t('{value0} is deleted', { value0: event.data.projectRole.name });
    case ApplicationEventName.PROJECT_RELEASE_CREATED:
      return t('{value0} is created', { value0: event.data.release.name });
    case ApplicationEventName.PROJECT_REPLACED: {
      const { applied, failedCount, outcome, durationMs } = event.data;
      const totals =
        applied.flowsCreated +
        applied.flowsUpdated +
        applied.flowsDeleted +
        applied.tablesCreated +
        applied.tablesUpdated +
        applied.tablesDeleted +
        applied.foldersCreated +
        applied.foldersUpdated +
        applied.foldersDeleted;
      return t(
        'Project replace {value0} in {value1}ms ({value2} changes, {value3} failed)',
        {
          value0: outcome.toLowerCase(),
          value1: durationMs,
          value2: totals,
          value3: failedCount,
        },
      );
    }
    case ApplicationEventName.FLOW_APPROVAL_REQUESTED:
      return t('Approval requested for flow {value0}', {
        value0: event.data.flowDisplayName ?? event.data.flowId,
      });
    case ApplicationEventName.FLOW_APPROVAL_GRANTED:
      return t('Approval granted for flow {value0}', {
        value0: event.data.flowDisplayName ?? event.data.flowId,
      });
    case ApplicationEventName.FLOW_APPROVAL_REJECTED:
      return t('Approval rejected for flow {value0}{value1}', {
        value0: event.data.flowDisplayName ?? event.data.flowId,
        value1: event.data['rejectionReason']
          ? t(' ({value0})', { value0: event.data['rejectionReason'] })
          : '',
      });
    case ApplicationEventName.FLOW_APPROVAL_WITHDRAWN:
      return t('Approval request withdrawn for flow {value0}', {
        value0: event.data.flowDisplayName ?? event.data.flowId,
      });
  }
}

function convertUpdateActionToDetails(event: FlowUpdatedEvent) {
  switch (event.data.request.type) {
    case FlowOperationType.ADD_ACTION:
      return t('Added action "{value0}" to "{value1}" Flow.', {
        value0: event.data.request.request.action.displayName,
        value1: event.data.flowVersion.displayName,
      });
    case FlowOperationType.UPDATE_ACTION:
      return t('Updated action "{value0}" in "{value1}" Flow.', {
        value0: event.data.request.request.displayName,
        value1: event.data.flowVersion.displayName,
      });
    case FlowOperationType.DELETE_ACTION: {
      const request = event.data.request.request;
      const names = request.names;
      return t('Deleted actions "{value0}" from "{value1}" Flow.', {
        value0: names.join(', '),
        value1: event.data.flowVersion.displayName,
      });
    }
    case FlowOperationType.CHANGE_NAME:
      return t('Renamed flow "{value0}" to "{value1}".', {
        value0: event.data.flowVersion.displayName,
        value1: event.data.request.request.displayName,
      });
    case FlowOperationType.LOCK_AND_PUBLISH:
      return t('Locked and published flow "{value0}" Flow.', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.USE_AS_DRAFT:
      return t('Unlocked and unpublished flow "{value0}" Flow.', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.MOVE_ACTION:
      return t('Moved action "{value0}" to after "{value1}".', {
        value0: event.data.request.request.name,
        value1: event.data.request.request.newParentStep,
      });
    case FlowOperationType.LOCK_FLOW:
      return t('Locked flow "{value0}" Flow.', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.CHANGE_STATUS:
      return t('Changed status of flow "{value0}" Flow to "{value1}".', {
        value0: event.data.flowVersion.displayName,
        value1: event.data.request.request.status,
      });
    case FlowOperationType.DUPLICATE_ACTION:
      return t('Duplicated action "{value0}" in "{value1}" Flow.', {
        value0: event.data.request.request.stepName,
        value1: event.data.flowVersion.displayName,
      });
    case FlowOperationType.IMPORT_FLOW:
      return t('Imported flow in "{value0}" Flow.', {
        value0: event.data.request.request.displayName,
      });
    case FlowOperationType.UPDATE_TRIGGER:
      return t('Updated trigger in "{value0}" Flow to "{value1}".', {
        value0: event.data.flowVersion.displayName,
        value1: event.data.request.request.displayName,
      });
    case FlowOperationType.CHANGE_FOLDER:
      return t('Moved flow "{value0}" to folder id {value1}.', {
        value0: event.data.flowVersion.displayName,
        value1: event.data.request.request.folderId,
      });
    case FlowOperationType.DELETE_BRANCH: {
      return t(
        'Deleted branch number {value0} in flow "{value1}" for the step "{value2}".',
        {
          value0: event.data.request.request.branchIndex + 1,
          value1: event.data.flowVersion.displayName,
          value2: event.data.request.request.stepName,
        },
      );
    }
    case FlowOperationType.SAVE_SAMPLE_DATA: {
      return t('Saved sample data for step "{value0}" in flow "{value1}".', {
        value0: event.data.request.request.stepName,
        value1: event.data.flowVersion.displayName,
      });
    }
    case FlowOperationType.DUPLICATE_BRANCH: {
      return t(
        'Duplicated branch number {value0} in flow "{value1}" for the step "{value2}".',
        {
          value0: event.data.request.request.branchIndex + 1,
          value1: event.data.flowVersion.displayName,
          value2: event.data.request.request.stepName,
        },
      );
    }
    case FlowOperationType.ADD_BRANCH:
      return t(
        'Added branch number {value0} in flow "{value1}" for the step "{value2}".',
        {
          value0: event.data.request.request.branchIndex + 1,
          value1: event.data.flowVersion.displayName,
          value2: event.data.request.request.stepName,
        },
      );
    case FlowOperationType.SET_SKIP_ACTION: {
      const request = event.data.request.request;
      const names = request.names;
      return t('Updated actions "{value0}" in "{value1}" Flow to skip.', {
        value0: names.join(', '),
        value1: event.data.flowVersion.displayName,
      });
    }
    case FlowOperationType.UPDATE_METADATA:
      return t('Updated metadata for flow "{value0}".', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.UPDATE_MINUTES_SAVED:
      return t('Updated minutes saved for flow "{value0}".', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.UPDATE_OWNER:
      return t('Updated owner for flow "{value0}" to "{value1}".', {
        value0: event.data.flowVersion.displayName,
        value1: event.data.request.request.ownerId,
      });
    case FlowOperationType.MOVE_BRANCH:
      return t(
        'Moved branch number {value0} to {value1} in flow "{value2}" for the step "{value3}".',
        {
          value0: event.data.request.request.sourceBranchIndex + 1,
          value1: event.data.request.request.targetBranchIndex + 1,
          value2: event.data.flowVersion.displayName,
          value3: event.data.request.request.stepName,
        },
      );
    case FlowOperationType.ADD_NOTE:
      return t('Added note to flow "{value0}".', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.UPDATE_NOTE:
      return t('Updated note in flow "{value0}".', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.DELETE_NOTE:
      return t('Deleted note in flow "{value0}".', {
        value0: event.data.flowVersion.displayName,
      });
    case FlowOperationType.UPDATE_SAMPLE_DATA_INFO:
      return t(
        'Updated sample data info for step "{value0}" in flow "{value1}".',
        {
          value0: event.data.request.request.stepName,
          value1: event.data.flowVersion.displayName,
        },
      );
  }
}
