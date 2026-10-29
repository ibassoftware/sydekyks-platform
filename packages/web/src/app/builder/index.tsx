import {
  FlowActionType,
  FlowTriggerType,
  flowStructureUtil,
} from '@activepieces/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelImperativeHandle } from 'react-resizable-panels';
import { useMedia, usePrevious } from 'react-use';

import { BuilderCopilot } from './builder-copilot';
import { BuilderCopilotPanel } from './builder-copilot-panel';
import { BuilderHeader } from './builder-header/builder-header';
import { FlowCanvas } from './flow-canvas';
import { flowCanvasHooks } from './flow-canvas/hooks';
import { flowCanvasConsts } from './flow-canvas/utils/consts';
import { BuilderBanner } from './flow-canvas/widgets/builder-banner';
import { FlowVersionsList } from './flow-versions';
import { RunsList } from './run-list';

import { CursorPositionProvider } from './state/cursor-position-context';
import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { DataSelector } from '@/app/builder/data-selector';
import { CanvasControls } from '@/app/builder/flow-canvas/canvas-controls';
import { RightSideBarType } from '@/app/builder/types';
import { ChatDrawer } from '@/app/routes/chat/chat-drawer';
import { ShowPoweredBy } from '@/components/custom/show-powered-by';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable-panel';
import { piecesHooks } from '@/features/pieces';
import { platformHooks } from '@/hooks/platform-hooks';
import { useElementSize } from '@/hooks/use-element-size';
import { cn } from '@/lib/utils';

import { StepSettingsPanel } from './step-settings/step-settings-panel';

const animateResizeClassName = `transition-all `;

const SPLIT_MODE_INITIAL_OPEN_SIZE_PX = 1000;
const SPLIT_MODE_SIDEBAR_SIZE_PX = 850;
const DEFAULT_SIDEBAR_SIZE = '25%';
const DEFAULT_MIN_SIZE = '400px';
const SPLIT_MODE_COLLAPSE_THRESHOLD_PX = 700;

