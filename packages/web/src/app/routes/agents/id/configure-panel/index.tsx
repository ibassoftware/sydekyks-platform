import { isNil, Permission } from '@activepieces/core-utils';
import {
  Agent,
  AgentConfig,
  AgentToolType,
  AgentVisibility,
  DEFAULT_AGENT_MAX_STEPS,
  MAX_AGENT_STEP_BUDGET,
} from '@activepieces/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { t } from 'i18next';
import { ChevronRight, MessageSquare, Trash2 } from 'lucide-react';
import {
  forwardRef,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { AgentTools } from '@/app/builder/step-settings/agent-settings/agent-tools';
import { Dot } from '@/components/custom/dot';
import {
  LeaveWithoutSavingDialog,
  useWarnBeforeLosingChanges,
} from '@/components/custom/leave-without-saving';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AgentStructuredOutput,
  ModelPicker,
  NoEmbeddingSourceNote,
  useKnowledgeBaseEmbeddingSource,
} from '@/features/agents';
import { AgentAppearancePicker } from '@/features/agents/agent-appearance-picker';
import { AgentMark } from '@/features/agents/agent-mark';
import { DeleteAgentDialog } from '@/features/agents/delete-agent-dialog';
import { agentsMutations } from '@/features/agents/hooks/agents-hooks';
import { HostedAgentProviderField } from '@/features/agents/hosted-agent-provider-field';
import { MoveAgentDialog } from '@/features/agents/move-agent-dialog';
import { UseInMissionNote } from '@/features/agents/use-in-mission-note';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  ApProjectDisplay,
  getProjectName,
  projectCollectionUtils,
} from '@/features/projects';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';
import { cn } from '@/lib/utils';

import {
  ConfigureAgentSchema,
  ConfigureAgentInput,
  ConfigureAgentValues,
  formValuesOf,
  liveValuesOf,
  toUpdateRequest,
} from '../../lib/agent-configure-state';
import { agentEditState } from '../../lib/agent-edit-state';

const parseProvider = (provider?: string) => {
  const parsed = AgentConfig.shape.provider.safeParse(provider ?? null);
  return parsed.success ? parsed.data : null;
};

const AgentProjectRow = ({ agent }: { agent: Agent }) => {
  const [moving, setMoving] = useState(false);
  const { checkAccess } = useAuthorization(agent.projectId);
  const { data: allProjects } = projectCollectionUtils.useAll();
  const home = (allProjects ?? []).find(
    (project) => project.id === agent.projectId,
  );

  if (
    !checkAccess(Permission.WRITE_AGENT) ||
    (allProjects ?? []).length < 2 ||
    home === undefined
  ) {
    return null;
  }

  return (
    <FormItem className="flex flex-col gap-2">
      <PanelSectionLabel label={t('Project')} />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-6 px-3 py-2.5">
        <ApProjectDisplay
          title={getProjectName(home)}
          icon={home.icon}
          projectType={home.type}
          titleClassName="text-sm leading-5"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setMoving(true)}
        >
          {t('Move')}
        </Button>
      </div>
      <MoveAgentDialog
        agent={agent}
        open={moving}
        onOpenChange={setMoving}
        onMoved={(projectId) =>
          projectCollectionUtils.setCurrentProject(
            projectId,
            `/projects/${agent.projectId}/agents/${agent.id}`,
          )
        }
      />
    </FormItem>
  );
};

const AgentDangerZone = ({
  agent,
  onDeleted,
}: {
  agent: Agent;
  onDeleted: () => void;
}) => {
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { checkAccess } = useAuthorization(agent.projectId);

  if (!checkAccess(Permission.WRITE_AGENT)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-gray-6 pt-5">
      <PanelSectionLabel label={t('Delete this agent')} />
      <div className="flex items-start justify-between gap-4">
        <span className="text-sm leading-5 text-gray-11">
          {t(
            'Its instructions, its tools, and every conversation held with it go with it.',
          )}
        </span>
        <DeleteAgentDialog
          agent={agent}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => {
            onDeleted();
            navigate('/agents');
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-2 text-danger-11 hover:text-danger-11"
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={14} />
            {t('Delete')}
          </Button>
        </DeleteAgentDialog>
      </div>
    </div>
  );
};

const AdvancedSection = ({ children }: { children: React.ReactNode }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 border-t border-gray-6 pt-5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-fit items-center gap-1.5 text-xs font-medium leading-4 text-gray-11 transition-colors hover:text-gray-12"
      >
        <ChevronRight
          size={14}
          className={cn('transition-transform', open && 'rotate-90')}
        />
        {t('Advanced')}
      </button>
      {open && <div className="flex flex-col gap-6 pt-1">{children}</div>}
    </div>
  );
};

