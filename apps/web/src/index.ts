import { existsSync } from 'node:fs';
import { startWebServer } from './server.ts';
if(existsSync('.env'))process.loadEnvFile('.env');
const requested=process.env.WEB_PORT,port=Number(requested??4310);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('WEB_PORT must be an integer from 1 to 65535');
async function start(){
  for(let attempt=0;attempt<(requested?1:10);attempt++){
    try{return await startWebServer({root:process.cwd(),port:port+attempt});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE'||requested||attempt===9)throw error;}
  }
  throw Error('web_port_unavailable');
}
const app=await start();
console.log('Cwatch 工作台已启动：'+app.origin);
console.log('按 Ctrl+C 停止；运行记录保存在 .runtime/web，真实模式读取本机 .env。');
const stop=()=>{app.close().then(()=>{process.exitCode=0;},error=>{console.error(String(error));process.exitCode=1;});};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
