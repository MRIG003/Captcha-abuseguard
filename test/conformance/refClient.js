// Reference thin client. Every SDK must behave like this: bounded timeout, never throw into the caller,
// fail open by default, fail closed to a step-up (never a block) when configured.
import { fallbackDecision } from '../../src/index.js';

/**
 * @param {string} baseUrl
 * @param {any} input AssessRequest
 * @param {{timeoutMs?: number, failMode?: 'open'|'closed', apiKey?: string, headers?: Record<string,string>}} [opts]
 */
export async function assess(baseUrl, input, opts = {}) {
  const { timeoutMs = 150, failMode = 'open', apiKey = 'test-key', headers = {} } = opts;
  try {
    const res = await fetch(`${baseUrl}/v1/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 400 && res.status < 500) return { error: await res.json(), status: res.status };
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } catch {
    return fallbackDecision(input?.subject, { failMode });
  }
}