const ConfigureBehaviorTab = ({
  form,
  needsModel,
  projectId,
}: {
  form: ReturnType<
    typeof useForm<ConfigureAgentInput, unknown, ConfigureAgentValues>
  >;
  needsModel: boolean;
  projectId: string;
}) => {
  const hosted = useHostedBillingEnabled();
  const tools = form.watch('draft.tools') ?? [];
  const draft = form.watch('draft');
  const { data: embeddingSource } = useKnowledgeBaseEmbeddingSource();
  const knowledgeCount = tools.filter(
    (tool) => tool.type === AgentToolType.KNOWLEDGE_BASE,
  ).length;

  return (
    <>
      <FormField
        control={form.control}
        name="draft.instructions"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-2">
            <PanelSectionLabel label={t('Instructions')} required />
            <FormControl>
              <Textarea
                {...field}
                minRows={4}
                maxRows={12}
                placeholder={t(
                  'Reply to refund requests. Check the order in Stripe first, and escalate anything over $200.',
                )}
                className="px-3 py-3 text-sm leading-relaxed"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormItem className="flex flex-col gap-2">
        <PanelSectionLabel label={hosted ? t('AI provider') : t('Model')} />
        {needsModel && (
          <p className="text-sm leading-4 text-danger-11">
            {t('Pick a model so this agent can answer.')}
          </p>
        )}
        {hosted ? (
          <HostedAgentProviderField
            projectId={projectId}
            config={draft}
            onChange={(picked) => {
              form.setValue('draft.provider', picked.provider, {
                shouldDirty: true,
              });
              form.setValue('draft.providerConfigId', picked.providerConfigId, {
                shouldDirty: true,
              });
              form.setValue('draft.modelName', picked.modelName, {
                shouldDirty: true,
              });
              form.setValue('draft.modelTierId', picked.modelTierId, {
                shouldDirty: true,
              });
            }}
          />
        ) : (
          <ModelPicker
            projectId={projectId}
            surface="agent"
            value={agentEditState.modelChoiceOf({ config: draft })}
            onChange={(choice) => {
              const picked = agentEditState.modelPickOf({ choice });
              if (
                !agentEditState.modelPickChanged({
                  picked,
                  current: form.getValues('draft'),
                })
              ) {
                return;
              }
              form.setValue(
                'draft.provider',
                parseProvider(picked.provider ?? undefined),
                { shouldDirty: true },
              );
              form.setValue('draft.modelName', picked.modelName ?? null, {
                shouldDirty: true,
              });
              form.setValue(
                'draft.providerConfigId',
                picked.providerConfigId ?? null,
                { shouldDirty: true },
              );
              form.setValue('draft.modelTierId', picked.modelTierId ?? null, {
                shouldDirty: true,
              });
            }}
          />
        )}
        {!hosted &&
          knowledgeCount > 0 &&
          !isNil(embeddingSource) &&
          (isNil(embeddingSource.modelId) ? (
            <NoEmbeddingSourceNote className="text-xs text-gray-11" />
          ) : (
            <p className="text-xs text-gray-11">
              {t('Embedding model for knowledge base: {model}', {
                model: embeddingSource.modelId,
              })}
            </p>
          ))}
      </FormItem>
      <FormField
        control={form.control}
        name="draft.tools"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-2">
            <AgentTools toolsField={field} />
            <FormMessage />
          </FormItem>
        )}
      />
      <AdvancedSection>
        <FormField
          control={form.control}
          name="draft.structuredOutput"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-2">
              <AgentStructuredOutput
                disabled={false}
                structuredOutputField={field}
              />
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="draft.maxSteps"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-2">
              <PanelSectionLabel label={t('Max steps')} />
              <FormControl>
                <Input
                  type="number"
                  min={1}
                  max={MAX_AGENT_STEP_BUDGET}
                  value={field.value}
                  onChange={(event) =>
                    field.onChange(
                      Number(event.target.value) || DEFAULT_AGENT_MAX_STEPS,
                    )
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </AdvancedSection>
    </>
  );
};

