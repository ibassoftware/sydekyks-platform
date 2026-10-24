import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  token: 'current-session' as string | null,
  project: 'p'.repeat(21),
  logOut: vi.fn(),
}));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: {
    getToken: () => session.token,
    getProjectId: () => session.project,
    logOut: session.logOut,
  },
}));
vi.mock('@/lib/chat-debug-logger', () => ({
  chatDebug: { isEnabled: () => false },
}));

const flowId = 'f'.repeat(21);
const originalAdapter = axios.defaults.adapter;
const requests: InternalAxiosRequestConfig[] = [];
const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
  requests.push(config);
  return {
    data: { accepted: true },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  };
});

async function load(origin = 'http://127.0.0.1:3289') {
  vi.stubGlobal('window', { location: { origin, href: '/' } });
  return import('@/lib/api');
}

beforeEach(() => {
  vi.resetModules();
  session.token = 'current-session';
  session.logOut.mockClear();
  requests.length = 0;
  adapter.mockClear();
  axios.defaults.adapter = adapter;
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllGlobals();
});

function authorization(index = requests.length - 1) {
  return requests[index].headers.get('Authorization');
}

describe('draft Form submission credentials at the actual Axios boundary', () => {
  it.each(['http://127.0.0.1:3289', 'https://app.sydekyks.com'])(
    'forwards the current session for real draft Form/chat adapters at %s',
    async (origin) => {
      await load(origin);
      const { humanInputApi } = await import(
        '@/features/forms/api/human-input-api'
      );
      const form = {
        id: flowId,
        version: '0.3.0',
        props: { waitForResponse: false },
      };
      await humanInputApi.submitForm(form as never, true, { name: 'Example' });
      await humanInputApi.submitForm(
        { ...form, props: { waitForResponse: true } } as never,
        true,
        { name: 'Example' },
      );
      await humanInputApi.sendMessage({
        flowId,
        chatId: 'example',
        message: 'Hello',
        files: [],
        mode: 'draft',
      });
      expect(requests.map((request) => request.url)).toEqual([
        `${origin}/api/v1/webhooks/${flowId}/draft`,
        `${origin}/api/v1/webhooks/${flowId}/draft/sync`,
        `${origin}/api/v1/webhooks/${flowId}/draft/sync`,
      ]);
      for (let index = 0; index < requests.length; index++) {
        expect(authorization(index)).toBe('Bearer current-session');
      }
    },
  );

  it('keeps public submissions, capture-only tests and non-POST draft requests anonymous', async () => {
    const { api } = await load();
    for (const path of [
      '',
      '/sync',
      '/test',
      '/draft/extra',
      '/draft?unexpected=true',
    ]) {
      await api.post(`/v1/webhooks/${flowId}${path}`, {});
      expect(authorization()).toBeUndefined();
    }
    await api.get(`/v1/webhooks/${flowId}/draft`);
    expect(authorization()).toBeUndefined();
    await api.post('/v1/webhooks/not-a-flow-id/draft', {});
    expect(authorization()).toBeUndefined();
  });

  it('never forwards credentials to an external or API-prefix-spoofing URL', async () => {
    const { api } = await load();
    for (const url of [
      `https://external.example/api/v1/webhooks/${flowId}/draft`,
      `http://127.0.0.1:3289.evil.example/api/v1/webhooks/${flowId}/draft`,
      `http://127.0.0.1:3289/api.evil/v1/webhooks/${flowId}/draft`,
      `http://127.0.0.1:3289/other/v1/webhooks/${flowId}/draft`,
    ]) {
      await api.post(url, {});
      expect(authorization()).toBeUndefined();
    }
    await api.post(`http://127.0.0.1:3289/api/v1/webhooks/${flowId}/draft`, {});
    expect(authorization()).toBe('Bearer current-session');
  });

  it('does not invent an absent session or override explicitly anonymous scope', async () => {
    const { api } = await load();
    session.token = null;
    await api.post(`/v1/webhooks/${flowId}/draft`, {});
    expect(authorization()).toBeUndefined();
    session.token = 'current-session';
    await api.sessionScoped(
      `/v1/webhooks/${flowId}/draft`,
      { method: 'POST' },
      true,
    );
    expect(authorization()).toBeUndefined();
  });

  it('propagates a rejected stale credential without retrying the submission', async () => {
    const { api } = await load();
    const rejected = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST');
    rejected.response = {
      data: { code: 'INVALID_BEARER_TOKEN' },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {} as never,
    };
    adapter.mockImplementationOnce(async (config) => {
      requests.push(config);
      throw rejected;
    });
    await expect(api.post(`/v1/webhooks/${flowId}/draft`, {})).rejects.toBe(
      rejected,
    );
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(session.logOut).toHaveBeenCalledWith({
      preserveCheckoutIntent: true,
    });
  });

  it('fences a draft response if the hosted user changes while it is pending', async () => {
    const { api } = await load();
    api.setHostedSessionIsolation(true);
    adapter.mockImplementationOnce(async (config) => {
      requests.push(config);
      session.token = 'another-session';
      return {
        data: { accepted: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    });
    await expect(api.post(`/v1/webhooks/${flowId}/draft`, {})).rejects.toThrow(
      'Your session changed',
    );
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(session.logOut).not.toHaveBeenCalled();
  });
});
