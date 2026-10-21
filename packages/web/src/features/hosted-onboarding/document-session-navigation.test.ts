import { describe, expect, it } from 'vitest';

import {
  HostedDocumentSession,
  hostedDocumentReloadPath,
} from './document-session-navigation';

const initial: HostedDocumentSession = {
  token: 'same-user-token',
  projectId: 'project_A',
  kind: 'user',
  id: 'user_A',
  platformId: 'workspace_A',
};
const route = (pathname: string, search = '', hash = '') => ({
  pathname,
  search,
  hash,
});

describe('hosted document reload navigation', () => {
  it('resumes only the fixed billing review after login or a workspace change', () => {
    for (const current of [
      initial,
      {
        ...initial,
        id: 'other-user',
        platformId: 'other-workspace',
        token: 'new-workspace-token',
      },
    ]) {
      expect(
        hostedDocumentReloadPath(initial, current, route('/sign-in'), true),
      ).toBe('/platform/billing');
    }
    expect(
      hostedDocumentReloadPath(
        initial,
        { ...initial, kind: 'anonymous', token: null },
        route('/platform/billing'),
        true,
      ),
    ).toBe('/sign-in');
    expect(
      hostedDocumentReloadPath(
        initial,
        { ...initial, kind: 'onboarding', platformId: null },
        route('/platform/billing'),
        true,
      ),
    ).toBe('/');
  });
  it.each(['project_A', 'project-B'])(
    'keeps only the currently selected project list (%s) across a full reload',
    (projectId) => {
      expect(
        hostedDocumentReloadPath(
          initial,
          { ...initial, projectId },
          route(`/projects/${projectId}/automations`),
        ),
      ).toBe(`/projects/${projectId}/automations`);
    },
  );

  it.each([
    { token: 'other-token' },
    { id: 'other-user' },
    { platformId: 'other-workspace' },
    { kind: 'onboarding' as const },
    { token: null },
    { id: null },
    { platformId: null },
  ])(
    'uses the safe root after an account or workspace change: %j',
    (change) => {
      expect(
        hostedDocumentReloadPath(
          initial,
          { ...initial, ...change },
          route('/projects/project_A/automations'),
        ),
      ).toBe('/');
    },
  );

  it('uses sign-in after logout or credential expiration', () => {
    expect(
      hostedDocumentReloadPath(
        initial,
        { ...initial, kind: 'anonymous', token: null },
        route('/projects/project_A/automations'),
      ),
    ).toBe('/sign-in');
  });

  it.each([
    route('/projects/project_A/automations'),
    route('/projects/project-B/automations/'),
    route('/projects/project-B/automations', '?redirect=https://example.com'),
    route('/projects/project-B/automations', '', '#private'),
    route('/projects/project-B/automations/../settings'),
    route('/projects/project-B/automations%3Fredirect=//example.com'),
    route('//example.com/projects/project-B/automations'),
    route('https://example.com/projects/project-B/automations'),
    route('/projects/project-B/flows/private-flow'),
    route('/chat/private-conversation'),
  ])('does not retain a stale or unapproved destination: %j', (location) => {
    expect(
      hostedDocumentReloadPath(
        initial,
        { ...initial, projectId: 'project-B' },
        location,
      ),
    ).toBe('/');
  });

  it.each([null, '', '../other', 'project%2Fother', 'project?redirect=//evil'])(
    'does not build a destination from an unsafe project pointer (%s)',
    (projectId) => {
      expect(
        hostedDocumentReloadPath(
          initial,
          { ...initial, projectId },
          route(`/projects/${projectId}/automations`),
        ),
      ).toBe('/');
    },
  );

  it('does not retain a project route when the document began anonymously', () => {
    expect(
      hostedDocumentReloadPath(
        { ...initial, kind: 'anonymous' },
        initial,
        route('/projects/project_A/automations'),
      ),
    ).toBe('/');
  });
});
