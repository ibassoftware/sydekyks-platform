import { currentAuthSession } from '@/features/hosted-onboarding/auth-session';
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
  grantPlatformId: string | null;
  accessType: 'learning' | 'partner_course' | 'partner_training';
  package: 'core' | 'launch' | null;
  paymentReference: string | null;
  workspacePlatformId: string | null;
  startsAt: string;
  accessUntil: string;
  assessmentUntil: string;
  status: string;
  completedLessons: string[];
  assignment: { submission: string; submittedAt: string } | null;
  practicalReviews: Review[];
  learnerEmail?: string | null;
  workspaceName?: string | null;
  certified?: boolean;
  assessment?: {
    id: string;
    startsAt: string;
    endsAt: string;
    revoked: boolean;
  } | null;
  training?: {
    activated: true;
    startsAt: string;
    endsAt: string;
    revoked: boolean;
  } | null;
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
  ownerPlatformId: string | null;
  ownerName?: string | null;
  audience: 'partner' | 'end_user';
  certificationMode: 'partner' | 'none';
  canEdit: boolean;
  clientDefault?: boolean;
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
    certificationMode: 'partner' | 'none';
    audience: 'partner' | 'end_user';
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
export type LearnerCandidate = {
  identityId: string;
  email: string;
  firstName: string;
  lastName: string;
  verified: boolean;
  verificationMethod: 'operator' | 'email' | 'pending';
  admissionSource:
    | 'tenant_admin'
    | 'operator'
    | 'trainer'
    | 'email'
    | 'pending';
  emailOwnershipVerified: boolean;
  workspaces: { platformId: string; name: string }[];
};
const base = '/v1/lms';
const requests = {
  createTrainingWorkspace: (identityId: string, name: string) =>
    api.post<{ platformId: string; created: boolean }>(
      '/v1/hosting/operator/tenants/owned-home',
      { identityId, name },
    ),
  lookupLearner: async (email: string) => {
    const session = currentAuthSession();
    const result = await api.get<{
      platformId: string;
      userId: string;
      candidate: LearnerCandidate | null;
    }>('/v1/hosting/operator/partners/lookup', {
      email: email.trim().toLowerCase(),
    });
    if (
      session.kind !== 'user' ||
      result.platformId !== session.platformId ||
      result.userId !== session.id
    )
      throw new Error('The learner lookup could not be verified.');
    return result.candidate;
  },
  bindWorkspace: (
    id: string,
    workspacePlatformId: string,
    expectedWorkspacePlatformId: string | null,
  ) =>
    api.post(`${base}/operator/enrollments/${id}/workspace`, {
      workspacePlatformId,
      expectedWorkspacePlatformId,
    }),
  me: () =>
    api.get<{
      operator: boolean;
      canManage: boolean;
      trainer: boolean;
      enrollments: {
        id: string;
        courseId: string;
        title: string;
        certificationMode: 'partner' | 'none';
        description: string;
        completedLessons: number;
        totalLessons: number;
      }[];
    }>(`${base}/me`),
  learning: (id: string) => api.get<LearningState>(`${base}/enrollments/${id}`),
  progress: (enrollmentId: string, lessonId: string, completed: boolean) =>
    api.post(`${base}/enrollments/${enrollmentId}/progress`, {
      lessonId,
      completed,
    }),
  assignment: (enrollmentId: string, submission: string) =>
    api.post(`${base}/enrollments/${enrollmentId}/assignment`, { submission }),
  currentExam: (enrollmentId: string) =>
    api.get<Exam | null>(`${base}/enrollments/${enrollmentId}/exam/current`),
  startExam: (enrollmentId: string) =>
    api.post<Exam>(`${base}/enrollments/${enrollmentId}/exam/start`, {}),
  saveExam: (
    enrollmentId: string,
    attemptId: string,
    answers: Record<string, number>,
    submit = false,
  ) =>
    api.post<Exam>(
      `${base}/enrollments/${enrollmentId}/exam/${submit ? 'submit' : 'save'}`,
      {
        attemptId,
        answers,
      },
    ),
  trainerClients: () =>
    api.get<{ platformId: string; name: string }[]>(`${base}/operator/clients`),
  clientContext: (platformId: string) =>
    api.get<{
      platformId: string;
      name: string;
      learners: {
        identityId: string;
        email: string;
        firstName: string;
        lastName: string;
      }[];
    }>(`${base}/operator/client/${platformId}`),
  setClientDefault: (courseId: string, enabled: boolean) =>
    api.post<Course>(`${base}/operator/course/${courseId}/client-default`, {
      enabled,
    }),
  courses: () => api.get<Course[]>(`${base}/operator/courses`),
  createCourse: (body: {
    title: string;
    scope: 'global' | 'tenant';
    ownerPlatformId?: string;
    audience: 'partner' | 'end_user';
    certificationMode: 'partner' | 'none';
  }) => api.post<Course>(`${base}/operator/courses`, body),
  members: (courseId: string) =>
    api.get<
      {
        identityId: string;
        email: string;
        firstName: string;
        lastName: string;
      }[]
    >(`${base}/operator/members`, { courseId }),
  initialize: () => api.post<Course>(`${base}/operator/course/initialize`, {}),
  saveCourse: (id: string, expectedRevision: number, content: CourseContent) =>
    api.any<Course>(`${base}/operator/course/${id}`, {
      method: 'PUT',
      data: { expectedRevision, content },
    }),
  publish: (id: string, revision: number) =>
    api.post<Course>(`${base}/operator/course/${id}/publish`, {
      revision,
      reviewedLessonsAndQuestions: true,
    }),
  enrollments: (courseId: string) =>
    api.get<Enrollment[]>(`${base}/operator/enrollments`, { courseId }),
  enroll: (body: {
    accessType: 'partner_training';
    identityId: string;
    courseId: string;
    package: 'core' | 'launch';
    paymentReference: string;
    workspacePlatformId?: string;
    paymentVerified: true;
  }) => api.post<Enrollment>(`${base}/operator/enroll`, body),
  convertTraining: (
    id: string,
    body: {
      package: 'core' | 'launch';
      paymentReference: string;
      workspacePlatformId: string;
      paymentVerified: true;
    },
  ) =>
    api.post<Enrollment>(
      `${base}/operator/enrollments/${id}/convert-training`,
      { ...body, expectedPriorAccessType: 'partner_course' },
    ),
  activateAssessment: (id: string) =>
    api.post(`/v1/hosting/operator/assessment/enrollments/${id}/activate`, {}),
  revokeAssessment: (id: string) =>
    api.post(`/v1/hosting/operator/assessment/enrollments/${id}/revoke`, {}),
  enrollPartnerCourse: (identityId: string, courseId: string) =>
    api.post<Enrollment>(`${base}/operator/enroll`, {
      accessType: 'partner_course',
      identityId,
      courseId,
    }),
  enrollLearning: (
    identityId: string,
    courseId: string,
    clientPlatformId?: string,
  ) =>
    api.post<Enrollment>(`${base}/operator/enroll`, {
      accessType: 'learning',
      ...(clientPlatformId ? { clientPlatformId } : {}),
      identityId,
      courseId,
    }),
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
