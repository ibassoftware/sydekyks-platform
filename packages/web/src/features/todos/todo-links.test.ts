import { describe, expect, it } from 'vitest';

import { todoReturnPath } from './todo-links';

describe('task sign-in return link', () => {
  it('keeps the internal task and suggested status', () => {
    expect(todoReturnPath('/todos/abc123/resolve?status=Needs+changes')).toBe(
      '/todos/abc123/resolve?status=Needs+changes',
    );
  });
  it.each([
    null,
    'https://example.com/todos/abc/resolve',
    '//example.com/todos/abc/resolve',
    '/\\example.com/todos/abc/resolve',
    '/platform/billing',
    '/todos/../platform/resolve',
    '/todos/abc/resolve/extra',
    '/todos/%2f%2fexample.com/resolve',
  ])('rejects unrelated or unsafe destinations: %s', (value) => {
    expect(todoReturnPath(value)).toBeNull();
  });
});
