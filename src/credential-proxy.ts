/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { createGunzip } from 'zlib';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { emitUsageSpan } from './telemetry.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);

            // Tap /v1/messages responses to extract token usage
            if (req.url?.startsWith('/v1/messages')) {
              const startTime = Date.now();
              const rawChunks: Buffer[] = [];
              const isGzipped = (
                upRes.headers['content-encoding'] || ''
              ).includes('gzip');

              upRes.on('data', (chunk: Buffer) => {
                rawChunks.push(chunk);
                res.write(chunk);
              });
              upRes.on('end', () => {
                res.end();
                const rawBuf = Buffer.concat(rawChunks);
                if (isGzipped) {
                  // Decompress before parsing
                  const gunzip = createGunzip();
                  const decompressed: Buffer[] = [];
                  gunzip.on('data', (chunk: Buffer) =>
                    decompressed.push(chunk),
                  );
                  gunzip.on('end', () => {
                    try {
                      const text =
                        Buffer.concat(decompressed).toString('utf-8');
                      extractAndEmitUsage(
                        text,
                        upRes.statusCode || 0,
                        Date.now() - startTime,
                      );
                    } catch {
                      // telemetry is best-effort
                    }
                  });
                  gunzip.on('error', () => {
                    /* ignore decompression errors */
                  });
                  gunzip.end(rawBuf);
                } else {
                  try {
                    const text = rawBuf.toString('utf-8');
                    extractAndEmitUsage(
                      text,
                      upRes.statusCode || 0,
                      Date.now() - startTime,
                    );
                  } catch {
                    // telemetry is best-effort
                  }
                }
              });
            } else {
              upRes.pipe(res);
            }
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/**
 * Extract token usage from Anthropic API response and emit to Lookout.
 * Handles both non-streaming JSON and streaming SSE responses.
 */
function extractAndEmitUsage(
  raw: string,
  statusCode: number,
  durationMs: number,
): void {
  let model = '';
  let inputTokens = 0;
  let outputTokens = 0;

  // Check if this is a streaming response (SSE)
  if (raw.includes('event: message_start')) {
    // Streaming: parse SSE events
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'message_start' && data.message) {
          model = data.message.model || '';
          if (data.message.usage) {
            inputTokens = data.message.usage.input_tokens || 0;
          }
        }
        if (data.type === 'message_delta' && data.usage) {
          outputTokens = data.usage.output_tokens || 0;
        }
      } catch {
        // skip unparseable lines
      }
    }
  } else {
    // Non-streaming: parse JSON body
    try {
      const body = JSON.parse(raw);
      model = body.model || '';
      if (body.usage) {
        inputTokens = body.usage.input_tokens || 0;
        outputTokens = body.usage.output_tokens || 0;
      }
    } catch {
      return;
    }
  }

  if (!model || (inputTokens === 0 && outputTokens === 0)) return;

  emitUsageSpan({
    model,
    inputTokens,
    outputTokens,
    durationMs,
    statusCode,
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
