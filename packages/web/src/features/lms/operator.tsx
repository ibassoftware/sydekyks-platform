import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useHostedBillingEnabled } from '@/features/hosted-billing/service-mode';
import {
  operatorClientsQuery,
  useHostedOperatorAccess,
} from '@/features/hosted-operator/operator-api';

import {
  Course,
  CourseContent,
  Enrollment,
  LearnerCandidate,
  lmsApi,
} from './lms-api';
import { lmsSessionVersion } from './session';

const safetyLabels = {
  credentials: 'Credentials are protected',
  isolation: 'Client data and access are separate',
  spending: 'Costs and spending limits are correct',
  recovery: 'Failure recovery and duplicate prevention work',
  humanApproval: 'Required human approvals are present',
};
export function LmsOperator({
  scope,
  globalOperator,
  trainer,
}: {
  scope: number;
  globalOperator: boolean;
  trainer: boolean;
}) {
  const client = useQueryClient();
  const courses = useQuery({
    queryKey: ['lms', scope, 'operator', 'courses'],
    queryFn: lmsApi.courses,
    gcTime: 0,
  });
  const access = useHostedOperatorAccess();
  const trainerClients = useQuery({
    queryKey: ['lms', scope, 'trainer', 'clients'],
    queryFn: lmsApi.trainerClients,
    enabled: trainer,
    gcTime: 0,
  });
  const [after, setAfter] = useState<string | null>(null);
  const clients = useQuery(
    operatorClientsQuery(
      access.session,
      after,
      globalOperator && access.allowed,
    ),
  );
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'partner' | 'global' | 'private'>(
    globalOperator ? 'global' : 'private',
  );
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current =
    courses.data?.find((item) => item.id === selected) ?? courses.data?.[0];
  if (courses.isPending) return <p role="status">Loading courses…</p>;
  if (courses.isError)
    return <p role="alert">Courses could not load. Refresh to try again.</p>;
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Manage courses</h1>
        <p className="mt-2 text-gray-11">
          Choose a course to edit its draft, publish it and manage its own
          enrollments. Published lessons stay fixed. Create a new course for a
          different audience or version.
        </p>
      </header>
      <label className="block max-w-3xl" htmlFor="managed-course">
        Course
        <select
          id="managed-course"
          className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
          value={current?.id ?? ''}
          onChange={(event) => setSelected(event.target.value)}
        >
          {!courses.data?.length && <option value="">No courses yet</option>}
          {courses.data?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.content.title} · {item.status} ·{' '}
              {item.ownerPlatformId
                ? item.ownerName || 'Private workspace'
                : item.audience === 'partner'
                ? 'Global partner training'
                : 'Global end-user learning'}
            </option>
          ))}
        </select>
      </label>
      <details className="max-w-3xl border-y border-gray-6 py-4">
        <summary className="cursor-pointer font-semibold">Add a course</summary>
        <form
          className="mt-4 space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setMessage('');
            try {
              const created = await lmsApi.createCourse({
                title,
                scope: kind === 'private' ? 'tenant' : 'global',
                ...(kind === 'private' && (globalOperator || trainer) && owner
                  ? { ownerPlatformId: owner }
                  : {}),
                audience: kind === 'partner' ? 'partner' : 'end_user',
                certificationMode: kind === 'partner' ? 'partner' : 'none',
              });
              await client.invalidateQueries({ queryKey: ['lms', scope] });
              setSelected(created.id);
              setTitle('');
              setMessage(
                'Course draft created. Review the content before publishing.',
              );
            } catch {
              setMessage(
                'The draft could not be created. Check your access and try again.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block" htmlFor="new-course-title">
            Course title
            <Input
              id="new-course-title"
              required
              minLength={3}
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block" htmlFor="new-course-kind">
            Audience and access
            <select
              id="new-course-kind"
              className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              {globalOperator && (
                <>
                  <option value="global">
                    Global end-user course · lessons only
                  </option>
                  <option value="partner">
                    Global partner training · exam and practical certification
                  </option>
                </>
              )}
              <option value="private">
                Private workspace course · lessons only
              </option>
            </select>
          </label>
          {(globalOperator || trainer) && kind === 'private' && (
            <div className="space-y-3">
              <label className="block" htmlFor="course-owner">
                Owning workspace
                <select
                  id="course-owner"
                  className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                >
                  <option value="">
                    {trainer
                      ? 'Choose an assigned client workspace'
                      : 'My current workspace'}
                  </option>
                  {(trainer ? trainerClients.data : clients.data?.clients)?.map(
                    (item) => (
                      <option key={item.platformId} value={item.platformId}>
                        {item.name}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {globalOperator && (
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!after}
                    onClick={() => {
                      setAfter(null);
                      setOwner('');
                    }}
                  >
                    First workspaces
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!clients.data?.next}
                    onClick={() => {
                      setAfter(clients.data?.next ?? null);
                      setOwner('');
                    }}
                  >
                    More workspaces
                  </Button>
                </div>
              )}
            </div>
          )}
          <p className="text-sm text-gray-11">
            Lesson-only courses do not include partner certification or training
            workspace credits. Partner status is approved separately.
          </p>
          <Button disabled={busy || (trainer && !owner)} type="submit">
            Create course draft
          </Button>
        </form>
        {globalOperator &&
          !courses.data?.some((item) => item.audience === 'partner') && (
            <Button
              className="mt-4"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const created = await lmsApi.initialize();
                  await client.invalidateQueries({ queryKey: ['lms', scope] });
                  setSelected(created.id);
                } catch {
                  setMessage('The founding draft could not be created.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create founding partner course draft
            </Button>
          )}
        {message && (
          <p className="mt-3" role="status">
            {message}
          </p>
        )}
      </details>
      {current && (
        <CourseEditor
          key={current.id}
          scope={scope}
          current={current}
          globalOperator={globalOperator}
          trainer={trainer}
        />
      )}
    </div>
  );
}
function CourseEditor({
  scope,
  current,
  globalOperator,
  trainer,
}: {
  scope: number;
  current: Course;
  globalOperator: boolean;
  trainer: boolean;
}) {
  const client = useQueryClient();
  const hosted = useHostedBillingEnabled();
  const course = { data: current, isPending: false, isError: false };
  const partnerTraining = current.audience === 'partner';
  const globalLookup = globalOperator && current.ownerPlatformId === null;
  const members = useQuery({
    queryKey: ['lms', scope, current.id, 'members'],
    queryFn: () => lmsApi.members(current.id),
    enabled: (!partnerTraining || trainer) && !globalLookup,
    gcTime: 0,
  });
  const enrollments = useQuery({
    queryKey: ['lms', scope, 'operator', current.id, 'enrollments'],
    queryFn: () => lmsApi.enrollments(current.id),
    gcTime: 0,
  });
  const [content, setContent] = useState<CourseContent | null>(null);
  const [selectedLesson, setSelectedLesson] = useState(0);
  const [selectedQuestion, setSelectedQuestion] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [identityId, setIdentityId] = useState('');
  const [learnerEmail, setLearnerEmail] = useState('');
  const [learner, setLearner] = useState<LearnerCandidate | null>(null);
  const [lookupMessage, setLookupMessage] = useState('');
  const [workspaceReviewRequired, setWorkspaceReviewRequired] = useState(false);
  const workspaceCreating = useRef(false);
  const [deliveryEnrollment, setDeliveryEnrollment] = useState('');
  const [repairWorkspace, setRepairWorkspace] = useState('');
  const [conversionEnrollment, setConversionEnrollment] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [workspacePlatformId, setWorkspacePlatformId] = useState('');
  const [tier, setTier] = useState<'core' | 'launch'>('core');
  const [verifiedPayment, setVerifiedPayment] = useState(false);
  const [selectedEnrollment, setSelectedEnrollment] = useState('');
  const [score, setScore] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [walkthrough, setWalkthrough] = useState(false);
  const [safety, setSafety] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(safetyLabels).map((key) => [key, false])),
  );
  useEffect(() => {
    if (course.data) {
      setContent(course.data.content);
      setReviewed(false);
    }
  }, [course.data]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await client.invalidateQueries({ queryKey: ['lms'] });
      setMessage('Saved.');
    } catch {
      setMessage(
        'This action was not completed. Check the requirements and refresh before retrying.',
      );
    } finally {
      setBusy(false);
    }
  };
  const delivery = enrollments.data?.find(
    (item) => item.id === deliveryEnrollment,
  );
  const deliveryLookup = useQuery({
    queryKey: [
      'lms',
      scope,
      'operator',
      'delivery-learner',
      delivery?.id,
      delivery?.learnerEmail,
    ],
    queryFn: () => lmsApi.lookupLearner(delivery?.learnerEmail ?? ''),
    enabled:
      hosted &&
      partnerTraining &&
      globalOperator &&
      !!delivery?.learnerEmail &&
      !delivery.training,
    retry: false,
    gcTime: 0,
  });
  const deliveryWorkspaces =
    deliveryLookup.data?.verified &&
    deliveryLookup.data.identityId === delivery?.identityId
      ? deliveryLookup.data.workspaces
      : [];
  const repairTarget =
    repairWorkspace ||
    deliveryWorkspaces.find(
      (item) => item.platformId === delivery?.workspacePlatformId,
    )?.platformId ||
    (deliveryWorkspaces.length === 1 ? deliveryWorkspaces[0].platformId : '');
  const deliveryOwned =
    !!delivery?.workspacePlatformId &&
    deliveryWorkspaces.some(
      (item) => item.platformId === delivery.workspacePlatformId,
    );
  async function findLearner() {
    setBusy(true);
    setLookupMessage('');
    setWorkspaceReviewRequired(false);
    setLearner(null);
    setWorkspacePlatformId('');
    setVerifiedPayment(false);
    try {
      const found = await lmsApi.lookupLearner(learnerEmail);
      setLearner(found);
      if (!found)
        setLookupMessage(
          'No account was found. Add the account in Partners and ask the learner to complete secure account setup, then search again.',
        );
      else if (!found.verified)
        setLookupMessage(
          'This learner needs email verification or an operator-issued account setup link before enrollment.',
        );
      else if (!partnerTraining)
        setLookupMessage('This learner is eligible for course access.');
      else if (!found.workspaces.length)
        setLookupMessage(
          'This eligible learner needs a training workspace before enrollment. Create it below; partner approval is separate.',
        );
      else if (found.workspaces.length === 1)
        setWorkspacePlatformId(found.workspaces[0].platformId);
    } catch {
      setLookupMessage(
        'The learner could not be checked. Confirm the email and refresh before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function createLearnerWorkspace() {
    if (
      workspaceCreating.current ||
      busy ||
      !learner?.verified ||
      learner.workspaces.length ||
      workspaceReviewRequired
    )
      return;
    workspaceCreating.current = true;
    const session = lmsSessionVersion();
    const candidate = learner;
    setBusy(true);
    setLookupMessage('');
    setWorkspacePlatformId('');
    setVerifiedPayment(false);
    try {
      const person =
        [candidate.firstName, candidate.lastName].join(' ').trim() ||
        candidate.email.split('@')[0] ||
        'Learner';
      const result = await lmsApi.createTrainingWorkspace(
        candidate.identityId,
        `${person.slice(0, 96)} training workspace`,
      );
      const refreshed = await lmsApi.lookupLearner(candidate.email);
      if (session !== lmsSessionVersion()) return;
      if (!refreshed?.verified || refreshed.identityId !== candidate.identityId)
        throw new Error('Learner lookup changed');
      setLearner(refreshed);
      const owned = refreshed.workspaces.find(
        (item) => item.platformId === result.platformId,
      );
      if (owned) {
        setWorkspacePlatformId(owned.platformId);
        setLookupMessage(
          'Training workspace is ready. Verify the receipt before recording enrollment. Partner status has not changed.',
        );
      } else {
        setWorkspaceReviewRequired(true);
        setLookupMessage(
          'The returned workspace is not owned by this learner. Operator review is required before enrollment; no workspace has been selected.',
        );
      }
    } catch {
      if (session === lmsSessionVersion())
        setLookupMessage(
          'Workspace setup could not be confirmed. Find the learner again before retrying.',
        );
    } finally {
      workspaceCreating.current = false;
      if (session === lmsSessionVersion()) setBusy(false);
    }
  }
  if (course.isPending || enrollments.isPending)
    return <p role="status">Loading instructor tools…</p>;
  if (course.isError || enrollments.isError)
    return (
      <p role="alert">Instructor tools could not load. Refresh to try again.</p>
    );
  const enrollment = enrollments.data?.find(
    (item) => item.id === selectedEnrollment,
  );
  const lesson = content?.lessons[selectedLesson];
  const question = content?.questions[selectedQuestion];
  const draft = current.status === 'draft' && current.canEdit;
  const changeContent = (next: CourseContent) => {
    setContent(next);
    setReviewed(false);
  };
  return (
    <div className="space-y-10">
      {message && <p role="status">{message}</p>}
      <section>
        <h2 className="text-xl font-semibold">
          {current.canEdit ? 'Course publication' : 'Course overview'}
        </h2>
        <p className="my-3 max-w-3xl text-gray-11">
          {partnerTraining && trainer
            ? 'This published partner course is managed by Sydekyks. Assign access to your learners below; payment, runtime allowances and credential approval are separate.'
            : partnerTraining
            ? 'Partner training includes a written exam and practical assessment. Review every lesson and the 60 or more question candidates before publishing.'
            : 'End-user courses contain lessons only. They do not issue partner credentials or activate hosting credits.'}{' '}
          Published content is fixed; create another course for later changes.
        </p>
        {!current ? (
          <Button disabled={busy} onClick={() => run(lmsApi.initialize)}>
            Create founding course draft
          </Button>
        ) : (
          content && (
            <div className="max-w-3xl space-y-4">
              <p className="font-medium">
                {current.status === 'published' ? 'Published' : 'Draft'} ·
                Revision {current.revision} · {content.lessons.length} lessons
                {current.canEdit && partnerTraining && (
                  <> · {content.questions.length} question candidates</>
                )}
              </p>
              <label className="block" htmlFor="course-title">
                Course title
                <Input
                  id="course-title"
                  disabled={!draft || busy}
                  value={content.title}
                  onChange={(event) =>
                    changeContent({ ...content, title: event.target.value })
                  }
                />
              </label>
              <label className="block" htmlFor="course-description">
                Description
                <Textarea
                  id="course-description"
                  disabled={!draft || busy}
                  value={content.description}
                  onChange={(event) =>
                    changeContent({
                      ...content,
                      description: event.target.value,
                    })
                  }
                />
              </label>
              <label className="block" htmlFor="lesson-editor-select">
                Review lesson
                <select
                  id="lesson-editor-select"
                  className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                  value={selectedLesson}
                  onChange={(event) =>
                    setSelectedLesson(Number(event.target.value))
                  }
                >
                  {content.lessons.map((item, index) => (
                    <option key={item.id} value={index}>
                      {index + 1}. {item.title}
                    </option>
                  ))}
                </select>
              </label>
              {draft && (
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    disabled={busy || content.lessons.length >= 60}
                    onClick={() => {
                      const next = [
                        ...content.lessons,
                        {
                          id: `lesson-${crypto.randomUUID()}`,
                          title: 'New lesson',
                          body: 'Write the lesson here.',
                          exercise: '',
                          resources: [],
                        },
                      ];
                      changeContent({ ...content, lessons: next });
                      setSelectedLesson(next.length - 1);
                    }}
                  >
                    Add lesson
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || content.lessons.length <= 1}
                    onClick={() => {
                      changeContent({
                        ...content,
                        lessons: content.lessons.filter(
                          (_, index) => index !== selectedLesson,
                        ),
                      });
                      setSelectedLesson(0);
                    }}
                  >
                    Remove selected lesson
                  </Button>
                </div>
              )}
              {lesson && (
                <>
                  <label className="block" htmlFor="lesson-title">
                    Lesson title
                    <Input
                      id="lesson-title"
                      disabled={!draft || busy}
                      value={lesson.title}
                      onChange={(event) =>
                        changeContent({
                          ...content,
                          lessons: content.lessons.map((item, index) =>
                            index === selectedLesson
                              ? { ...item, title: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="block" htmlFor="lesson-body">
                    Lesson text
                    <Textarea
                      id="lesson-body"
                      rows={10}
                      disabled={!draft || busy}
                      value={lesson.body}
                      onChange={(event) =>
                        changeContent({
                          ...content,
                          lessons: content.lessons.map((item, index) =>
                            index === selectedLesson
                              ? { ...item, body: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="block" htmlFor="lesson-exercise">
                    Exercise
                    <Textarea
                      id="lesson-exercise"
                      rows={3}
                      disabled={!draft || busy}
                      value={lesson.exercise}
                      onChange={(event) =>
                        changeContent({
                          ...content,
                          lessons: content.lessons.map((item, index) =>
                            index === selectedLesson
                              ? { ...item, exercise: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                </>
              )}
              {partnerTraining && current.canEdit && (
                <label className="block" htmlFor="question-editor-select">
                  Review exam question
                  <select
                    id="question-editor-select"
                    className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                    value={selectedQuestion}
                    onChange={(event) =>
                      setSelectedQuestion(Number(event.target.value))
                    }
                  >
                    {content.questions.map((item, index) => (
                      <option key={item.id} value={index}>
                        {index + 1}. {item.prompt}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {question && partnerTraining && (
                <fieldset className="space-y-3" disabled={!draft || busy}>
                  <legend className="mb-2 font-medium">
                    Question and answer key
                  </legend>
                  <label className="block" htmlFor="question-prompt">
                    Question
                    <Textarea
                      id="question-prompt"
                      value={question.prompt}
                      onChange={(event) =>
                        changeContent({
                          ...content,
                          questions: content.questions.map((item, index) =>
                            index === selectedQuestion
                              ? { ...item, prompt: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  {question.options.map((option, optionIndex) => (
                    <label
                      key={optionIndex}
                      className="block"
                      htmlFor={`option-${optionIndex}`}
                    >
                      Option {optionIndex + 1}
                      <Input
                        id={`option-${optionIndex}`}
                        value={option}
                        onChange={(event) =>
                          changeContent({
                            ...content,
                            questions: content.questions.map((item, index) =>
                              index === selectedQuestion
                                ? {
                                    ...item,
                                    options: item.options.map((value, index) =>
                                      index === optionIndex
                                        ? event.target.value
                                        : value,
                                    ),
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <label className="block" htmlFor="correct-option">
                    Correct answer
                    <select
                      id="correct-option"
                      className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                      value={question.correctIndex}
                      onChange={(event) =>
                        changeContent({
                          ...content,
                          questions: content.questions.map((item, index) =>
                            index === selectedQuestion
                              ? {
                                  ...item,
                                  correctIndex: Number(event.target.value),
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      {question.options.map((_, index) => (
                        <option key={index} value={index}>
                          Option {index + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
              )}
              {draft && (
                <>
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      run(() =>
                        lmsApi.saveCourse(
                          current.id,
                          current.revision,
                          content,
                        ),
                      )
                    }
                  >
                    Save reviewed edits
                  </Button>
                  <label className="flex items-start gap-3">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                    <span>
                      {partnerTraining
                        ? 'I reviewed the saved lessons and every exam question and answer for this revision.'
                        : 'I reviewed the saved lessons for this revision.'}
                    </span>
                  </label>
                  <Button
                    disabled={
                      busy ||
                      !reviewed ||
                      JSON.stringify(content) !==
                        JSON.stringify(current.content)
                    }
                    onClick={() =>
                      run(() => lmsApi.publish(current.id, current.revision))
                    }
                  >
                    Publish reviewed course
                  </Button>
                </>
              )}
            </div>
          )
        )}
      </section>
      {!partnerTraining || trainer ? (
        <section className="max-w-3xl space-y-4">
          <h2 className="text-xl font-semibold">Course enrollments</h2>
          <p className="text-gray-11">
            {partnerTraining
              ? 'Give an assigned partner access to this course and its assessments. This does not verify payment, grant hosting credits or change partner status. Sydekyks controls independent assessment and certification.'
              : 'Give this learner access to this course for one year. This does not grant partner status, certification or hosting credits.'}
          </p>
          {globalLookup ? (
            <div className="space-y-3">
              <label className="block" htmlFor="learning-email">
                Learner email
                <Input
                  id="learning-email"
                  type="email"
                  value={learnerEmail}
                  onChange={(event) => {
                    setLearnerEmail(event.target.value);
                    setLearner(null);
                  }}
                />
              </label>
              <Button
                variant="outline"
                disabled={busy || !learnerEmail.trim()}
                onClick={() => void findLearner()}
              >
                Find learner
              </Button>
              {learner?.verified && (
                <p className="break-words">Eligible learner: {learner.email}</p>
              )}
              {lookupMessage && <p role="status">{lookupMessage}</p>}
            </div>
          ) : (
            <label className="block" htmlFor="course-member">
              Workspace learner
              <select
                id="course-member"
                className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                value={identityId}
                onChange={(event) => setIdentityId(event.target.value)}
              >
                <option value="">Choose an eligible workspace member</option>
                {members.data?.map((member) => (
                  <option key={member.identityId} value={member.identityId}>
                    {member.firstName} {member.lastName} · {member.email}
                  </option>
                ))}
              </select>
              {members.isError && (
                <span role="alert">
                  Members could not load. Refresh to try again.
                </span>
              )}
            </label>
          )}
          <Button
            disabled={
              busy ||
              current.status !== 'published' ||
              !(globalLookup ? learner?.verified : identityId)
            }
            onClick={() =>
              run(() =>
                (partnerTraining
                  ? lmsApi.enrollPartnerCourse
                  : lmsApi.enrollLearning)(
                  globalLookup ? learner!.identityId : identityId,
                  current.id,
                ),
              )
            }
          >
            Enroll in this course
          </Button>
          <p className="text-sm text-gray-11">
            {enrollments.data?.length ?? 0} enrollment records for this course.
            Access to other courses is separate.
          </p>
          <ul className="space-y-3">
            {enrollments.data?.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-6 py-3"
              >
                <span className="min-w-0 break-words">
                  {item.learnerEmail || 'Learner'} · {item.status} · access
                  until {new Date(item.accessUntil).toLocaleDateString()}
                </span>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    item.status !== 'active' ||
                    (trainer &&
                      (item.certified ||
                        item.accessType === 'partner_training'))
                  }
                  onClick={() => run(() => lmsApi.revoke(item.id))}
                >
                  {trainer &&
                  (item.certified || item.accessType === 'partner_training')
                    ? 'Contact Sydekyks admin'
                    : 'Revoke course access'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="max-w-3xl">
          <h2 className="text-xl font-semibold">
            Record a verified enrollment
          </h2>
          <p className="my-3 text-gray-11">
            Find the eligible learner and their own workspace, then verify the
            receipt outside this form. Record learning access here and activate
            the included training workspace in the delivery section below.
          </p>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !current ||
                (hosted && (!learner?.verified || !workspacePlatformId))
              )
                return;
              void run(async () => {
                const converting = enrollments.data?.find(
                  (item) => item.id === conversionEnrollment,
                );
                if (
                  converting &&
                  converting.identityId !==
                    (hosted ? learner!.identityId : identityId)
                )
                  throw new Error(
                    'Choose the same learner as the course enrollment.',
                  );
                const recorded = conversionEnrollment
                  ? await lmsApi.convertTraining(conversionEnrollment, {
                      package: tier,
                      paymentReference,
                      workspacePlatformId,
                      paymentVerified: true,
                    })
                  : await lmsApi.enroll({
                      accessType: 'partner_training',
                      identityId: hosted ? learner!.identityId : identityId,
                      courseId: current.id,
                      package: tier,
                      paymentReference,
                      ...(workspacePlatformId ? { workspacePlatformId } : {}),
                      paymentVerified: true,
                    });
                setDeliveryEnrollment(recorded.id);
                setRepairWorkspace('');
                setVerifiedPayment(false);
              });
            }}
          >
            <label className="block" htmlFor="convert-enrollment">
              Paid training record
              <select
                id="convert-enrollment"
                className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                value={conversionEnrollment}
                onChange={(event) => {
                  const row = enrollments.data?.find(
                    (item) => item.id === event.target.value,
                  );
                  setConversionEnrollment(event.target.value);
                  setLearnerEmail(row?.learnerEmail ?? '');
                  setLearner(null);
                  setWorkspacePlatformId('');
                  setVerifiedPayment(false);
                }}
              >
                <option value="">New paid enrollment</option>
                {enrollments.data
                  ?.filter(
                    (item) =>
                      item.accessType === 'partner_course' &&
                      item.status === 'active',
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      Convert existing course access ·{' '}
                      {item.learnerEmail || 'Learner'}
                    </option>
                  ))}
              </select>
              <span className="mt-2 block text-sm text-gray-11">
                Converting keeps this learner’s progress, exam attempts and any
                existing credential. Hosting activation is separate.
              </span>
            </label>
            {hosted ? (
              <div className="space-y-3">
                <label className="block" htmlFor="learner-email">
                  Learner email
                  <Input
                    id="learner-email"
                    type="email"
                    value={learnerEmail}
                    disabled={busy}
                    onChange={(event) => {
                      setLearnerEmail(event.target.value);
                      setLearner(null);
                      setWorkspacePlatformId('');
                      setLookupMessage('');
                      setWorkspaceReviewRequired(false);
                      setVerifiedPayment(false);
                      setPaymentReference('');
                    }}
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !learnerEmail.trim()}
                  onClick={() => void findLearner()}
                >
                  Find learner
                </Button>
                {lookupMessage && (
                  <p role="status" className="text-sm">
                    {lookupMessage}
                  </p>
                )}
                {learner?.verified && (
                  <p className="break-words text-sm">
                    {learner.admissionSource === 'trainer'
                      ? 'Trainer admitted'
                      : learner.admissionSource === 'tenant_admin'
                      ? 'Client admin admitted'
                      : learner.admissionSource === 'operator'
                      ? 'Operator admitted'
                      : learner.verificationMethod === 'email' &&
                        learner.emailOwnershipVerified
                      ? 'Email verified'
                      : 'Eligible learner'}
                    : {learner.firstName} {learner.lastName} · {learner.email}
                  </p>
                )}
                {learner?.verified && learner.workspaces.length === 0 && (
                  <div className="space-y-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || workspaceReviewRequired}
                      onClick={() => void createLearnerWorkspace()}
                    >
                      Create training workspace
                    </Button>
                    <p className="text-sm text-gray-11">
                      Creates or reuses the learner’s normal hosted workspace.
                      It does not enroll them, verify payment or grant partner
                      status.
                    </p>
                  </div>
                )}
                <label className="block" htmlFor="learner-workspace">
                  Learner-owned workspace
                  <select
                    id="learner-workspace"
                    className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                    value={workspacePlatformId}
                    disabled={busy || !learner?.verified}
                    required
                    onChange={(event) => {
                      setWorkspacePlatformId(event.target.value);
                      setVerifiedPayment(false);
                    }}
                  >
                    <option value="">Choose the learner’s workspace</option>
                    {learner?.verified &&
                      learner.workspaces.map((item) => (
                        <option key={item.platformId} value={item.platformId}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            ) : (
              <label className="block" htmlFor="learner-identity">
                Eligible learner identity ID
                <Input
                  id="learner-identity"
                  value={identityId}
                  minLength={21}
                  maxLength={21}
                  required
                  onChange={(event) => setIdentityId(event.target.value)}
                />
              </label>
            )}
            <label className="block" htmlFor="payment-reference">
              Verified payment or receipt reference
              <Input
                id="payment-reference"
                value={paymentReference}
                minLength={3}
                maxLength={160}
                required
                onChange={(event) => setPaymentReference(event.target.value)}
              />
            </label>
            {!hosted && (
              <label className="block" htmlFor="workspace-platform">
                Workspace platform ID (optional)
                <Input
                  id="workspace-platform"
                  value={workspacePlatformId}
                  minLength={21}
                  maxLength={21}
                  onChange={(event) =>
                    setWorkspacePlatformId(event.target.value)
                  }
                />
              </label>
            )}
            <label className="block" htmlFor="training-package">
              Package
              <select
                id="training-package"
                className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                value={tier}
                onChange={(event) =>
                  setTier(event.target.value as 'core' | 'launch')
                }
              >
                <option value="core">
                  Core · two coaching hours · 60-day training workspace
                </option>
                <option value="launch">
                  Launch · four coaching hours · 90-day training workspace
                </option>
              </select>
            </label>
            <label className="flex items-start gap-3">
              <input
                className="mt-1"
                type="checkbox"
                checked={verifiedPayment}
                onChange={(event) => setVerifiedPayment(event.target.checked)}
              />
              <span>I verified this payment and the learner’s identity.</span>
            </label>
            <Button
              disabled={
                busy ||
                !verifiedPayment ||
                current?.status !== 'published' ||
                (hosted && (!learner?.verified || !workspacePlatformId))
              }
              type="submit"
            >
              {conversionEnrollment
                ? 'Convert to paid training'
                : 'Record enrollment'}
            </Button>
          </form>
        </section>
      )}
      {hosted && partnerTraining && globalOperator && (
        <section
          className="max-w-3xl space-y-4"
          aria-labelledby="training-delivery-heading"
        >
          <h2 id="training-delivery-heading" className="text-xl font-semibold">
            Training workspace delivery
          </h2>
          <p className="text-gray-11">
            Activate included workspace access after recording enrollment. This
            uses the saved package and receipt; it does not take a payment or
            extend a previous activation.
          </p>
          <label className="block" htmlFor="training-enrollment">
            Learner enrollment
            <select
              id="training-enrollment"
              className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
              value={deliveryEnrollment}
              onChange={(event) => {
                setDeliveryEnrollment(event.target.value);
                setRepairWorkspace('');
              }}
            >
              <option value="">Choose an enrollment</option>
              {enrollments.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.learnerEmail || 'Eligible learner'} · {item.package} ·{' '}
                  {item.paymentReference} · {item.status}
                </option>
              ))}
            </select>
          </label>
          {delivery && (
            <div className="space-y-4">
              {delivery.package === 'core' && delivery.training && (
                <section
                  className="space-y-3 border-y border-gray-6 py-4"
                  aria-labelledby="assessment-access-heading"
                >
                  <h3 id="assessment-access-heading" className="font-semibold">
                    Limited assessment workspace
                  </h3>
                  <p className="text-sm text-gray-11">
                    After the original 60-day training term, a Sydekyks assessor
                    can open one assessment allowance: 100 Credits and a fixed
                    $1 managed AI budget. It ends at the original 90-day
                    assessment deadline and cannot renew or restart.
                  </p>
                  {delivery.assessment ? (
                    <>
                      <p role="status" className="text-sm">
                        {delivery.assessment.revoked
                          ? 'Assessment access revoked'
                          : 'Assessment allowance created'}{' '}
                        · ends{' '}
                        {new Date(delivery.assessment.endsAt).toLocaleString()}.
                        Repeating activation does not reset usage or dates.
                      </p>
                      <Button
                        variant="outline"
                        disabled={busy || delivery.assessment.revoked}
                        onClick={() =>
                          run(() => lmsApi.revokeAssessment(delivery.id))
                        }
                      >
                        Revoke assessment workspace access
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        delivery.status !== 'active' ||
                        delivery.training.revoked ||
                        new Date(delivery.training.endsAt).getTime() >
                          Date.now() ||
                        new Date(delivery.assessmentUntil).getTime() <=
                          Date.now()
                      }
                      onClick={() =>
                        run(() => lmsApi.activateAssessment(delivery.id))
                      }
                    >
                      Open one-time assessment access
                    </Button>
                  )}
                </section>
              )}
              <p className="break-words text-sm">
                Receipt: {delivery.paymentReference} ·{' '}
                {delivery.package === 'core'
                  ? 'Core: 60 days'
                  : 'Launch: 90 days'}
              </p>
              {delivery.training ? (
                <p role="status">
                  {delivery.training.revoked
                    ? 'Training access revoked'
                    : 'Training workspace activated'}{' '}
                  · {new Date(delivery.training.startsAt).toLocaleDateString()}{' '}
                  – {new Date(delivery.training.endsAt).toLocaleDateString()}.
                  Repeating activation does not restart these dates.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    {delivery.workspaceName
                      ? `Saved workspace: ${delivery.workspaceName}`
                      : 'Workspace delivery has not been completed.'}
                  </p>
                  {deliveryLookup.isFetching ? (
                    <p role="status">
                      Checking the learner’s owned workspaces…
                    </p>
                  ) : deliveryLookup.isError ? (
                    <p role="alert">
                      Workspace ownership could not load. Refresh before
                      activating.
                    </p>
                  ) : (
                    <>
                      <label className="block" htmlFor="delivery-workspace">
                        Learner-owned workspace
                        <select
                          id="delivery-workspace"
                          className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
                          value={repairTarget}
                          disabled={busy || !deliveryWorkspaces.length}
                          onChange={(event) =>
                            setRepairWorkspace(event.target.value)
                          }
                        >
                          <option value="">
                            Choose the learner’s workspace
                          </option>
                          {deliveryWorkspaces.map((item) => (
                            <option
                              key={item.platformId}
                              value={item.platformId}
                            >
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!deliveryWorkspaces.length && (
                        <p className="text-sm">
                          An eligible learner-owned workspace is required before
                          activation. Find this learner above to complete
                          account and workspace setup, then refresh.
                        </p>
                      )}
                      {!deliveryOwned && (
                        <p className="text-sm">
                          Confirm the correct workspace below before activating.
                          This repair keeps the receipt, package and access
                          dates unchanged.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-3">
                        <Button
                          variant="outline"
                          disabled={
                            busy ||
                            !repairTarget ||
                            repairTarget === delivery.workspacePlatformId ||
                            delivery.status !== 'active'
                          }
                          onClick={() =>
                            run(() =>
                              lmsApi.bindWorkspace(
                                delivery.id,
                                repairTarget,
                                delivery.workspacePlatformId,
                              ),
                            )
                          }
                        >
                          Save learner-owned workspace
                        </Button>
                        <Button
                          disabled={
                            busy ||
                            !deliveryOwned ||
                            delivery.status !== 'active'
                          }
                          onClick={() =>
                            run(() => lmsApi.activateTraining(delivery.id))
                          }
                        >
                          Activate training workspace
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
              <Button
                variant="outline"
                disabled={
                  busy || enrollments.isFetching || deliveryLookup.isFetching
                }
                onClick={() => {
                  void enrollments.refetch();
                  if (!delivery.training) void deliveryLookup.refetch();
                }}
              >
                Refresh delivery status
              </Button>
            </div>
          )}
        </section>
      )}
      {partnerTraining && globalOperator && (
        <section>
          <h2 className="text-xl font-semibold">
            Practical review and certification
          </h2>
          <p className="my-3 text-gray-11">
            The practical review records a live walkthrough and mandatory safety
            checks. Issuing the certificate is a separate assessor action and
            requires both assessments to pass.
          </p>
          <label className="block max-w-3xl" htmlFor="review-enrollment">
            Learner enrollment
            <select
              id="review-enrollment"
              className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
              value={selectedEnrollment}
              onChange={(event) => {
                setSelectedEnrollment(event.target.value);
                setFeedback('');
                setScore(0);
                setWalkthrough(false);
                setSafety(
                  Object.fromEntries(
                    Object.keys(safetyLabels).map((key) => [key, false]),
                  ),
                );
              }}
            >
              <option value="">Choose an enrollment</option>
              {enrollments.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.learnerEmail || 'Eligible learner'} · {item.package} ·{' '}
                  {item.paymentReference} · {item.status}
                </option>
              ))}
            </select>
          </label>
          {enrollment && (
            <ReviewForm
              enrollment={enrollment}
              score={score}
              setScore={setScore}
              feedback={feedback}
              setFeedback={setFeedback}
              safety={safety}
              setSafety={setSafety}
              walkthrough={walkthrough}
              setWalkthrough={setWalkthrough}
              busy={busy}
              run={run}
            />
          )}
        </section>
      )}
    </div>
  );
}
function ReviewForm({
  enrollment,
  score,
  setScore,
  feedback,
  setFeedback,
  safety,
  setSafety,
  walkthrough,
  setWalkthrough,
  busy,
  run,
}: {
  enrollment: Enrollment;
  score: number;
  setScore: (value: number) => void;
  feedback: string;
  setFeedback: (value: string) => void;
  safety: Record<string, boolean>;
  setSafety: (value: Record<string, boolean>) => void;
  walkthrough: boolean;
  setWalkthrough: (value: boolean) => void;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="mt-5 max-w-3xl space-y-4">
      <p className="break-words text-sm text-gray-11">
        {enrollment.learnerEmail || 'Learner enrollment'} · Receipt{' '}
        {enrollment.paymentReference} · {enrollment.practicalReviews.length} of
        2 practical assessments used
      </p>
      {enrollment.assignment ? (
        <details open>
          <summary className="cursor-pointer font-medium">
            Submitted work
          </summary>
          <p className="mt-3 whitespace-pre-wrap break-words leading-7">
            {enrollment.assignment.submission}
          </p>
        </details>
      ) : (
        <p>No practical submission yet.</p>
      )}
      {enrollment.practicalReviews.map((review, index) => (
        <div key={index} className="border-y border-gray-6 py-3">
          <p className="font-medium">
            Review {index + 1}: {review.score}% ·{' '}
            {review.passed ? 'Passed' : 'Changes required'}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{review.feedback}</p>
        </div>
      ))}
      <label className="block" htmlFor="practical-score">
        Practical score (0–100)
        <Input
          id="practical-score"
          type="number"
          min={0}
          max={100}
          value={score}
          onChange={(event) => setScore(Number(event.target.value))}
        />
      </label>
      <fieldset className="space-y-3">
        <legend className="mb-3 font-medium">Mandatory safety checks</legend>
        {Object.entries(safetyLabels).map(([key, label]) => (
          <label key={key} className="flex items-start gap-3">
            <input
              className="mt-1"
              type="checkbox"
              checked={safety[key]}
              onChange={(event) =>
                setSafety({ ...safety, [key]: event.target.checked })
              }
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="block" htmlFor="assessor-feedback">
        Feedback
        <Textarea
          id="assessor-feedback"
          value={feedback}
          rows={4}
          minLength={20}
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>
      <label className="flex items-start gap-3">
        <input
          className="mt-1"
          type="checkbox"
          checked={walkthrough}
          onChange={(event) => setWalkthrough(event.target.checked)}
        />
        <span>
          I completed the live walkthrough and verified the learner’s own
          understanding.
        </span>
      </label>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={
            busy ||
            !enrollment.assignment ||
            !walkthrough ||
            feedback.trim().length < 20
          }
          onClick={() =>
            run(() =>
              lmsApi.review(enrollment.id, {
                score,
                safety,
                feedback,
                walkthroughCompleted: true,
              }),
            )
          }
        >
          Record practical assessment
        </Button>
        <Button
          disabled={busy || !enrollment.practicalReviews.at(-1)?.passed}
          variant="outline"
          onClick={() => run(() => lmsApi.certify(enrollment.id))}
        >
          Approve and issue certificate
        </Button>
        <Button
          disabled={busy || enrollment.status === 'revoked'}
          variant="destructive"
          onClick={() => run(() => lmsApi.revoke(enrollment.id))}
        >
          Revoke learning access and credential
        </Button>
      </div>
    </div>
  );
}
