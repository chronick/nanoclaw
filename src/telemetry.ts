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

interface UsageSpan {
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
  const startNano = ((now - usage.durationMs) * 1_000_000).toString();
  const endNano = (now * 1_000_000).toString();
  const traceId = randomHex(16);
  const spanId = randomHex(8);

  const attributes: Array<{
    key: string;
    value: { stringValue?: string; intValue?: string };
  }> = [
    {
      key: 'gen_ai.system',
      value: { stringValue: 'anthropic' },
    },
    {
      key: 'gen_ai.request.model',
      value: { stringValue: usage.model },
    },
    {
      key: 'gen_ai.usage.input_tokens',
      value: { intValue: String(usage.inputTokens) },
    },
    {
      key: 'gen_ai.usage.output_tokens',
      value: { intValue: String(usage.outputTokens) },
    },
    {
      key: 'agent.name',
      value: { stringValue: 'lemon-chan' },
    },
  ];

  if (usage.groupName) {
    attributes.push({
      key: 'nanoclaw.group',
      value: { stringValue: usage.groupName },
    });
  }
  if (usage.sessionId) {
    attributes.push({
      key: 'agent.session_id',
      value: { stringValue: usage.sessionId },
    });
  }

  const otlpPayload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: 'nanoclaw' },
            },
            {
              key: 'agent.name',
              value: { stringValue: 'lemon-chan' },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: 'gen_ai.chat_completion',
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: startNano,
                endTimeUnixNano: endNano,
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
      // Drain response
      res.resume();
      if (res.statusCode !== 200) {
        logger.debug({ statusCode: res.statusCode }, 'Lookout span rejected');
      }
    },
  );

  req.on('error', (err) => {
    logger.debug({ err: err.message }, 'Lookout span send failed (non-fatal)');
  });

  req.write(body);
  req.end();
}
