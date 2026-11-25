import { existsSync } from 'node:fs';
import { HostLockError } from '@cwatch/server-core/runtime/run-service';
import { startWebServer } from './server.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const requested = process.env.WEB_PORT, port = Number(requested ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('WEB_PORT must be an integer from 1 to 65535');

async function start() {
  for (let attempt = 0; attempt < (requested ? 1 : 10); attempt++) {
    try { return await startWebServer({ root: process.cwd(), port: port + attempt }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || requested || attempt === 9) throw error; }
  }
  throw Error('web_port_unavailable');
}

let app: Awaited<ReturnType<typeof start>>;
try {
  app = await start();
} catch (error) {
  if (error instanceof HostLockError) {
    const who = error.pid ? `（PID ${error.pid}）` : '';
    const where = error.origin ? `：${error.origin}` : '';
    console.error(`Cwatch 工作台已在运行${who}${where}`);
    if (error.origin) console.error('请直接打开上面的地址，或先停止原终端里的旧服务后再重新运行 npm run web。');
    else console.error(`运行目录锁被活跃进程占用（${error.path}），请先停止旧服务后再重试。`);
    process.exit(1);
  }
  throw error;
}

console.log('Cwatch 工作台已启动：' + app.origin);
console.log('按 Ctrl+C 停止；运行记录保存在 .runtime/web，真实模式读取本机 .env。');

let stopping = false;
const stop = () => {
  if (stopping) { process.exit(130); return; }
  stopping = true;
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref();
  app.close().then(
    () => { clearTimeout(forceExit); process.exitCode = 0; },
    error => { clearTimeout(forceExit); console.error(String(error)); process.exitCode = 1; },
  );
};
process.on('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('SIGBREAK', stop);
