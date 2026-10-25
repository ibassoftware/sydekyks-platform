import { describe, expect, it, vi } from 'vitest';

import { projectReference, projectSelectionLabel } from './project-label';

vi.mock('i18next', () => ({ t: (key: string) => key }));

describe('authorized project labels', () => {
  it('preserves a user name without showing an ID when it is unique', () => {
    const project = {
      id: 'internal-private-id-123456',
      displayName: 'North clinic handover',
    };
    expect(projectSelectionLabel(project, [project])).toBe(
      'North clinic handover',
    );
    expect(projectReference(project, [project])).toBeNull();
  });
  it('disambiguates identical names only within the supplied authorized list', () => {
    const one = {
      id: 'first-private-id-123456',
      displayName: 'Client handover',
    };
    const two = {
      id: 'other-private-id-654321',
      displayName: 'Client handover',
    };
    expect(projectSelectionLabel(one, [one, two])).toBe(
      'Client handover · Reference …123456',
    );
    expect(projectSelectionLabel(two, [one, two])).toBe(
      'Client handover · Reference …654321',
    );
    expect(projectSelectionLabel(one, [one])).toBe('Client handover');
  });
  it('extends a colliding suffix without replacing the stored name', () => {
    const one = { id: 'a0123456', displayName: 'Operations' };
    const two = { id: 'b0123456', displayName: 'Operations' };
    expect(projectReference(one, [one, two])).not.toBe(
      projectReference(two, [one, two]),
    );
    expect(projectSelectionLabel(one, [one, two])).toMatch(
      /^Operations · Reference /,
    );
  });
});
