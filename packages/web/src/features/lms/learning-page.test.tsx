// @vitest-environment jsdom
/* eslint-disable jest-dom/prefer-to-have-text-content -- This Vitest setup has no jest-dom matcher extension. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LearningPage } from './learning-page';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const fixture = vi.hoisted(() => ({
  me: {
    operator: false,
    trainer: false,
    canManage: false,
    enrollments: [] as {
      id: string;
      courseId: string;
      title: string;
      description: string;
      totalLessons: number;
      completedLessons: number;
      certificationMode: string;
    }[],
  },
}));
vi.mock('./session', () => ({ useLmsSession: () => 1 }));
vi.mock('./operator', () => ({ LmsOperator: () => <p>Course management</p> }));
vi.mock('@/features/hosted-billing/service-mode', () => ({
  useHostedBillingEnabled: () => true,
  useHostedRuntimeReady: () => true,
}));
vi.mock('./lms-api', () => ({
  lmsApi: {
    me: async () => fixture.me,
    learning: async () => ({
      course: {
        id: 'course',
        title: 'Client essentials',
        description: 'Use your workspace',
        audience: 'end_user',
        certificationMode: 'none',
        lessons: [
          {
            id: 'first',
            title: 'Completed lesson',
            body: 'First',
            exercise: '',
            resources: [],
          },
          {
            id: 'next',
            title: 'Next lesson',
            body: 'Second',
            exercise: '',
            resources: [],
          },
        ],
      },
      enrollment: {
        completedLessons: ['first'],
        practicalReviews: [],
        accessUntil: '2027-10-22',
      },
      certificate: null,
      attempts: [],
    }),
  },
}));
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  fixture.me.enrollments = [];
});
async function render(path = '/learn') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={query}>
          <LearningPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
describe('assigned learner dashboard', () => {
  it('shows an empty learner state without authoring controls even with a management query', async () => {
    await render('/learn?client=someone-else');
    expect(container.textContent).toContain(
      'Your instructor will give you access',
    );
    expect(container.textContent).not.toContain('Manage courses');
    expect(container.textContent).not.toContain('Course management');
  });
  it('shows assigned progress and resumes the first incomplete lesson', async () => {
    fixture.me.enrollments = [
      {
        id: 'enrollment',
        courseId: 'course',
        title: 'Client essentials',
        description: 'Use your workspace',
        totalLessons: 2,
        completedLessons: 1,
        certificationMode: 'none',
      },
    ];
    await render();
    expect(container.textContent).toContain('1 of 2 lessons complete');
    const button = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Continue learning'),
    )!;
    await act(async () => button.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(container.querySelector('#learning-lesson h2')?.textContent).toBe(
      'Next lesson',
    );
    expect(container.textContent).not.toContain(
      'Earn your Sydekyks certification',
    );
  });
});
