import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, GraduationCap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import { Exam, lmsApi } from './lms-api';
import { LmsOperator } from './operator';
import { useLmsSession } from './session';

export function LearningPage() {
  const scope = useLmsSession();
  return <LearningSession key={scope} scope={scope} />;
}
function LearningSession({ scope }: { scope: number }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ['lms', scope, 'me'],
    queryFn: lmsApi.me,
  });
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'learn' | 'assessment' | 'operator'>('learn');
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
  const { course, enrollment, certificate, operator, attempts } = state.data;
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
            Partner learning
          </h1>
          <p className="mt-2 max-w-2xl text-gray-11">
            Build reliable AI workflows and a practical client service. Learn at
            your pace, then demonstrate your skills.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/">Back to workspace</Link>
        </Button>
      </header>
      <nav
        aria-label="Learning sections"
        className="mb-6 flex flex-wrap gap-2 border-b border-gray-6 pb-4"
      >
        <Button
          variant={tab === 'learn' ? 'default' : 'outline'}
          onClick={() => setTab('learn')}
        >
          Course
        </Button>
        <Button
          variant={tab === 'assessment' ? 'default' : 'outline'}
          onClick={() => setTab('assessment')}
        >
          Assessment
        </Button>
        {operator && (
          <Button
            variant={tab === 'operator' ? 'default' : 'outline'}
            onClick={() => setTab('operator')}
          >
            Instructor
          </Button>
        )}
      </nav>
      {message && (
        <p className="mb-4" role="status">
          {message}
        </p>
      )}
      {tab === 'operator' && operator ? (
        <LmsOperator scope={scope} />
      ) : !enrollment || !course ? (
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
            <nav aria-label="Course lessons">
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
              <article className="min-w-0 max-w-3xl">
                <h2 className="mb-5 text-xl font-semibold">{lesson.title}</h2>
                <div className="space-y-4 leading-7">
                  {lesson.body.split('\n\n').map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
                </div>
                <h3 className="mb-3 mt-8 text-lg font-semibold">
                  Put it into practice
                </h3>
                <p className="leading-7">{lesson.exercise}</p>
                {lesson.resources.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {lesson.resources.map((resource) => (
                      <li key={resource.url}>
                        <a
                          className="text-accent-11 underline underline-offset-4"
                          href={resource.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {resource.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-8">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        lmsApi.progress(
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
              safety check, then receive assessor approval. Both training
              packages use the same standard. This is a platform-specific
              credential issued by Sydekyks.
            </p>
            <p className="mt-2 text-sm text-gray-11">
              Assessment window ends{' '}
              {new Date(enrollment.assessmentUntil).toLocaleDateString()}. One
              resit is included for each failed component. Contact your
              instructor to arrange the practical walkthrough and your included
              coaching sessions.
            </p>
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
                  await lmsApi.assignment(submission);
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
  scope,
  enabled,
  exhausted,
}: {
  scope: number;
  enabled: boolean;
  exhausted: boolean;
}) {
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ['lms', scope, 'exam'],
    queryFn: lmsApi.currentExam,
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
        await queryClient.invalidateQueries({ queryKey: ['lms', scope, 'me'] });
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
          onClick={() => act(lmsApi.startExam)}
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
                            lmsApi.saveExam(exam.id, {
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
                act(() => lmsApi.saveExam(exam.id, exam.answers, true))
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
