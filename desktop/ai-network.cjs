const { setTimeout: wait } = require('node:timers/promises');
const { Readable } = require('node:stream');

const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

class CompletionClient {
  constructor({ key, baseURL, fetcher = fetch, signal, onEvent = () => {}, sleep = wait }) {
    Object.assign(this, { key, baseURL, fetcher, signal, onEvent, sleep });
    this.latency = 15000;
  }

  async complete(payload, { stream = false, onDelta = () => {}, onReset = () => {} } = {}) {
    let useStream = stream;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.signal?.throwIfAborted();
      const controller = new AbortController();
      const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
      const timeout = Math.min(180000, Math.max(45000, this.latency * 4));
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('AI 响应等待超时')), timeout);
      };
      const started = Date.now();
      let retryAfter = 0;
      let streamResponse = false;
      try {
        arm();
        const response = await this.fetcher(`${this.baseURL}/chat/completions`, {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, stream: useStream })
        });
        if (!response.ok) {
          const error = new Error(`ZenMux 请求失败（HTTP ${response.status}）。请检查 API Key、模型名称和账户额度。`);
          error.retryable = transientStatuses.has(response.status);
          const hint = response.headers?.get('retry-after');
          retryAfter = hint ? (Number.isFinite(Number(hint)) ? Number(hint) * 1000 : Date.parse(hint) - Date.now()) : 0;
          if (typeof response.body?.cancel === 'function') await response.body.cancel();
          else response.body?.destroy?.();
          throw error;
        }
        if (attempt > 0) onReset();
        let message;
        if (useStream && response.headers?.get('content-type')?.includes('text/event-stream')) {
          streamResponse = true;
          message = await readCompletionStream(response.body, arm, onDelta);
        } else {
          const data = await response.json();
          message = data.choices?.[0]?.message;
          if (stream && typeof message?.content === 'string') onDelta(message.content);
        }
        if (!message) {
          const error = new Error('ZenMux 未返回有效回复');
          error.retryable = false;
          throw error;
        }
        for (const call of message.tool_calls || []) {
          // Some providers stream no argument fragments for a zero-argument
          // tool. The next request still requires a valid JSON object string.
          const args = call.function?.arguments?.trim() || '{}';
          let parsed;
          try { parsed = JSON.parse(args); } catch { throw new Error('AI 工具参数不是有效 JSON，正在恢复请求'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI 工具参数必须是对象，正在恢复请求');
          call.function.arguments = args;
        }
        this.latency = this.latency * 0.7 + (Date.now() - started) * 0.3;
        this.onEvent({ type: 'network', status: 'connected', attempt: attempt + 1, timeoutMs: Math.round(timeout), mode: useStream ? 'streaming' : stream ? 'buffered' : undefined });
        return message;
      } catch (error) {
        if (this.signal?.aborted) throw this.signal.reason;
        if (error.retryable === false || attempt === 3) throw error;
        if (streamResponse && attempt >= 1) useStream = false;
        const delayMs = Math.min(120000, Math.max(retryAfter || 0, 1000 * 2 ** attempt));
        this.onEvent({ type: 'network', status: 'retrying', attempt: attempt + 1, delayMs, reason: error.message, mode: useStream ? 'streaming' : stream ? 'buffered' : undefined });
        clearTimeout(timer);
        await this.sleep(delayMs, undefined, { signal: this.signal });
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
  }
}

async function readCompletionStream(body, arm, onDelta) {
  if (!body) throw new Error('AI 响应流为空');
  const reader = (typeof body.getReader === 'function' ? body : Readable.toWeb(body)).getReader();
  const decoder = new TextDecoder();
  const message = { role: 'assistant', content: '' };
  const calls = [];
  let buffer = '', finished = false, doneMarker = false;
  function event(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { finished = true; doneMarker = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) {
      const error = new Error('AI 平台返回流式错误');
      error.retryable = false;
      throw error;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') { message.content += delta.content; onDelta(delta.content); }
    for (const fragment of delta.tool_calls || []) {
      const index = fragment.index ?? 0;
      calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (fragment.id) calls[index].id += fragment.id;
      if (fragment.function?.name) calls[index].function.name += fragment.function.name;
      if (fragment.function?.arguments) calls[index].function.arguments += fragment.function.arguments;
    }
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
      const error = new Error('模型输出被截断，请缩小任务范围后继续');
      error.retryable = false;
      throw error;
    }
    if (choice.finish_reason) finished = true;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        event(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      // Drain the provider's final SSE marker instead of cancelling its HTTP
      // connection as soon as finish_reason arrives in a preceding chunk.
      if (doneMarker) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    if (!finished) throw new Error('AI 响应流意外中断，正在恢复请求');
    if (calls.length) message.tool_calls = calls.filter(Boolean);
    return message;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

module.exports = { CompletionClient, readCompletionStream };