const ConfigureIdentity = ({
  agent,
  form,
}: {
  agent: Agent;
  form: ReturnType<
    typeof useForm<ConfigureAgentInput, unknown, ConfigureAgentValues>
  >;
}) => {
  const { checkAccess, isFetchingProjectRole } = useAuthorization(
    agent.projectId,
  );
  const canShare =
    agent.ownerId === authenticationSession.getCurrentUserId() ||
    (!isFetchingProjectRole && checkAccess(Permission.WRITE_PROJECT));
  const sharedWith = form.watch('sharedWithUserIds');
  return (
    <div className="flex flex-col gap-5 border-b border-gray-6 pb-6">
      <div className="flex items-start gap-3">
        <div className="pt-6">
          <AgentMark
            icon={form.watch('icon')}
            color={form.watch('color')}
            size="sm"
          />
        </div>
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem className="flex min-w-0 grow flex-col gap-2">
              <PanelSectionLabel label={t('Name')} required />
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <FormField
        control={form.control}
        name="visibility"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-2">
            <PanelSectionLabel label={t('Sharing')} />
            <Select
              disabled={!canShare}
              value={
                field.value === AgentVisibility.PROJECT
                  ? 'project'
                  : sharedWith.length > 0
                  ? 'selected'
                  : 'private'
              }
              onValueChange={(value) => {
                if (value === 'selected') return;
                field.onChange(
                  value === 'project'
                    ? AgentVisibility.PROJECT
                    : AgentVisibility.RESTRICTED,
                );
                form.setValue('sharedWithUserIds', [], { shouldDirty: true });
              }}
            >
              <FormControl>
                <SelectTrigger aria-label={t('Sharing')}>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="private">{t('Private')}</SelectItem>
                <SelectItem value="project">
                  {t('Everyone in this Command Center')}
                </SelectItem>
                {sharedWith.length > 0 && (
                  <SelectItem value="selected">
                    {t('Selected people ({count})', {
                      count: sharedWith.length,
                    })}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {!canShare && (
              <p className="text-xs leading-5 text-gray-11">
                {t(
                  'Only the creator or a Command Center administrator can change sharing.',
                )}
              </p>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem className="flex flex-col gap-2">
            <PanelSectionLabel label={t('Description')} />
            <FormControl>
              <Input
                {...field}
                placeholder={t('A short description of its job')}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <AgentAppearancePicker
        key={agent.id}
        icon={form.watch('icon')}
        color={form.watch('color')}
        onIconChange={(value) =>
          form.setValue('icon', value, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
        onColorChange={(value) =>
          form.setValue('color', value, { shouldDirty: true })
        }
      />
    </div>
  );
};

const PanelSectionLabel = ({
  label,
  required,
}: {
  label: string;
  required?: boolean;
}) => (
  <FormLabel showRequiredIndicator={required} className="text-sm font-medium">
    {label}
  </FormLabel>
);

const ScrollFade = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const [scrolled, setScrolled] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  return (
    <div className={cn('relative', className)}>
      {scrolled && (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-[1] h-5 bg-gradient-to-b from-gray-1 to-transparent" />
      )}
      <div
        ref={bodyRef}
        onScroll={() => setScrolled((bodyRef.current?.scrollTop ?? 0) > 5)}
        className="h-full overflow-y-auto"
      >
        {children}
      </div>
    </div>
  );
};

const AgentConfigurePanel = forwardRef<
  AgentConfigurePanelHandle,
  { agent: Agent; onExit: () => void; disabled?: boolean }
>(({ agent, onExit, disabled = false }, ref) => {
  const form = useForm<ConfigureAgentInput, unknown, ConfigureAgentValues>({
    resolver: zodResolver(ConfigureAgentSchema),
    defaultValues: formValuesOf(agent),
    mode: 'onChange',
  });
  const updateAgent = agentsMutations.useUpdateAgent({ id: agent.id });

  const hosted = useHostedBillingEnabled();
  const values = form.watch();
  const formNeedsModel =
    !hosted &&
    !agentEditState.hasModel({
      config: values.draft ?? {},
    });
  const live = liveValuesOf(agent);
  const hasChanges =
    isNil(live) || !agentEditState.sameConfig({ left: values, right: live });
  const unsavedTyping = form.formState.isDirty;
  const deletedRef = useRef(false);
  const leaveBlocker = useWarnBeforeLosingChanges({
    hasChanges: unsavedTyping,
    standDown: deletedRef,
  });
  const [exitRequested, setExitRequested] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);
  const leaveDecision = agentEditState.leaveGuard({
    blockerState: leaveBlocker.state,
    exitRequested,
  });
  const writeLock = useRef(agentEditState.createWriteLock());
  const pendingWrite = useRef<ConfigureAgentInput | null>(null);
  const pendingBaseline = useRef<ConfigureAgentInput | null>(null);

  const lastFromServer = useRef(formValuesOf(agent));
  const latestFromServer = useRef(formValuesOf(agent));
  const [movedUnderneath, setMovedUnderneath] = useState(false);

  useLayoutEffect(() => {
    const fromServer = formValuesOf(agent);
    // Unlike the accepted baseline, this also records conflicting updates.
    // A delayed mutation callback must never acknowledge an older save over it.
    latestFromServer.current = fromServer;
    const decision = agentEditState.serverSyncDecision({
      fromServer,
      lastSeen: lastFromServer.current,
      currentValues: form.getValues(),
      pendingWrite: pendingWrite.current,
      unsavedTyping,
    });
    if (decision === 'conflict') {
      setMovedUnderneath(true);
      return;
    }
    if (decision === 'unchanged') return;
    lastFromServer.current = fromServer;
    setMovedUnderneath(false);
    // A response to this form's write may arrive while a newer edit is being
    // typed. Acknowledge that saved baseline without discarding the newer edit.
    form.reset(fromServer, {
      keepValues:
        unsavedTyping &&
        !agentEditState.sameConfig({
          left: form.getValues(),
          right: fromServer,
        }),
      keepDirty:
        unsavedTyping &&
        !agentEditState.sameConfig({
          left: form.getValues(),
          right: fromServer,
        }),
    });
  }, [agent, unsavedTyping, form]);

  const takeTheirVersion = () => {
    const fromServer = formValuesOf(agent);
    lastFromServer.current = fromServer;
    setMovedUnderneath(false);
    form.reset(fromServer);
  };

  const setServerError = (error: Error, fallback: string) =>
    form.setError('root.serverError', {
      type: 'manual',
      message: api.extractServerErrorMessage(error, fallback),
    });

  const markSavedUnlessEditedSince = (
    written: ConfigureAgentInput,
    saved: Agent,
  ) => {
    const fromServer = formValuesOf(saved);
    if (
      pendingBaseline.current !== null &&
      !agentEditState.sameConfig({
        left: latestFromServer.current,
        right: pendingBaseline.current,
      }) &&
      !agentEditState.sameConfig({
        left: latestFromServer.current,
        right: fromServer,
      })
    ) {
      // Another server version was observed after this write began. Preserve
      // that version and any newer local typing rather than clearing its
      // conflict merely because this older request finally completed.
      if (
        !agentEditState.sameConfig({
          left: form.getValues(),
          right: latestFromServer.current,
        })
      ) {
        setMovedUnderneath(true);
      }
      return false;
    }
    const editedSince = !agentEditState.sameConfig({
      left: form.getValues(),
      right: written,
    });
    lastFromServer.current = fromServer;
    setMovedUnderneath(false);
    form.reset(fromServer, { keepValues: editedSince, keepDirty: editedSince });
    return !editedSince;
  };

  const releaseWrite = () => {
    pendingWrite.current = null;
    pendingBaseline.current = null;
    writeLock.current.release();
  };
  const claimWrite = () => writeLock.current.claim();

  const handleSubmit = (values: ConfigureAgentValues) => {
    form.clearErrors('root.serverError');
    pendingBaseline.current = latestFromServer.current;
    pendingWrite.current = values;
    updateAgent.mutate(toUpdateRequest(values, agent), {
      onSuccess: (saved) => {
        const readyToTest = markSavedUnlessEditedSince(values, saved);
        toast(t('Published. Your Sydekyk is ready to chat.'));
        if (readyToTest) onExit();
      },
      onError: (error) =>
        setServerError(error, t("Your changes weren't saved. Try again.")),
      onSettled: releaseWrite,
    });
  };

  const saveAndGoLive = form.handleSubmit(handleSubmit, releaseWrite);
  const submitIfIdle = (event: React.FormEvent<HTMLFormElement>) => {
    if (movedUnderneath || !claimWrite()) {
      event.preventDefault();
      return;
    }
    void saveAndGoLive(event);
  };

  const requestExit = () => (unsavedTyping ? setExitRequested(true) : onExit());
  useImperativeHandle(ref, () => ({
    requestExit,
    canDesign: () => !unsavedTyping && !updateAgent.isPending,
  }));

  return (
    <Form {...form}>
      <Dialog open={reloadRequested} onOpenChange={setReloadRequested}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('Replace your unsaved edits?')}</DialogTitle>
            <DialogDescription>
              {t(
                'Your edits will be replaced with the latest saved version of this Sydekyk.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReloadRequested(false)}
            >
              {t('Keep editing')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                takeTheirVersion();
                setReloadRequested(false);
              }}
            >
              {t('Load saved version')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <LeaveWithoutSavingDialog
        open={leaveDecision.open}
        onKeepEditing={() => {
          setExitRequested(false);
          leaveBlocker.reset?.();
        }}
        onDiscard={() => {
          setExitRequested(false);
          if (leaveDecision.discardAction === 'proceed') {
            leaveBlocker.proceed?.();
            return;
          }
          onExit();
        }}
      />
      <form
        inert={disabled}
        aria-busy={disabled}
        onSubmit={submitIfIdle}
        className="flex h-full min-h-0 w-full shrink-0 flex-col"
      >
        <div className="flex min-h-0 grow flex-col">
          <div className="flex min-h-[60px] shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-6 px-[18px] py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base font-semibold leading-5 tracking-tight">
                {t('Configure')}
              </span>
              {unsavedTyping && (
                <span className="flex shrink-0 items-center gap-1.5 text-xs leading-4 text-gray-11">
                  <Dot variant="primary" className="size-1.5" />
                  {t('Unsaved')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasChanges && !movedUnderneath && (
                <Button type="submit" loading={updateAgent.isPending}>
                  {t('Publish & test')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={requestExit}
                className="gap-2"
                disabled={updateAgent.isPending}
              >
                <MessageSquare className="size-4" />
                {t('Chat with Sydekyk')}
              </Button>
            </div>
          </div>
          {movedUnderneath && (
            <div
              role="alert"
              className="flex flex-col gap-3 border-b border-gray-6 bg-gray-2 px-[18px] py-4 text-sm"
            >
              <p>
                {t(
                  'This Sydekyk changed in another editor. Your edits are still here. Load the saved version before publishing.',
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() => setReloadRequested(true)}
              >
                {t('Load saved version')}
              </Button>
            </div>
          )}
          <ScrollFade className="min-h-0 grow">
            <div className="flex flex-col gap-6 p-[18px]">
              <ConfigureIdentity agent={agent} form={form} />
              <ConfigureBehaviorTab
                form={form}
                needsModel={formNeedsModel}
                projectId={agent.projectId}
              />
              <UseInMissionNote projectId={agent.projectId} />
              <details className="border-t border-gray-6 pt-5 text-sm">
                <summary className="w-fit cursor-pointer text-gray-11 outline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9">
                  {t('Manage this Sydekyk')}
                </summary>
                <div className="flex flex-col gap-6 pt-5">
                  <AgentProjectRow agent={agent} />
                  <AgentDangerZone
                    agent={agent}
                    onDeleted={() => {
                      deletedRef.current = true;
                    }}
                  />
                </div>
              </details>
              {form.formState.errors.root?.serverError && (
                <p role="alert" className="text-sm leading-5 text-danger-11">
                  {form.formState.errors.root.serverError.message}
                </p>
              )}
            </div>
          </ScrollFade>
        </div>
      </form>
    </Form>
  );
});
AgentConfigurePanel.displayName = 'AgentConfigurePanel';

export { AgentConfigurePanel };
export type AgentConfigurePanelHandle = {
  requestExit: () => void;
  canDesign: () => boolean;
};
