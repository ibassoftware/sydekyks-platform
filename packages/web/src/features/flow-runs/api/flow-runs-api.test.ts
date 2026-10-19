import { EventEmitter } from 'node:events';

import {
  FlowRun,
  FlowRunStatus,
  UpdateRunProgressRequest,
  WebsocketClientEvent,
  WebsocketServerEvent,
} from '@activepieces/shared';
import { Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

import { flowRunsApi } from './flow-runs-api';

function transport() {
  const incoming = new EventEmitter();
  const socket = {
    on: vi.fn(incoming.on.bind(incoming)),
    once: vi.fn(incoming.once.bind(incoming)),
    off: vi.fn(incoming.off.bind(incoming)),
    emit: vi.fn((_event: string, _payload: unknown) => undefined),
  };
  return { incoming, socket, client: socket as unknown as Socket };
}
const request = { flowVersionId: 'authorized-version' };
const run = (status: FlowRunStatus, extra: Partial<FlowRun> = {}) =>
  ({
    id: 'authorized-run',
    flowVersionId: request.flowVersionId,
    status,
    ...extra,
  } as FlowRun);

afterEach(() => vi.useRealTimers());

describe('manual and test run transport', () => {
  it.each([true, false])(
    'receives an immediate terminal refusal without subscribing to progress (manual=%s)',
    async (manual) => {
      const { incoming, socket, client } = transport();
      const started = manual
        ? WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED
        : WebsocketClientEvent.TEST_FLOW_RUN_STARTED;
      const refusal = run(FlowRunStatus.FAILED);
      socket.emit.mockImplementationOnce(() => {
        incoming.emit(started, refusal);
      });
      const onUpdate = vi.fn();

      await flowRunsApi.subscribeToTestFlowOrManualRun(
        client,
        request,
        onUpdate,
        manual,
      );

      expect(socket.emit).toHaveBeenCalledWith(
        manual
          ? WebsocketServerEvent.MANUAL_TRIGGER_RUN_STARTED
          : WebsocketServerEvent.TEST_FLOW_RUN,
        request,
      );
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ flowRun: refusal });
      expect(incoming.eventNames()).toEqual([]);
      expect(
        socket.on.mock.calls.some(
          ([event]) => event === WebsocketClientEvent.UPDATE_RUN_PROGRESS,
        ),
      ).toBe(false);
    },
  );

  it('keeps version/run correlation and follows an authorized run through completion, then cleans up', async () => {
    const { incoming, socket, client } = transport();
    socket.emit.mockImplementationOnce(() => {
      incoming.emit(
        WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED,
        run(FlowRunStatus.QUEUED, { flowVersionId: 'other-version' }),
      );
      incoming.emit(
        WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED,
        run(FlowRunStatus.RUNNING),
      );
    });
    const onUpdate = vi.fn();
    await flowRunsApi.subscribeToTestFlowOrManualRun(
      client,
      request,
      onUpdate,
      true,
    );
    incoming.emit(WebsocketClientEvent.UPDATE_RUN_PROGRESS, {
      flowRun: run(FlowRunStatus.SUCCEEDED, { id: 'other-run' }),
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const completed = {
      flowRun: run(FlowRunStatus.SUCCEEDED),
    } as UpdateRunProgressRequest;
    incoming.emit(WebsocketClientEvent.UPDATE_RUN_PROGRESS, completed);
    expect(onUpdate).toHaveBeenLastCalledWith(completed);
    expect(incoming.eventNames()).toEqual([]);
  });

  it('cleans up progress when the current connection closes', async () => {
    const { incoming, socket, client } = transport();
    socket.emit.mockImplementationOnce(() => {
      incoming.emit(
        WebsocketClientEvent.TEST_FLOW_RUN_STARTED,
        run(FlowRunStatus.RUNNING),
      );
    });
    await flowRunsApi.subscribeToTestFlowOrManualRun(
      client,
      request,
      vi.fn(),
      false,
    );
    incoming.emit('disconnect');
    expect(incoming.eventNames()).toEqual([]);
  });

  it('bounds an unconfirmed start without retrying or leaving listeners', async () => {
    vi.useFakeTimers();
    const { incoming, socket, client } = transport();
    const pending = flowRunsApi.subscribeToTestFlowOrManualRun(
      client,
      request,
      vi.fn(),
      true,
    );
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message:
        'Run start was not confirmed. Check run history before retrying.',
    });
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(incoming.eventNames()).toEqual([]);
  });

  it('rejects and cleans up if disconnected before the initial run arrives', async () => {
    const { incoming, client } = transport();
    const pending = flowRunsApi.subscribeToTestFlowOrManualRun(
      client,
      request,
      vi.fn(),
      false,
    );
    const outcome = pending.catch((error: unknown) => error);
    incoming.emit('disconnect');
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message:
        'Connection lost before run start was confirmed. Check run history before retrying.',
    });
    expect(incoming.eventNames()).toEqual([]);
  });
});
