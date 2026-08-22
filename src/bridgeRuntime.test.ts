import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeBridgeRequest, streamBridgeRequest } from './bridgeRuntime.js';
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

/** Response whose body streams the given NDJSON text in arbitrary chunks. */
function ndjsonResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

  return new Response(body, {
    status,
    headers: { 'content-type': 'application/x-ndjson' }
  });
}

describe('streamBridgeRequest', () => {
  it('reports tokens as they arrive and returns the final result', async () => {
    const tokens: string[] = [];
    let requestedUrl = '';

    const api: AppPanelProps = {
      bridgeFetch: async (url) => {
        requestedUrl = String(url);
        return ndjsonResponse([
          '{"type":"token","text":"All "}\n{"type":"token","text":"nominal."}\n',
          '{"type":"ask-vessel-ai-result","prompt":"Status?","response":{"answer":"All nominal.","model":"gemma4:e2b","createdAt":"2026-04-12T10:00:00.000Z"}}\n'
        ]);
      }
    };

    const result = await streamBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Status?' }, (text) =>
      tokens.push(text)
    );

    assert.equal(requestedUrl, '/plugins/signalk-ai-bridge/bridge/stream');
    assert.deepEqual(tokens, ['All ', 'nominal.']);
    assert.equal(result.type, 'ask-vessel-ai-result');
  });

  it('reassembles lines split across chunk boundaries', async () => {
    const tokens: string[] = [];

    const api: AppPanelProps = {
      bridgeFetch: async () =>
        ndjsonResponse([
          '{"type":"token","te',
          'xt":"split"}\n{"type":"ask-vessel-ai-result","prompt":"Status?","res',
          'ponse":{"answer":"split","model":"m","createdAt":"2026-04-12T10:00:00.000Z"}}'
        ])
    };

    const result = await streamBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Status?' }, (text) =>
      tokens.push(text)
    );

    assert.deepEqual(tokens, ['split']);
    assert.equal(result.type, 'ask-vessel-ai-result');
  });

  it('surfaces a trailing error line as a tool error', async () => {
    const api: AppPanelProps = {
      bridgeFetch: async () =>
        ndjsonResponse(['{"type":"error","error":{"code":"unknown","message":"Ollama is unreachable."}}\n'])
    };

    const result = await streamBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Status?' }, () => {});

    assert.equal(result.type, 'error');
    assert.equal(result.type === 'error' ? result.error.message : '', 'Ollama is unreachable.');
  });

  it('falls back to the blocking route when streaming is unavailable', async () => {
    const urls: string[] = [];

    const api: AppPanelProps = {
      bridgeFetch: async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/bridge/stream')) {
          return new Response('not found', { status: 404 });
        }
        return new Response(
          JSON.stringify({
            type: 'ask-vessel-ai-result',
            prompt: 'Status?',
            response: { answer: 'Blocking.', model: 'm', createdAt: '2026-04-12T10:00:00.000Z' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    };

    const result = await streamBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Status?' }, () => {});

    assert.deepEqual(urls, [
      '/plugins/signalk-ai-bridge/bridge/stream',
      '/plugins/signalk-ai-bridge/bridge/execute'
    ]);
    assert.equal(result.type, 'ask-vessel-ai-result');
  });

  it('errors rather than hanging when the stream ends with no result', async () => {
    const api: AppPanelProps = {
      bridgeFetch: async () => ndjsonResponse(['{"type":"token","text":"partial"}\n'])
    };

    const result = await streamBridgeRequest(api, { toolId: 'ask-vessel-ai', prompt: 'Status?' }, () => {});

    assert.equal(result.type, 'error');
    assert.match(result.type === 'error' ? result.error.message : '', /without a result/);
  });
});
