import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { CourseContent, Enrollment, lmsApi } from './lms-api';

const safetyLabels = {
  credentials: 'Credentials are protected',
  isolation: 'Client data and access are separate',
  spending: 'Costs and spending limits are correct',
  recovery: 'Failure recovery and duplicate prevention work',
  humanApproval: 'Required human approvals are present',
};
export function LmsOperator({ scope }: { scope: number }) {
  const client = useQueryClient();
  const course = useQuery({
    queryKey: ['lms', scope, 'operator', 'course'],
    queryFn: lmsApi.course,
  });
  const enrollments = useQuery({
    queryKey: ['lms', scope, 'operator', 'enrollments'],
    queryFn: lmsApi.enrollments,
  });
  const [content, setContent] = useState<CourseContent | null>(null);
  const [selectedLesson, setSelectedLesson] = useState(0);
  const [selectedQuestion, setSelectedQuestion] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [identityId, setIdentityId] = useState('');
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
  if (course.isPending || enrollments.isPending)
    return <p role="status">Loading instructor tools…</p>;
  if (course.isError || enrollments.isError)
    return (
      <p role="alert">Instructor tools could not load. Refresh to try again.</p>
    );
  const current = course.data;
  const enrollment = enrollments.data?.find(
    (item) => item.id === selectedEnrollment,
  );
  const lesson = content?.lessons[selectedLesson];
  const question = content?.questions[selectedQuestion];
  const draft = current?.status === 'draft';
  const changeContent = (next: CourseContent) => {
    setContent(next);
    setReviewed(false);
  };
  return (
    <div className="space-y-10">
      {message && <p role="status">{message}</p>}
      <section>
        <h2 className="text-xl font-semibold">Course publication</h2>
        <p className="my-3 max-w-3xl text-gray-11">
          The supplied curriculum and 60 question candidates are drafts. Review
          every lesson and answer before publishing. Published content is fixed
          for this pilot so learners and exam attempts have a stable version.
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
                Revision {current.revision} · {content.questions.length}{' '}
                question candidates
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
              {question && (
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
                      run(() => lmsApi.saveCourse(current.id, content))
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
                      I reviewed the saved lessons and every exam question and
                      answer for this revision.
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
      <section className="max-w-3xl">
        <h2 className="text-xl font-semibold">Record a verified enrollment</h2>
        <p className="my-3 text-gray-11">
          Verify payment outside this form first. This records learning access
          only. Provision the private workspace and its training allowance
          through the hosting operator process.
        </p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!current) return;
            void run(() =>
              lmsApi.enroll({
                identityId,
                courseId: current.id,
                package: tier,
                paymentReference,
                ...(workspacePlatformId ? { workspacePlatformId } : {}),
                paymentVerified: true,
              }),
            );
          }}
        >
          <label className="block" htmlFor="learner-identity">
            Verified learner identity ID
            <Input
              id="learner-identity"
              value={identityId}
              minLength={21}
              maxLength={21}
              required
              onChange={(event) => setIdentityId(event.target.value)}
            />
          </label>
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
          <label className="block" htmlFor="workspace-platform">
            Workspace platform ID (optional)
            <Input
              id="workspace-platform"
              value={workspacePlatformId}
              minLength={21}
              maxLength={21}
              onChange={(event) => setWorkspacePlatformId(event.target.value)}
            />
          </label>
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
              busy || !verifiedPayment || current?.status !== 'published'
            }
            type="submit"
          >
            Record enrollment
          </Button>
        </form>
      </section>
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
                {item.identityId} · {item.package} · {item.status}
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
      <p className="text-sm text-gray-11">
        Enrollment {enrollment.id} · Receipt {enrollment.paymentReference} ·{' '}
        {enrollment.practicalReviews.length} of 2 practical assessments used
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
          disabled={
            busy ||
            !enrollment.workspacePlatformId ||
            enrollment.status === 'revoked'
          }
          variant="outline"
          onClick={() => run(() => lmsApi.activateTraining(enrollment.id))}
        >
          Activate training workspace
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
