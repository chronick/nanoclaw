/**
 * Telemetry emitter for Lookout.
 * Sends OTLP JSON spans to the local Lookout collector.
 */
import { request as httpRequest } from 'http';

import { logger } from './logger.js';

const LOOKOUT_ENDPOINT =
  process.env.LOOKOUT_ENDPOINT || 'http://127.0.0.1:4318';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface UsageSpan {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  groupName?: string;
  sessionId?: string;
  statusCode?: number;
}

export function emitUsageSpan(usage: UsageSpan): void {
  const now = Date.now();
  const startNano = String((now - usage.durationMs) * 1_000_000);
  const endNano = String(now * 1_000_000);
  const traceId = randomHex(16);
  const spanId = randomHex(8);

  // Use proto JSON format (snake_case field names)
  const attributes: Array<{
    key: string;
    value: { string_value?: string; int_value?: string };
  }> = [
    { key: 'gen_ai.system', value: { string_value: 'anthropic' } },
    { key: 'gen_ai.request.model', value: { string_value: usage.model } },
    {
      key: 'gen_ai.usage.input_tokens',
      value: { int_value: String(usage.inputTokens) },
    },
    {
      key: 'gen_ai.usage.output_tokens',
      value: { int_value: String(usage.outputTokens) },
    },
    { key: 'agent.name', value: { string_value: 'lemon-chan' } },
  ];

  if (usage.groupName) {
    attributes.push({
      key: 'nanoclaw.group',
      value: { string_value: usage.groupName },
    });
  }
  if (usage.sessionId) {
    attributes.push({
      key: 'agent.session_id',
      value: { string_value: usage.sessionId },
    });
  }

  const otlpPayload = {
    resource_spans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { string_value: 'nanoclaw' } },
            { key: 'agent.name', value: { string_value: 'lemon-chan' } },
          ],
        },
        scope_spans: [
          {
            spans: [
              {
                trace_id: traceId,
                span_id: spanId,
                name: 'gen_ai.chat_completion',
                kind: 3, // SPAN_KIND_CLIENT
                start_time_unix_nano: startNano,
                end_time_unix_nano: endNano,
                attributes,
                status: {
                  code: usage.statusCode && usage.statusCode >= 400 ? 2 : 1, // ERROR : OK
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(otlpPayload);
  const url = new URL(LOOKOUT_ENDPOINT);

  const req = httpRequest(
    {
      hostname: url.hostname,
      port: url.port || 4318,
      path: '/v1/traces',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        logger.info(
          {
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
          'Usage span sent to Lookout',
        );
      } else {
        logger.warn({ statusCode: res.statusCode }, 'Lookout span rejected');
      }
    },
  );

  req.on('error', (err) => {
    logger.debug({ err: err.message }, 'Lookout span send failed (non-fatal)');
  });

  req.write(body);
  req.end();
}
