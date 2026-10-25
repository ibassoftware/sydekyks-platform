import axios, { type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ token: 'test-session' as string | null }));
vi.mock('@/lib/authentication-session', () => ({
  authenticationSession: { getToken: () => session.token, logOut: vi.fn() },
}));
vi.mock('@/lib/chat-debug-logger', () => ({
  chatDebug: { isEnabled: () => false },
}));

const originalAdapter = axios.defaults.adapter;
const requests: InternalAxiosRequestConfig[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', {
    location: { origin: 'http://127.0.0.1:3294', href: '/' },
  });
  session.token = 'test-session';
  requests.length = 0;
  axios.defaults.adapter = async (config) => {
    requests.push(config);
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllGlobals();
});

function authorization() {
  return requests[requests.length - 1].headers.get('Authorization');
}

describe('self-hosted API credential boundaries', () => {
  it('authenticates only the configured API origin and path', async () => {
    const { api } = await import('@/lib/api');
    await api.get('/v1/projects');
    expect(authorization()).toBe('Bearer test-session');
    await api.get('http://127.0.0.1:3294/api/v1/projects');
    expect(authorization()).toBe('Bearer test-session');
    for (const url of [
      'https://external.example/api/v1/projects',
      'http://127.0.0.1:3294/api-other/v1/projects',
      'http://127.0.0.1:3294/api.evil/v1/projects',
      'http://127.0.0.1:3294/api/../other/v1/projects',
      'http://127.0.0.1:3295/api/v1/projects',
      'http://127.0.0.1:3294@external.example/api/v1/projects',
    ]) {
      await api.get(url);
      expect(authorization(), url).toBeUndefined();
    }
  });

  it('preserves anonymous authentication and webhook routes, including draft submissions', async () => {
    const { api } = await import('@/lib/api');
    for (const path of [
      '/v1/authentication/sign-in',
      '/v1/authentication/sign-up',
      '/v1/webhooks/test-flow',
      '/v1/webhooks/test-flow/draft',
      '/v1/webhooks/test-flow/draft/sync',
    ]) {
      await api.post(path, {});
      expect(authorization(), path).toBeUndefined();
    }
    session.token = null;
    await api.get('/v1/projects');
    expect(authorization()).toBeUndefined();
  });
});
