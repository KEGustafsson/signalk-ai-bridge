import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeBridgeRequest } from './bridgeRuntime.js';
import type { AppPanelProps } from './panelTypes.js';

describe('executeBridgeRequest', () => {
  it('posts tool requests to the plugin bridge route', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

    const api: AppPanelProps = {
      bridgeFetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            type: 'ask-vessel-ai-result',
            prompt: 'Summarize the vessel state.',
            response: {
              answer: 'Steady conditions.',
              model: 'gemma4:e2b',
              createdAt: '2026-04-12T10:00:00.000Z'
            }
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json'
            }
          }
        );
      }
    };

    const result = await executeBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' });

    assert.equal(result.type, 'ask-vessel-ai-result');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, '/plugins/signalk-ai-bridge/bridge/execute');
    assert.equal(requests[0]?.init?.credentials, 'include');
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.match(String(requests[0]?.init?.body), /ask-vessel-ai/);
  });

  it('supports overriding the bridge endpoint', async () => {
    const api: AppPanelProps = {
      bridgeEndpoint: '/custom-bridge',
      bridgeFetch: async (url) =>
        new Response(
          JSON.stringify({
            type: 'ask-vessel-ai-result',
            prompt: 'Summarize the vessel state.',
            response: {
              answer: 'Custom bridge worked.',
              model: 'gemma4:e2b',
              createdAt: '2026-04-12T10:00:00.000Z'
            }
          }),
          {
            status: url === '/custom-bridge' ? 200 : 404,
            headers: {
              'content-type': 'application/json'
            }
          }
        )
    };

    const result = await executeBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' });
    assert.equal(result.type, 'ask-vessel-ai-result');
  });

  it('maps bridge HTTP errors into tool errors', async () => {
    const api: AppPanelProps = {
      bridgeFetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'unauthorized',
              message: 'Authentication is required.'
            }
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json'
            }
          }
        )
    };

    const result = await executeBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' });
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'unauthorized');
    }
  });

  it('returns an error when the bridge payload is invalid', async () => {
    const api: AppPanelProps = {
      bridgeFetch: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        })
    };

    const result = await executeBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' });
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'unknown');
    }
  });
});
