import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, GraduationCap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  useHostedBillingEnabled,
  useHostedRuntimeReady,
} from '@/features/hosted-billing/service-mode';

import { Exam, lmsApi } from './lms-api';
import { LmsOperator } from './operator';
import { useLmsSession } from './session';

export function LearningPage() {
  const scope = useLmsSession();
  const hosted = useHostedBillingEnabled();
  const pilotReady = useHostedRuntimeReady();
  return (
    <>
      <header className="mx-auto flex w-full max-w-6xl px-4 pt-6 md:px-8">
        <Button asChild variant="outline">
          <Link to="/">Back to workspace</Link>
        </Button>
      </header>
      <LearningCatalogue
        key={scope}
        scope={scope}
        hosted={hosted}
        pilotReady={pilotReady}
      />
    </>
  );
}
function LearningCatalogue({
  scope,
  hosted,
  pilotReady,
}: {
  scope: number;
  hosted: boolean;
  pilotReady: boolean;
}) {
  const catalogue = useQuery({
    queryKey: ['lms', scope, 'me'],
    queryFn: lmsApi.me,
    gcTime: 0,
  });
  const [selection, setSelection] = useState('');
  const [manage, setManage] = useState(false);
  if (catalogue.isPending)
    return (
      <p className="p-6" role="status">
        Loading your courses…
      </p>
    );
  if (catalogue.isError)
    return (
      <p className="p-6" role="alert">
        Courses could not load. Refresh to try again.
      </p>
    );
  const selected =
    catalogue.data.enrollments.find((item) => item.id === selection)?.id ??
    catalogue.data.enrollments[0]?.id;
  return (
    <>
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end gap-4 px-4 pt-6 md:px-8">
        <label className="min-w-0 flex-1" htmlFor="enrolled-course">
          Your courses
          <select
            id="enrolled-course"
            className="mt-2 block w-full rounded-md border border-gray-6 bg-gray-1 p-2"
            value={selected ?? ''}
            onChange={(event) => {
              setSelection(event.target.value);
              setManage(false);
            }}
          >
            {!catalogue.data.enrollments.length && (
              <option value="">No course access yet</option>
            )}
            {catalogue.data.enrollments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        {catalogue.data.canManage && (
          <Button
            variant={manage ? 'default' : 'outline'}
            aria-pressed={manage}
            onClick={() => setManage(!manage)}
          >
            Manage courses
          </Button>
        )}
      </div>
      {manage ? (
        <main className="mx-auto w-full max-w-6xl p-4 md:p-8">
          <LmsOperator
            scope={scope}
            globalOperator={catalogue.data.operator}
            trainer={catalogue.data.trainer}
          />
        </main>
      ) : selected ? (
        <LearningSession
          key={selected}
          enrollmentId={selected}
          scope={scope}
          hosted={hosted}
          pilotReady={pilotReady}
        />
      ) : (
        <main className="mx-auto max-w-6xl p-6">
          <h1 className="text-2xl font-semibold">Learning</h1>
          <p className="mt-3">
            Your instructor will give you access to the courses included in your
            training.
          </p>
        </main>
      )}
    </>
  );
}
function LearningSession({
  scope,
  hosted,
  pilotReady,
  enrollmentId,
}: {
  scope: number;
  hosted: boolean;
  pilotReady: boolean;
  enrollmentId: string;
}) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ['lms', scope, 'learning', enrollmentId],
    queryFn: () => lmsApi.learning(enrollmentId),
    gcTime: 0,
  });
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'learn' | 'assessment'>('learn');
  const [submission, setSubmission] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ['lms'] });
      setMessage('Saved.');
    } catch {
      setMessage(
        'We could not save this change. Check your access and try again, or contact your instructor.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (state.isPending)
    return (
      <p className="p-6" role="status">
        Loading your learning workspace…
      </p>
    );
  if (state.isError)
    return (
      <div className="p-6">
        <p role="alert">Your learning workspace could not load.</p>
        <Button variant="outline" onClick={() => state.refetch()}>
          Try again
        </Button>
      </div>
    );
  const { course, enrollment, certificate, attempts } = state.data;
  const lesson =
    course?.lessons.find((item) => item.id === selected) ?? course?.lessons[0];
  const practical = enrollment?.practicalReviews.at(-1);
  const waitingReview =
    !!enrollment?.assignment &&
    (!practical || practical.reviewedAt < enrollment.assignment.submittedAt);
  return (
    <main className="mx-auto w-full max-w-6xl p-4 md:p-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <GraduationCap aria-hidden="true" />
            Learning
          </h1>
          <p className="mt-2 max-w-2xl text-gray-11">
            Build reliable AI workflows and a practical client service. Learn at
            your pace, then demonstrate your skills.
          </p>
        </div>
      </header>
      {hosted && course?.audience === 'partner' && (
        <section
          aria-labelledby="learning-pilot-scope"
          className="mb-6 border-y border-gray-6 py-4"
        >
          <h2 id="learning-pilot-scope" className="font-semibold">
            Practice in your workspace
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
            Build Agents and workflows with the Gadgets available in your
            workspace. Sydekyks AI uses your Credits; connected services may
            require your own account. Review outputs before sharing them with a
            client.
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-11">
            Use only configured tools and connections. Remote MCP and provider
            search or image tools are not included in this hosted release.
          </p>
          {!pilotReady && (
            <p role="status" className="mt-3 text-sm">
              This training workspace is not ready yet. Contact Sydekyks support
              before starting the examples.
            </p>
          )}
        </section>
      )}

      <nav
        aria-label="Learning sections"
        className="mb-6 flex flex-wrap gap-2 border-b border-gray-6 pb-4"
      >
        <Button
          variant={tab === 'learn' ? 'default' : 'outline'}
          aria-pressed={tab === 'learn'}
          onClick={() => setTab('learn')}
        >
          Course
        </Button>
        {course?.certificationMode === 'partner' && (
          <Button
            variant={tab === 'assessment' ? 'default' : 'outline'}
            aria-pressed={tab === 'assessment'}
            onClick={() => setTab('assessment')}
          >
            Assessment
          </Button>
        )}
      </nav>
      {message && (
        <p className="mb-4" role="status">
          {message}
        </p>
      )}
      {!enrollment || !course ? (
        <section className="py-8">
          <h2 className="text-xl font-semibold">
            Your course access is not active yet
          </h2>
          <p className="mt-3 max-w-2xl text-gray-11">
            Enrollment is confirmed by the Sydekyks team after payment
            verification. Contact your instructor if you expected access. A
            hosting subscription alone does not enroll you.
          </p>
        </section>
      ) : tab === 'learn' ? (
        <>
          <p className="mb-6 text-sm text-gray-11">
            {enrollment.completedLessons.length} of {course.lessons.length}{' '}
            lessons complete · Course access until{' '}
            {new Date(enrollment.accessUntil).toLocaleDateString()}
          </p>
          <div className="grid gap-8 md:grid-cols-[260px_1fr]">
            <div className="min-w-0 md:hidden">
              <label
                htmlFor="course-lesson"
                className="mb-2 block text-sm font-medium"
              >
                Course lesson
              </label>
              <select
                id="course-lesson"
                aria-controls="learning-lesson"
                value={lesson?.id ?? ''}
                onChange={(event) => setSelected(event.target.value)}
                className="min-w-0 w-full max-w-full rounded-md border border-gray-6 bg-gray-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9"
              >
                {course.lessons.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    {index + 1}. {item.title}
                    {enrollment.completedLessons.includes(item.id)
                      ? ' · Complete'
                      : ''}
                  </option>
                ))}
              </select>
            </div>
            <nav aria-label="Course lessons" className="hidden md:block">
              <ol className="divide-y divide-gray-6">
                {course.lessons.map((item, index) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={lesson?.id === item.id ? 'step' : undefined}
                      className="flex w-full items-start gap-3 rounded-md p-3 text-left hover:bg-gray-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-9 aria-[current=step]:bg-gray-3"
                      onClick={() => setSelected(item.id)}
                    >
                      <span className="shrink-0 text-gray-11">
                        {index + 1}.
                      </span>
                      <span className="flex-1">{item.title}</span>
                      {enrollment.completedLessons.includes(item.id) && (
                        <Check
                          className="size-4 shrink-0"
                          aria-label="Complete"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            {lesson && (
              <article id="learning-lesson" className="min-w-0 max-w-3xl">
                <h2 className="mb-5 text-xl font-semibold">{lesson.title}</h2>
                <div className="space-y-4 leading-7">
                  {lesson.body
                    .replaceAll('\\n', '\n')
                    .split('\n\n')
                    .map((paragraph, index) => (
                      <p key={index}>{paragraph}</p>
                    ))}
                </div>
                <h3 className="mb-3 mt-8 text-lg font-semibold">
                  Put it into practice
                </h3>
                <p className="leading-7">{lesson.exercise}</p>
                {lesson.resources.length > 0 &&
                  (course.audience !== 'partner' || !hosted || pilotReady) && (
                    <ul className="mt-4 space-y-2">
                      {lesson.resources.map((resource) => (
                        <li key={resource.url}>
                          <a
                            className="text-accent-11 underline underline-offset-4"
                            href={resource.url}
                            download={
                              resource.url.startsWith('/learning/templates/') ||
                              undefined
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            {resource.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                {course.certificationMode === 'none' &&
                  course.lessons.every((item) =>
                    enrollment.completedLessons.includes(item.id),
                  ) && (
                    <p className="mt-6 font-medium" role="status">
                      All lessons complete. This course does not issue a partner
                      certificate.
                    </p>
                  )}
                <div className="mt-8">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        lmsApi.progress(
                          enrollmentId,
                          lesson.id,
                          !enrollment.completedLessons.includes(lesson.id),
                        ),
                      )
                    }
                  >
                    {enrollment.completedLessons.includes(lesson.id)
                      ? 'Mark incomplete'
                      : 'Mark lesson complete'}
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              </article>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="text-xl font-semibold">
              Earn your Sydekyks certification
            </h2>
            <p className="mt-3 max-w-3xl leading-7">
              Pass the written exam and practical assessment, including every
              safety check, then receive assessor approval. This is a
              platform-specific credential issued by Sydekyks.
            </p>
            <p className="mt-2 text-sm text-gray-11">
              Assessment window ends{' '}
              {new Date(enrollment.assessmentUntil).toLocaleDateString()}. One
              resit is included for each failed component. Contact your
              instructor to arrange the practical walkthrough. Coaching and
              hosted workspace allowances depend on your package.
            </p>
            {enrollment.accessType === 'partner_course' && (
              <p className="mt-3 text-sm text-gray-11">
                Your access covers this course and its assessments. Payment,
                coaching and hosted workspace access are arranged separately.
              </p>
            )}
            {enrollment.package === 'core' && (
              <div className="mt-4 border-y border-gray-6 py-4 text-sm leading-6">
                <p>
                  Your recorded hosting dates and remaining Credits are shown in
                  Billing. If hosting ends before your assessment deadline,
                  contact a Sydekyks assessor to request limited one-time
                  assessment access.
                </p>
                {enrollment.assessment && (
                  <p className="mt-2" role="status">
                    {enrollment.assessment.revoked
                      ? 'Assessment workspace access has been revoked.'
                      : `Your one-time assessment workspace allowance ends ${new Date(
                          enrollment.assessment.endsAt,
                        ).toLocaleString()}. Usage and dates do not restart.`}
                  </p>
                )}
              </div>
            )}
            {certificate && (
              <div className="mt-4 border-y border-gray-6 py-4">
                <p className="font-medium">
                  {certificate.revokedAt
                    ? 'Credential revoked'
                    : certificate.title}
                </p>
                <Link
                  className="text-accent-11 underline underline-offset-4"
                  to={`/learn/verify/${certificate.verificationToken}`}
                >
                  Verify certificate
                </Link>
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-3 text-lg font-semibold">Written exam</h3>
            <p className="mb-4 text-gray-11">
              30 randomized questions · 45 minutes · 80% to pass. Finish all
              lessons before starting. The clock continues if you close or
              refresh this page; saved answers resume on return.
            </p>
            <WrittenExam
              enrollmentId={enrollmentId}
              scope={scope}
              enabled={
                enrollment.completedLessons.length === course.lessons.length
              }
              exhausted={
                attempts.length >= 2 ||
                attempts.some((attempt) => attempt.passed)
              }
            />
          </section>
          <section className="max-w-3xl">
            <h3 className="text-lg font-semibold">Practical assessment</h3>
            <p className="my-3 leading-7">
              Submit your workflow demonstration notes, test record, cost
              estimate, proposal and handover instructions. Include a demo link
              if appropriate. Use sample data and never include credentials or
              private client information. You need at least 80%, all safety
              checks and a live walkthrough.
            </p>
            {practical && (
              <div className="mb-4 border-y border-gray-6 py-4">
                <p className="font-medium">
                  {practical.passed ? 'Practical passed' : 'Changes required'} ·{' '}
                  {practical.score}%
                </p>
                <p className="mt-2 whitespace-pre-wrap">{practical.feedback}</p>
              </div>
            )}
            {enrollment.assignment && (
              <details className="mb-4">
                <summary className="cursor-pointer text-accent-11">
                  View submitted work
                </summary>
                <p className="mt-3 whitespace-pre-wrap break-words">
                  {enrollment.assignment.submission}
                </p>
              </details>
            )}
            <label className="mb-2 block font-medium" htmlFor="capstone">
              Your capstone submission
            </label>
            <Textarea
              id="capstone"
              value={submission}
              onChange={(event) => setSubmission(event.target.value)}
              rows={8}
              maxLength={30000}
              disabled={
                busy ||
                waitingReview ||
                !!practical?.passed ||
                enrollment.practicalReviews.length >= 2
              }
            />
            <p className="my-2 text-sm text-gray-11">
              At least 100 characters. Submitted work is locked until reviewed.
            </p>
            <Button
              disabled={
                busy ||
                submission.trim().length < 100 ||
                waitingReview ||
                !!practical?.passed ||
                enrollment.practicalReviews.length >= 2
              }
              onClick={() =>
                run(async () => {
                  await lmsApi.assignment(enrollmentId, submission);
                  setSubmission('');
                })
              }
            >
              {waitingReview
                ? 'Awaiting assessor review'
                : 'Submit for practical review'}
            </Button>
          </section>
        </div>
      )}
    </main>
  );
}

function WrittenExam({
  enrollmentId,
  scope,
  enabled,
  exhausted,
}: {
  enrollmentId: string;
  scope: number;
  enabled: boolean;
  exhausted: boolean;
}) {
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ['lms', scope, enrollmentId, 'exam'],
    queryFn: () => lmsApi.currentExam(enrollmentId),
    gcTime: 0,
  });
  const [exam, setExam] = useState<Exam | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (current.data) setExam(current.data);
  }, [current.data]);
  useEffect(() => {
    if (!exam || exam.submittedAt) return;
    const offset = new Date(exam.serverNow).getTime() - Date.now();
    const tick = () =>
      setRemaining(
        Math.max(
          0,
          Math.ceil(
            (new Date(exam.deadline).getTime() - Date.now() - offset) / 1000,
          ),
        ),
      );
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [exam]);
  const act = async (work: () => Promise<Exam>) => {
    setBusy(true);
    setError('');
    try {
      const next = await work();
      setExam(next);
      if (next.submittedAt)
        await queryClient.invalidateQueries({
          queryKey: ['lms', scope, 'learning', enrollmentId],
        });
    } catch {
      setError(
        'Your answer could not be saved. Check your connection and try again. The exam clock continues.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (current.isPending) return <p role="status">Checking your exam…</p>;
  if (current.isError)
    return <p role="alert">Your exam could not load. Refresh to reconnect.</p>;
  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 text-danger-11">
          {error}
        </p>
      )}
      {exam?.submittedAt && (
        <p className="mb-3 font-medium">
          Attempt {exam.ordinal}: {exam.score}% ·{' '}
          {exam.passed ? 'Passed' : 'Not passed'}
        </p>
      )}
      {!exam || exam.submittedAt ? (
        <Button
          disabled={!enabled || exhausted || busy}
          onClick={() => act(() => lmsApi.startExam(enrollmentId))}
        >
          {exhausted
            ? 'No further written attempt available'
            : exam
            ? 'Start included resit'
            : 'Start 45-minute exam'}
        </Button>
      ) : (
        <>
          <div className="sticky top-0 z-10 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-gray-6 bg-gray-1 py-3">
            <p role="timer" className="font-medium tabular-nums">
              {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, '0')} remaining
            </p>
            <span className="text-sm text-gray-11" role="status">
              {busy
                ? 'Saving…'
                : 'Changes are saved when you select an answer.'}
            </span>
          </div>
          {remaining === 0 && (
            <p className="mb-4" role="status">
              Time has ended. Your saved answers will be graded; late changes
              are not accepted.
            </p>
          )}
          <div className="max-w-3xl space-y-8">
            {exam.questions.map((question, index) => (
              <fieldset key={question.id} disabled={busy || remaining === 0}>
                <legend className="mb-3 font-medium">
                  {index + 1}. {question.prompt}
                </legend>
                <div className="space-y-2">
                  {question.options.map((option, optionIndex) => (
                    <label
                      key={optionIndex}
                      className="flex cursor-pointer items-start gap-3 rounded-md border border-gray-6 p-3 hover:bg-gray-3"
                    >
                      <input
                        className="mt-1 accent-current"
                        type="radio"
                        name={question.id}
                        checked={exam.answers[question.id] === optionIndex}
                        onChange={() =>
                          act(() =>
                            lmsApi.saveExam(enrollmentId, exam.id, {
                              ...exam.answers,
                              [question.id]: optionIndex,
                            }),
                          )
                        }
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <div className="mt-6">
            <Button
              disabled={busy}
              onClick={() =>
                act(() =>
                  lmsApi.saveExam(enrollmentId, exam.id, exam.answers, true),
                )
              }
            >
              {remaining === 0
                ? 'Finish timed-out attempt'
                : 'Submit exam for grading'}
            </Button>
            <p className="mt-2 text-sm text-gray-11">
              Submission is final. Unanswered questions receive no credit.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
