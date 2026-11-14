const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CompletionClient } = require('../ai-network.cjs');
const { chat } = require('../ai.cjs');

function sse(chunks) {
  const bytes = new TextEncoder().encode(chunks.join(''));
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 3));
      offset += 3;
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

const event = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\r\n\r\n`;
const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n';

test('SSE preserves fragmented UTF-8, CRLF, Markdown and tool arguments', async () => {
  const deltas = [];
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', fetcher: async () => sse([
    ': heartbeat\r\n\r\n', event({ content: '**中文** $x^2$' }),
    event({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'browser_fill', arguments: '{"selector":' } }] }),
    event({ tool_calls: [{ index: 0, function: { arguments: '"#name","value":"正确"}' } }] }), finish
  ]) });
  const result = await client.complete({ model: 'fixture' }, { stream: true, onDelta: delta => deltas.push(delta) });
  assert.equal(deltas.join(''), '**中文** $x^2$');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { selector: '#name', value: '正确' });
});

test('AI retries throttling with Retry-After and does not retry authentication errors', async () => {
  let attempts = 0;
  const delays = [];
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', sleep: async delay => delays.push(delay), fetcher: async () => {
    attempts++;
    if (attempts === 1) return new Response('', { status: 429, headers: { 'Retry-After': '3' } });
    return Response.json({ choices: [{ message: { role: 'assistant', content: '恢复成功' } }] });
  } });
  assert.equal((await client.complete({ model: 'fixture' })).content, '恢复成功');
  assert.deepEqual(delays, [3000]);
  attempts = 0;
  client.fetcher = async () => { attempts++; return new Response('', { status: 401 }); };
  await assert.rejects(client.complete({}), /HTTP 401/);
  assert.equal(attempts, 1);
});

test('truncated tool stream is retried before any browser action executes', async () => {
  let attempts = 0, tools = 0;
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', sleep: async () => {}, fetcher: async () => {
    attempts++;
    const fragments = [event({ tool_calls: [{ index: 0, id: 'call', function: { name: 'browser_click', arguments: '{"selector":"#apply"}' } }] })];
    return sse(attempts === 1 ? fragments : [...fragments, finish]);
  } });
  const answer = await client.complete({}, { stream: true });
  for (const call of answer.tool_calls) { assert.equal(call.function.name, 'browser_click'); tools++; }
  assert.equal(attempts, 2);
  assert.equal(tools, 1);
});

test('stop aborts retry waiting without another model request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', signal: controller.signal,
    fetcher: async () => { attempts++; throw new TypeError('network down'); },
    onEvent: event => { if (event.status === 'retrying') controller.abort(); }
  });
  await assert.rejects(client.complete({}), /abort/i);
  assert.equal(attempts, 1);
});

test('chat emits text before completion and keeps observer verification', async () => {
  const events = [];
  let snapshotCalls = 0;
  const result = await chat({ messages: [{ role: 'user', content: '解释公式' }], key: 'fixture', model: 'fixture',
    onEvent: event => events.push(event),
    dispatch: async () => { snapshotCalls++; return { content: [{ type: 'text', text: 'evidence' }] }; },
    fetcher: async (_, options) => {
      const input = JSON.parse(options.body);
      if (!input.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'complete', reason: '已验证', checks: [{ item: '公式解释', passed: true }] }) } }] });
      return sse([event({ content: '# 公式\n' }), event({ content: '$x^2$' }), finish]);
    }
  });
  const delta = events.findIndex(item => item.type === 'assistant-delta');
  const end = events.findIndex(item => item.type === 'assistant-end');
  assert.ok(delta >= 0 && delta < end);
  assert.equal(snapshotCalls, 1);
  assert.equal(result.at(-1).content, '# 公式\n$x^2$');
  assert.equal(events.at(-1).status, 'complete');
});

test('proxy node-fetch response streams and authentication failures use native Node bodies', async () => {
  const { Response: NodeResponse } = await import('node-fetch');
  const { Readable } = require('node:stream');
  let attempts = 0;
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', sleep: async () => {}, fetcher: async () => {
    attempts++;
    return new NodeResponse(Readable.from([Buffer.from(event({ content: '**代理流** $x^2$' })), Buffer.from(finish)]), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const chunks = [];
  assert.equal((await client.complete({}, { stream: true, onDelta: chunk => chunks.push(chunk) })).content, '**代理流** $x^2$');
  assert.deepEqual(chunks, ['**代理流** $x^2$']);
  assert.equal(attempts, 1);
  attempts = 0;
  const denied = Readable.from(['unauthorized']);
  client.fetcher = async () => { attempts++; return new NodeResponse(denied, { status: 401 }); };
  await assert.rejects(client.complete({}), /HTTP 401/);
  assert.equal(attempts, 1);
  assert.equal(denied.destroyed, true);
});

test('observer requests a structured verdict and accepts only a passed checklist', async () => {
  let structured = false;
  const events = [];
  await chat({ messages: [{ role: 'user', content: '检查本地结果' }], model: 'fixture', key: 'fixture', onEvent: event => events.push(event),
    dispatch: async () => ({ content: [{ type: 'text', text: '已完成三项检查' }] }),
    fetcher: async (_, options) => {
      const input = JSON.parse(options.body);
      if (input.stream) return sse([event({ content: '三项检查已完成。' }), finish]);
      assert.equal(input.tool_choice.function.name, 'report_verdict'); structured = true;
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'verdict', type: 'function', function: {
        name: 'report_verdict', arguments: JSON.stringify({ status: 'complete', reason: '页面显示“验收完成”', checks: [{ item: '三项全部通过', passed: true }], next_action: '' })
      } }] } }] });
    }
  });
  assert.equal(structured, true);
  assert.equal(events.at(-1).status, 'complete');
});

test('empty streamed tool arguments become a valid object before returning conversation history', async () => {
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', fetcher: async () => sse([
    event({ tool_calls: [{ index: 0, id: 'snapshot', type: 'function', function: { name: 'browser_snapshot', arguments: '' } }] }), finish
  ]) });
  const result = await client.complete({}, { stream: true });
  assert.equal(result.tool_calls[0].function.arguments, '{}');
});

test('observer decodes a JSON-encoded checklist but rejects a malformed checklist claim', async () => {
  const events = [];
  let audits = 0;
  await chat({ messages: [{ role: 'user', content: '核对结果' }], model: 'fixture', key: 'fixture', onEvent: event => events.push(event),
    dispatch: async () => ({ content: [{ type: 'text', text: '验收完成' }] }),
    fetcher: async (_, options) => {
      const input = JSON.parse(options.body);
      if (input.stream) return sse([event({ content: '已完成。' }), finish]);
      audits++;
      return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'verdict', type: 'function', function: { name: 'report_verdict', arguments: JSON.stringify({
        status: 'complete', reason: '核对结果', next_action: '', checks: audits === 1 ? { length: 1, passed: true } : JSON.stringify([{ item: '实际结果', passed: true }])
      }) } }] } }] });
    }
  });
  assert.equal(audits, 2);
  assert.ok(events.some(event => event.tool === '观察哨' && event.status === 'continue'));
  assert.equal(events.at(-1).status, 'complete');
});

test('repeated truncated SSE falls back to a complete buffered response without executing partial tools', async () => {
  const modes = [], events = [];
  const client = new CompletionClient({ key: 'fixture', baseURL: 'https://fixture', sleep: async () => {}, onEvent: event => events.push(event), fetcher: async (_, options) => {
    const input = JSON.parse(options.body); modes.push(input.stream);
    if (input.stream) return sse([event({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'browser_click', arguments: '{"selector":' } }] })]);
    return Response.json({ choices: [{ message: { role: 'assistant', content: '恢复成功', tool_calls: [{ id: 'complete', type: 'function', function: { name: 'browser_click', arguments: '{"selector":"#apply"}' } }] } }] });
  } });
  const answer = await client.complete({}, { stream: true });
  assert.deepEqual(modes, [true, true, false]);
  assert.equal(answer.tool_calls.length, 1);
  assert.equal(answer.tool_calls[0].id, 'complete');
  assert.ok(events.some(event => event.mode === 'buffered'));
});
