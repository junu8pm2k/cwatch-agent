// Small Docker-network-only receiver. No API/model credentials, shell or workspace access.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const token = readFileSync('/run/cwatch-token', 'utf8').trim();
const equal = value => { const a = Buffer.from(value), b = Buffer.from('Bearer ' + token); return a.length === b.length && timingSafeEqual(a, b); };
const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/health' && req.method === 'GET') return send(200, { status: 'ready' });
  if (req.url !== '/langfuse/experiments' || req.method !== 'POST') return send(404, { error: 'not_found' });
  if (!equal(String(req.headers.authorization ?? ''))) return send(401, { error: 'unauthorized' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(400, { error: 'json_required' });
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 65536) { req.resume(); return send(413, { error: 'request_too_large' }); } chunks.push(chunk); }
    const body = Buffer.concat(chunks).toString('utf8'), request = JSON.parse(body);
    if (!request.projectId || !request.datasetId || !/^cwatch\/current\/(activation|core_logic|resilience|artifact_quality)$/.test(request.datasetName)) return send(400, { error: 'dataset_required' });
    const id = randomUUID(), temporary = '/queue/' + id + '.tmp', file = '/queue/' + id + '.json';
    writeFileSync(temporary, JSON.stringify({ id, receivedAt: new Date().toISOString(), request }), { flag: 'wx' }); renameSync(temporary, file);
    send(202, { accepted: true, deliveryId: id });
  } catch { send(400, { error: 'invalid_request' }); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(80, '0.0.0.0', () => console.log('Cwatch authenticated experiment receiver ready (Docker network only).'));
