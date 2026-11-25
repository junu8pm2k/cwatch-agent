import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { Redactor } from '@cwatch/shared/sessions/trace';
import type { RunMessageInput, RunStartInput, WorkbenchBootstrap } from '@cwatch/core/types/runs';
import { buildDraftExport, isDraftExportFormat } from './export.ts';

const rewriteTsSpecifier: ts.TransformerFactory<ts.SourceFile> = context => sourceFile => {
  const visit: ts.Visitor = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith('.') && spec.endsWith('.ts')) {
        return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(spec.slice(0, -3) + '.js'), node.attributes);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith('.') && spec.endsWith('.ts')) {
        return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, ts.factory.createStringLiteral(spec.slice(0, -3) + '.js'), node.attributes);
      }
    }
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(sourceFile, visit) as ts.SourceFile;
};

function transpileClient(filePath: string): string {
  return ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { after: [rewriteTsSpecifier] },
  }).outputText;
}

function loadAssets(): Map<string, { type: string; body: string }> {
  const assets = new Map<string, { type: string; body: string }>([
    ['/', { type: 'text/html; charset=utf-8', body: readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8') }],
    ['/styles.css', { type: 'text/css; charset=utf-8', body: readFileSync(fileURLToPath(new URL('../public/styles.css', import.meta.url)), 'utf8') }],
    ['/client.js', { type: 'text/javascript; charset=utf-8', body: transpileClient(fileURLToPath(new URL('./client.ts', import.meta.url))) }],
  ]);
  const clientDir = fileURLToPath(new URL('./client', import.meta.url));
  if (existsSync(clientDir)) {
    for (const entry of readdirSync(clientDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      assets.set('/client/' + entry.name.slice(0, -3) + '.js', {
        type: 'text/javascript; charset=utf-8',
        body: transpileClient(resolve(clientDir, entry.name)),
      });
    }
  }
  return assets;
}

export interface WebServerOptions { root: string; port?: number; service?: RunService }
export async function startWebServer(options: WebServerOptions) {
  const service = options.service ?? new RunService({ root: options.root }), csrfToken = randomBytes(32).toString('hex');
  const assets = loadAssets();
  const streams = new Set<ServerResponse>(); let origin = '';
  const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function body(req: IncomingMessage): Promise<unknown> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw Error('json_required');
    if (Number(req.headers['content-length']) > 65536) { req.resume(); throw Error('request_too_large'); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) { const data = Buffer.from(chunk); size += data.length; if (size > 65536) { req.resume(); throw Error('request_too_large'); } chunks.push(data); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('invalid_json'); }
  }
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '请求来源不被允许。' });
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (req.method === 'POST') {
        const supplied = String(req.headers['x-cwatch-token'] ?? '');
        if (req.headers.origin !== origin || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) return send(res, 403, { error: '页面会话已失效，请刷新页面后重试。' });
      } else if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      if (req.method === 'GET' && assets.has(path)) { const asset = assets.get(path)!; res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.body); return; }
      if (path === '/api/bootstrap' && req.method === 'GET') {
        const model = service.connections.modelSummary();
        return send(res, 200, { csrfToken, model, profiles: service.profiles(), skills: service.skills(), runs: service.list(), maxConcurrentRuns: 2 } satisfies WorkbenchBootstrap);
      }
      if (path === '/api/extensions' && req.method === 'GET') return send(res, 200, service.extensions());
      if (req.method === 'POST') {
        if (path === '/api/extensions/providers') { service.connections.addProvider(await body(req)); return send(res, 201, service.extensions()); }
        if (path === '/api/extensions/search') { service.connections.saveSearch(await body(req)); return send(res, 200, service.extensions()); }
        if (path === '/api/extensions/search/delete') { await body(req); service.connections.clearSearch(); return send(res, 200, service.extensions()); }
        if (path === '/api/extensions/mcp') { service.addMcp(await body(req)); return send(res, 201, service.extensions()); }
        if (path === '/api/extensions/skills') { service.addSkill(await body(req)); return send(res, 201, service.extensions()); }
      }
      const providerMatch = /^\/api\/extensions\/providers\/([a-z][a-z0-9-]{0,39})\/delete$/.exec(path);
      if (providerMatch) {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
        await body(req);
        service.connections.removeProvider(providerMatch[1]);
        return send(res, 200, service.extensions());
      }
      const skillMatch = /^\/api\/extensions\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(toggle|delete))?$/.exec(path);
      if (skillMatch) {
        const [, name, action] = skillMatch;
        if (req.method === 'GET' && !action) return send(res, 200, service.skillDetail(name));
        if (req.method === 'POST' && action === 'toggle') {
          const input = z.object({ enabled: z.boolean() }).strict().parse(await body(req));
          return send(res, 200, service.toggleSkill(name, input.enabled));
        }
        if (req.method === 'POST' && action === 'delete') {
          await body(req);
          return send(res, 200, service.removeSkill(name));
        }
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const mcpMatch = /^\/api\/extensions\/mcp\/([a-zA-Z0-9_-]{1,40})\/(toggle|test|delete)$/.exec(path);
      if (mcpMatch) {
        const [, slug, action] = mcpMatch;
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
        if (action === 'toggle') {
          const input = z.object({ enabled: z.boolean() }).strict().parse(await body(req));
          return send(res, 200, service.toggleMcp(slug, input.enabled));
        }
        if (action === 'delete') {
          await body(req);
          return send(res, 200, service.removeMcp(slug));
        }
        await body(req);
        const ac = new AbortController(); req.once('close', () => ac.abort());
        return send(res, 200, await service.testMcp(slug, ac.signal));
      }
      if (path === '/api/runs' && req.method === 'POST') { const value = await body(req); return send(res, 202, service.start(value as RunStartInput)); }
      if (path === '/api/runs' && req.method === 'GET') return send(res, 200, service.list());
      const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(events|cancel|delete|approvals|report|export|trace|messages|end)(?:\/([a-f0-9-]{36}))?)?$/.exec(path);
      if (!match) return send(res, 404, { error: 'not_found' });
      const [, runId, action, requestId] = match;
      if (req.method === 'GET' && !action) return send(res, 200, service.get(runId));
      if (req.method === 'GET' && action === 'trace') return send(res, 200, service.trace(runId));
      if (req.method === 'GET' && action === 'report') {
        const report = service.report(runId); res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="competitor-report.md"' }); res.end(report); return;
      }
      if (req.method === 'GET' && action === 'export') {
        const format = url.searchParams.get('format') ?? 'md';
        if (!isDraftExportFormat(format)) return send(res, 400, { error: 'unsupported_export_format' });
        const run = service.get(runId), report = service.report(runId);
        const redactor = new Redactor([...Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''), ...service.connections.secrets()]);
        const exported = buildDraftExport(run, report, format);
        res.writeHead(200, { 'Content-Type': exported.contentType, 'Content-Disposition': exported.contentDisposition });
        res.end(redactor.clean(exported.body));
        return;
      }
      if (req.method === 'POST' && action === 'cancel') { await body(req); return send(res, 200, service.cancel(runId)); }
      if (req.method === 'POST' && action === 'delete') { await body(req); return send(res, 200, service.delete(runId)); }
      if (req.method === 'POST' && action === 'messages') return send(res, 202, service.sendMessage(runId, await body(req) as RunMessageInput));
      if (req.method === 'POST' && action === 'end') { await body(req); return send(res, 202, service.endConversation(runId)); }
      if (req.method === 'POST' && action === 'approvals' && requestId) {
        const input = z.object({ allowed: z.boolean(), argsHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body(req));
        service.respondToApproval(runId, requestId, input.allowed, input.argsHash); return send(res, 200, service.get(runId));
      }
      if (req.method === 'GET' && action === 'events') {
        service.get(runId); if (streams.size >= 16) return send(res, 429, { error: 'event_stream_capacity' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); streams.add(res);
        let closed = false;
        const emit = (snapshot: ReturnType<RunService['get']>) => {
          if (closed) return;
          if (res.writableLength > 1_000_000) { res.end(); return; }
          res.write('event: snapshot\ndata: ' + JSON.stringify(snapshot) + '\n\n');
        };
        const unsubscribe = service.subscribe(runId, emit);
        const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
        res.once('close', () => { closed = true; clearInterval(heartbeat); unsubscribe(); streams.delete(res); }); emit(service.get(runId)); return;
      }
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const redactor = new Redactor([...Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''), ...service.connections.secrets()]);
      const message = redactor.clean(error instanceof Error ? error.message : String(error));
      const status = message.includes('not_found') ? 404 : message.includes('capacity') || message.includes('run_active') || message.includes('not_pending') || message.includes('not_waiting') || message.includes('id_conflict') || message.includes('message_limit') || message.includes('hash_mismatch') ? 409 : message.includes('too_large') ? 413 : 400;
      send(res, status, { error: message });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  try {
    await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(options.port ?? 4310, '127.0.0.1', () => { server.removeListener('error', reject); resolveReady(); }); });
  } catch (error) { await service.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw Error('invalid_server_address');
  origin = 'http://127.0.0.1:' + address.port;
  service.setHostOrigin(origin);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { for (const stream of streams) stream.end(); const stopped = new Promise<void>(resolveClosed => server.close(() => resolveClosed())); server.closeAllConnections(); await service.close(); await stopped; })();
  return { server, service, origin, close };
}
