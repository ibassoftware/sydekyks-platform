import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  parse: vi.fn(),
}));
vi.mock('@googleapis/gmail', () => ({
  gmail: () => ({ users: { messages: { list: mocks.list, get: mocks.get } } }),
}));
vi.mock('../src/lib/auth', () => ({
  gmailAuth: {},
  createGoogleClient: vi.fn().mockResolvedValue({}),
}));
vi.mock('../src/lib/common/data', () => ({
  parseStream: mocks.parse,
  convertAttachment: vi.fn().mockResolvedValue([]),
  GmailRequests: {},
}));
import { gmailSearchMailAction } from '../src/lib/actions/search-email-action';

function run(propsValue: Record<string, unknown> = {}) {
  return gmailSearchMailAction.run({
    auth: {},
    propsValue,
    files: {},
  } as unknown as Parameters<typeof gmailSearchMailAction.run>[0]);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    data: {
      messages: [{ id: 'message-1', threadId: 'thread-1' }],
      resultSizeEstimate: 1,
    },
  });
  mocks.get.mockResolvedValue({
    data: {
      raw: Buffer.from('Synthetic message').toString('base64'),
      threadId: 'thread-1',
      labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
    },
  });
  mocks.parse.mockResolvedValue({
    subject: 'Synthetic subject',
    attachments: [],
  });
});
describe('Gmail search scope and unread evidence', () => {
  it('passes unread inbox operators exactly without adding a Primary category', async () => {
    const result = await run({ query: 'is:unread in:inbox' });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'is:unread in:inbox' })
    );
    expect(result.results.messages[0]).toMatchObject({
      labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      isUnread: true,
    });
    expect(result.results).toMatchObject({
      query: 'is:unread in:inbox',
      count: 1,
      countScope: 'returned_page',
      hasMore: false,
    });
  });
  it('uses label IDs without conflating INBOX with a category or a label name', async () => {
    await run({ label: { id: 'INBOX', name: 'Inbox' } });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ labelIds: ['INBOX'] })
    );
    expect(mocks.list.mock.calls[0][0].q).toBeUndefined();
  });
  it('does not invent unread status when Gmail did not return label metadata', async () => {
    mocks.get.mockResolvedValue({
      data: { raw: Buffer.from('Synthetic message').toString('base64') },
    });
    const result = await run();
    expect(result.results.messages[0]).toMatchObject({
      labelIds: null,
      isUnread: null,
    });
  });
  it('exposes partial-page counts, estimates and continuation separately', async () => {
    mocks.list.mockResolvedValue({
      data: {
        messages: [{ id: 'message-1' }],
        resultSizeEstimate: 250,
        nextPageToken: 'next-page',
      },
    });
    const result = await run({
      query: 'is:unread',
      page_token: 'previous-page',
      max_results: 1,
    });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'is:unread',
        pageToken: 'previous-page',
        maxResults: 1,
      })
    );
    expect(result.results).toMatchObject({
      count: 1,
      resultSizeEstimate: 250,
      hasMore: true,
      nextPageToken: 'next-page',
      countScope: 'returned_page',
    });
  });
  it('preserves an empty page continuation instead of proving there are no matches', async () => {
    mocks.list.mockResolvedValue({
      data: { messages: [], nextPageToken: 'later-page' },
    });
    const result = await run({ query: 'is:unread' });
    expect(result.results).toMatchObject({
      count: 0,
      hasMore: true,
      nextPageToken: 'later-page',
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