const BuilderPage = () => {
  const { platform } = platformHooks.useCurrentPlatform();
  const [copilotOpen, setCopilotOpen] = useState(false);
  const compactWorkspace = useMedia('(max-width: 1279px)', false);
  const [
    flowVersion,
    rightSidebar,
    selectedStepName,
    removeAllStepTestsListeners,
    selectedStep,
    stepDataPanelView,
    isStepDataPanelOpen,
    setStepDataPanelView,
    setStepDataPanelOpen,
  ] = useBuilderStateContext((state) => [
    state.flowVersion,
    state.rightSidebar,
    state.selectedStep,
    state.removeAllStepTestsListeners,
    flowStructureUtil.getStep(
      state.selectedStep ?? '',
      state.flowVersion.trigger
    ),
    state.stepDataPanelView,
    state.isStepDataPanelOpen,
    state.setStepDataPanelView,
    state.setStepDataPanelOpen,
  ]);
  useEffect(() => {
    return () => {
      removeAllStepTestsListeners();
    };
  }, [removeAllStepTestsListeners]);
  flowCanvasHooks.useShowBuilderIsSavingWarningBeforeLeaving();
  flowCanvasHooks.useFlushPendingEditsOnLeave();
  flowCanvasHooks.useRefreshDraftOnPush();
  flowCanvasHooks.useRefreshDraftOnReconnectAndReturn();
  const middlePanelRef = useRef<HTMLDivElement>(null);
  const middlePanelSize = useElementSize(middlePanelRef);
  const [isDraggingHandle, setIsDraggingHandle] = useState(false);
  useEffect(() => {
    const handlePointerUp = () => setIsDraggingHandle(false);
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, []);
  const isSplitForPiece =
    rightSidebar === RightSideBarType.PIECE_SETTINGS &&
    stepDataPanelView === 'split' &&
    isStepDataPanelOpen;
  const prefersSplitLayout =
    rightSidebar === RightSideBarType.PIECE_SETTINGS &&
    stepDataPanelView === 'split';

  const rightHandleRef = useRef<PanelImperativeHandle>(null);
  const rightSidePanelRef = useRef<HTMLDivElement>(null);
  const previousRightSidebar = usePrevious(rightSidebar);

  useLayoutEffect(() => {
    const handle = rightHandleRef.current;
    if (!handle) return;
    if (rightSidebar === RightSideBarType.NONE) {
      handle.resize('0%');
      return;
    }
    const isInitialOpen = previousRightSidebar === RightSideBarType.NONE;
    const targetSize = prefersSplitLayout
      ? isInitialOpen
        ? SPLIT_MODE_INITIAL_OPEN_SIZE_PX
        : SPLIT_MODE_SIDEBAR_SIZE_PX
      : DEFAULT_SIDEBAR_SIZE;
    handle.resize(targetSize);
    const rafId = window.requestAnimationFrame(() => handle.resize(targetSize));
    return () => window.cancelAnimationFrame(rafId);
  }, [prefersSplitLayout, previousRightSidebar, rightSidebar]);

  useEffect(() => {
    if (!isSplitForPiece || !isDraggingHandle) return;
    const el = rightSidePanelRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0 && width < SPLIT_MODE_COLLAPSE_THRESHOLD_PX) {
        setStepDataPanelView('drawer');
        setStepDataPanelOpen(false);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [
    isSplitForPiece,
    isDraggingHandle,
    setStepDataPanelView,
    setStepDataPanelOpen,
  ]);
  const {
    pieceModel,
    isNotFound: pieceModelNotFound,
    refetch: refetchPiece,
  } = piecesHooks.usePieceModelForStepSettings({
    name: selectedStep?.settings.pieceName,
    version: selectedStep?.settings.pieceVersion,
    enabled:
      selectedStep?.type === FlowActionType.PIECE ||
      selectedStep?.type === FlowTriggerType.PIECE,
  });
  flowCanvasHooks.useSetSocketListener(refetchPiece);
  flowCanvasHooks.useListenToExistingRun();

  const [hasCanvasBeenInitialised, setHasCanvasBeenInitialised] =
    useState(false);

  return (
    <div className="flex h-full w-full flex-col relative max-h-[100vh]">
      <div className="z-50">
        <BuilderHeader
          copilotOpen={copilotOpen}
          onToggleCopilot={
            platform.plan.chatEnabled
              ? () => setCopilotOpen((open) => !open)
              : undefined
          }
        />
      </div>
      <div className="relative flex min-h-0 flex-1">
        {platform.plan.chatEnabled && (
          <BuilderCopilotPanel open={copilotOpen}>
            <BuilderCopilot
              key={flowVersion.flowId}
              onClose={() => setCopilotOpen(false)}
            />
          </BuilderCopilotPanel>
        )}
        <div className="min-w-0 flex-1">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="100%" id="flow-canvas">
              <div ref={middlePanelRef} className="relative h-full w-full">
                <CursorPositionProvider>
                  <FlowCanvas
                    setHasCanvasBeenInitialised={setHasCanvasBeenInitialised}
                  ></FlowCanvas>
                </CursorPositionProvider>

                <BuilderBanner />
                {middlePanelRef.current &&
                  middlePanelRef.current.clientWidth > 0 && (
                    <CanvasControls
                      canvasHeight={middlePanelRef.current?.clientHeight ?? 0}
                      canvasWidth={middlePanelRef.current?.clientWidth ?? 0}
                      hasCanvasBeenInitialised={hasCanvasBeenInitialised}
                      selectedStep={selectedStepName}
                    ></CanvasControls>
                  )}

                <ShowPoweredBy
                  position="absolute"
                  show={platform?.plan.showPoweredBy}
                />
                <DataSelector
                  parentHeight={middlePanelSize.height}
                  parentWidth={middlePanelSize.width}
                ></DataSelector>
              </div>
            </ResizablePanel>

            <ResizableHandle
              disabled={
                compactWorkspace || rightSidebar === RightSideBarType.NONE
              }
              withHandle={rightSidebar !== RightSideBarType.NONE}
              onPointerDown={() => setIsDraggingHandle(true)}
              onPointerUp={() => setIsDraggingHandle(false)}
              onPointerCancel={() => setIsDraggingHandle(false)}
              className={
                compactWorkspace
                  ? 'hidden'
                  : rightSidebar === RightSideBarType.NONE
                  ? 'bg-transparent'
                  : ''
              }
            />

            <ResizablePanel
              panelRef={rightHandleRef}
              id="right-sidebar"
              collapsedSize="0%"
              defaultSize="0%"
              minSize={
                rightSidebar === RightSideBarType.NONE
                  ? '0%'
                  : compactWorkspace
                  ? '100%'
                  : copilotOpen && platform.plan.chatEnabled
                  ? '320px'
                  : DEFAULT_MIN_SIZE
              }
              maxSize={
                rightSidebar === RightSideBarType.NONE
                  ? '0%'
                  : compactWorkspace
                  ? '100%'
                  : prefersSplitLayout
                  ? '95%'
                  : '60%'
              }
              className={cn('min-w-0 bg-gray-1 z-20', {
                hidden:
                  compactWorkspace && rightSidebar === RightSideBarType.NONE,
                [animateResizeClassName]: !isDraggingHandle,
              })}
              style={{
                ...(compactWorkspace
                  ? {
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                    }
                  : {}),
                transitionDuration: `${
                  isDraggingHandle
                    ? 0
                    : flowCanvasConsts.SIDEBAR_ANIMATION_DURATION
                }ms`,
              }}
            >
              <div ref={rightSidePanelRef} className="h-full w-full">
                <StepSettingsPanel
                  pieceModel={pieceModel}
                  pieceModelNotFound={pieceModelNotFound}
                />
                {rightSidebar === RightSideBarType.RUNS && <RunsList />}
                {rightSidebar === RightSideBarType.VERSIONS && (
                  <FlowVersionsList />
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      <ChatDrawer />
    </div>
  );
};

BuilderPage.displayName = 'BuilderPage';
export { BuilderPage };
