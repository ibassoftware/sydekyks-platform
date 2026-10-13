import { tryCatchSync } from '@activepieces/core-utils';
import { ComponentProps } from 'react';
import { ExtraProps } from 'react-markdown';

import { INITIAL_COMPONENTS } from '@/components/prompt-kit/markdown';

export function ChatWorkflowLink({
  conversationId,
  node,
  ...props
}: ComponentProps<'a'> & ExtraProps & { conversationId?: string | null }) {
  const href = workflowHref({ href: props.href, conversationId });
  const DefaultLink = INITIAL_COMPONENTS.a;
  return typeof DefaultLink === 'function' ? (
    <DefaultLink {...props} node={node} href={href} />
  ) : (
    <a {...props} href={href} />
  );
}

function workflowHref({
  href,
  conversationId,
}: {
  href?: string;
  conversationId?: string | null;
}): string | undefined {
  if (!href || !conversationId) return href;
  const parsed = tryCatchSync(() => new URL(href, window.location.origin)).data;
  if (
    !parsed ||
    parsed.origin !== window.location.origin ||
    !/^\/projects\/[^/]+\/flows\/[^/]+\/?$/.test(parsed.pathname)
  )
    return href;
  parsed.searchParams.set('conversation', conversationId);
  return parsed.href;
}

export const chatWorkflowLinkUtils = { workflowHref };
