import { SeekPage } from '@activepieces/core-utils';
import {
  CountFlowRunsByStatusRequest,
  CountFlowRunsByStatusResponse,
  FlowRun,
  FlowRunWithRetryError,
  ListFlowRunsRequestQuery,
  RetryFlowRequestBody,
  TestFlowRunRequestBody,
  WebsocketServerEvent,
  WebsocketClientEvent,
  CreateStepRunRequestBody,
  BulkActionOnRunsRequestBody,
  BulkArchiveActionOnRunsRequestBody,
  BulkCancelFlowRequestBody,
  UpdateRunProgressRequest,
  isFlowRunStateTerminal,
} from '@activepieces/shared';
import { Socket } from 'socket.io-client';

import { api } from '@/lib/api';

type TestStepParams = {
  request: CreateStepRunRequestBody;
};
export const flowRunsApi = {
  list(request: ListFlowRunsRequestQuery): Promise<SeekPage<FlowRun>> {
    return api.get<SeekPage<FlowRun>>('/v1/flow-runs', request);
  },
  countByStatus(
    request: CountFlowRunsByStatusRequest,
  ): Promise<CountFlowRunsByStatusResponse> {
    return api.get<CountFlowRunsByStatusResponse>(
      '/v1/flow-runs/count-by-status',
      request,
    );
  },
  getPopulated(id: string): Promise<FlowRun> {
    return api.get<FlowRun>(`/v1/flow-runs/${id}`);
  },
  bulkRetry(
    request: BulkActionOnRunsRequestBody,
  ): Promise<FlowRunWithRetryError[]> {
    return api.post<FlowRunWithRetryError[]>('/v1/flow-runs/retry', request);
  },
  bulkCancel(request: BulkCancelFlowRequestBody): Promise<FlowRun[]> {
    return api.post<FlowRun[]>('/v1/flow-runs/cancel', request);
  },
  bulkArchive(request: BulkArchiveActionOnRunsRequestBody): Promise<void> {
    return api.post<void>('/v1/flow-runs/archive', request);
  },
  retry(flowRunId: string, request: RetryFlowRequestBody): Promise<FlowRun> {
    return api.post<FlowRun>(`/v1/flow-runs/${flowRunId}/retry`, request);
  },
  async subscribeToTestFlowOrManualRun(
    socket: Socket,
    request: TestFlowRunRequestBody,
    onUpdate: (response: UpdateRunProgressRequest) => void,
    isForManualTrigger: boolean,
  ): Promise<void> {
    const initialRun = await getInitialRun(socket, request, isForManualTrigger);
    if (
      isFlowRunStateTerminal({
        status: initialRun.status,
        ignoreInternalError: false,
      })
    ) {
      onUpdate({ flowRun: initialRun });
      return;
    }
    onUpdate({
      flowRun: initialRun,
    });
    const handleUpdateRunProgress = (response: UpdateRunProgressRequest) => {
      if (response.flowRun.id === initialRun.id) {
        onUpdate(response);
        if (
          isFlowRunStateTerminal({
            status: response.flowRun.status,
            ignoreInternalError: false,
          })
        ) {
          cleanupProgress();
        }
      }
    };
    const cleanupProgress = () => {
      socket.off(
        WebsocketClientEvent.UPDATE_RUN_PROGRESS,
        handleUpdateRunProgress,
      );
      socket.off('disconnect', cleanupProgress);
    };
    socket.on(
      WebsocketClientEvent.UPDATE_RUN_PROGRESS,
      handleUpdateRunProgress,
    );
    socket.once('disconnect', cleanupProgress);
  },
  async testStep(params: TestStepParams): Promise<{ runId: string }> {
    const { request } = params;
    const stepRun = await api.post<FlowRun>(
      '/v1/sample-data/test-step',
      request,
    );
    return { runId: stepRun.id };
  },
};
function getInitialRun(
  socket: Socket,
  request: TestFlowRunRequestBody,
  forManualTrigger: boolean,
): Promise<FlowRun> {
  return new Promise<FlowRun>((resolve, reject) => {
    const startedEvent = forManualTrigger
      ? WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED
      : WebsocketClientEvent.TEST_FLOW_RUN_STARTED;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(startedEvent, onRunStarted);
      socket.off('disconnect', onDisconnect);
    };
    const onRunStarted = (run: FlowRun) => {
      if (run.flowVersionId !== request.flowVersionId) return;
      cleanup();
      resolve(run);
    };
    const onDisconnect = () => {
      cleanup();
      reject(
        new Error(
          'Connection lost before run start was confirmed. Check run history before retrying.',
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Run start was not confirmed. Check run history before retrying.',
        ),
      );
    }, 30_000);
    socket.on(startedEvent, onRunStarted);
    socket.once('disconnect', onDisconnect);
    try {
      socket.emit(
        forManualTrigger
          ? WebsocketServerEvent.MANUAL_TRIGGER_RUN_STARTED
          : WebsocketServerEvent.TEST_FLOW_RUN,
        request,
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
