// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatWorkflowLink, chatWorkflowLinkUtils } from '@/app/routes/chat-with-ai/components/chat-workflow-link';

describe('workflow links from chat', () => {
  it('preserves a same-origin mission link and opens it with the current conversation', () => {
    const href = `${window.location.origin}/projects/project/flows/flow?view=graph#step`;
    render(<ChatWorkflowLink href={href} conversationId="conversation">Open mission</ChatWorkflowLink>);
    expect(screen.getByRole('link', { name: 'Open mission' }).getAttribute('href')).toBe(`${window.location.origin}/projects/project/flows/flow?view=graph&conversation=conversation#step`);
  });
  it('keeps external and unrelated links unchanged', () => {
    for (const href of ['https://example.com/projects/project/flows/flow', '/projects/project/agents/agent', 'mailto:test@example.com', 'javascript:alert(1)']) {
      expect(chatWorkflowLinkUtils.workflowHref({ href, conversationId: 'conversation' })).toBe(href);
    }
  });
  it('handles relative mission links and replaces an older conversation', () => {
    expect(chatWorkflowLinkUtils.workflowHref({ href: '/projects/project/flows/flow?conversation=old', conversationId: 'new' })).toBe(`${window.location.origin}/projects/project/flows/flow?conversation=new`);
    expect(chatWorkflowLinkUtils.workflowHref({ href: '/projects/project/flows/flow' })).toBe('/projects/project/flows/flow');
  });
})
