import { api } from '@/lib/api';

import { lmsSessionVersion } from './session';

export type Lesson = {
  id: string;
  title: string;
  body: string;
  exercise: string;
  resources: { title: string; url: string }[];
};
export type Review = {
  score: number;
  safety: Record<string, boolean>;
  feedback: string;
  passed: boolean;
  reviewedAt: string;
};
export type Enrollment = {
  id: string;
  identityId: string;
  courseId: string;
  package: 'core' | 'launch';
  paymentReference: string;
  workspacePlatformId: string | null;
  startsAt: string;
  accessUntil: string;
  assessmentUntil: string;
  status: string;
  completedLessons: string[];
  assignment: { submission: string; submittedAt: string } | null;
  practicalReviews: Review[];
};
export type Certificate = {
  id: string;
  verificationToken: string;
  title: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export type Exam = {
  id: string;
  ordinal: number;
  startedAt: string;
  deadline: string;
  serverNow: string;
  submittedAt: string | null;
  score: number | null;
  passed: boolean | null;
  answers: Record<string, number>;
  questions: { id: string; prompt: string; options: string[] }[];
};
export type CourseContent = {
  title: string;
  description: string;
  lessons: Lesson[];
  questions: {
    id: string;
    prompt: string;
    options: string[];
    correctIndex: number;
  }[];
};
export type Course = {
  id: string;
  revision: number;
  status: 'draft' | 'published';
  content: CourseContent;
};
export type LearningState = {
  operator: boolean;
  enrollment: Enrollment | null;
  course: {
    id: string;
    revision: number;
    title: string;
    description: string;
    lessons: Lesson[];
  } | null;
  certificate: Certificate | null;
  attempts: Pick<
    Exam,
    'id' | 'ordinal' | 'deadline' | 'score' | 'passed' | 'submittedAt'
  >[];
};
const base = '/v1/lms';
const requests = {
  me: () => api.get<LearningState>(`${base}/me`),
  progress: (lessonId: string, completed: boolean) =>
    api.post(`${base}/progress`, { lessonId, completed }),
  assignment: (submission: string) =>
    api.post(`${base}/assignment`, { submission }),
  currentExam: () => api.get<Exam | null>(`${base}/exam/current`),
  startExam: () => api.post<Exam>(`${base}/exam/start`, {}),
  saveExam: (
    attemptId: string,
    answers: Record<string, number>,
    submit = false,
  ) =>
    api.post<Exam>(`${base}/exam/${submit ? 'submit' : 'save'}`, {
      attemptId,
      answers,
    }),
  course: () => api.get<Course | null>(`${base}/operator/course`),
  initialize: () => api.post<Course>(`${base}/operator/course/initialize`, {}),
  saveCourse: (id: string, content: CourseContent) =>
    api.any<Course>(`${base}/operator/course/${id}`, {
      method: 'PUT',
      data: content,
    }),
  publish: (id: string, revision: number) =>
    api.post<Course>(`${base}/operator/course/${id}/publish`, {
      revision,
      reviewedLessonsAndQuestions: true,
    }),
  enrollments: () => api.get<Enrollment[]>(`${base}/operator/enrollments`),
  enroll: (body: {
    identityId: string;
    courseId: string;
    package: 'core' | 'launch';
    paymentReference: string;
    workspacePlatformId?: string;
    paymentVerified: true;
  }) => api.post<Enrollment>(`${base}/operator/enroll`, body),
  review: (
    id: string,
    body: {
      score: number;
      safety: Record<string, boolean>;
      feedback: string;
      walkthroughCompleted: true;
    },
  ) => api.post(`${base}/operator/enrollments/${id}/review`, body),
  certify: (id: string) =>
    api.post<Certificate>(`${base}/operator/enrollments/${id}/certify`, {}),
  activateTraining: (id: string) =>
    api.post(`/v1/hosting/operator/training/enrollments/${id}/activate`, {}),
  revoke: (id: string) =>
    api.post(`${base}/operator/enrollments/${id}/revoke`, {}),
  verify: (token: string) =>
    api.get<{
      id: string;
      title: string;
      issuedAt: string;
      expiresAt: string;
      status: string;
      issuer: string;
      scope: string;
    }>(`${base}/certificates/${token}`),
};

// Guard every response even when the hosted document boundary is disabled.
// Epochs avoid retaining bearer tokens in query keys or diagnostic displays.
export const lmsApi = Object.fromEntries(
  Object.entries(requests).map(([name, request]) => [
    name,
    async (...args: unknown[]) => {
      const session = lmsSessionVersion();
      const result = await (
        request as (...values: unknown[]) => Promise<unknown>
      )(...args);
      if (session !== lmsSessionVersion())
        throw new Error('Your learning session changed. Please try again.');
      return result;
    },
  ]),
) as typeof requests;
