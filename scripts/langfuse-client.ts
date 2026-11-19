import { z } from 'zod';
import { Redactor } from '@cwatch/shared/sessions/trace';
import type { LangfuseConfig } from '@cwatch/shared/config/langfuse';

export type LangfuseTransport = typeof fetch;
const pageSchema = z.object({data:z.array(z.unknown()),meta:z.object({totalPages:z.number().optional()}).passthrough().optional()}).passthrough();

/** Credentials remain in the host; errors never include request bodies or authentication headers. */
export class LangfuseClient {
  constructor(readonly config:LangfuseConfig,private readonly transport:LangfuseTransport=fetch,readonly redactor=new Redactor([config.publicKey,config.secretKey])) {}
  async request(path:string,body?:unknown,headers:Record<string,string>={},method:'GET'|'POST'|'PATCH'=body===undefined?'GET':'POST',timeoutMs=this.config.timeoutMs):Promise<unknown> {
    if(!path.startsWith('/api/public/')||path.includes('..')||path.includes('\\'))throw Error('invalid_langfuse_api_path');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000)throw Error('invalid_langfuse_request_timeout');
    let response:Response;
    try {
      response=await this.transport(this.config.baseUrl+path,{method,redirect:'error',
        headers:{...headers,Authorization:'Basic '+Buffer.from(this.config.publicKey+':'+this.config.secretKey).toString('base64'),'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(this.redactor.clean(body)),signal:AbortSignal.timeout(timeoutMs)});
    } catch { throw Error('langfuse_request_failed: '+path.split('?')[0]); }
    if(!response.ok){
      let detail='';try{detail=this.redactor.clean(JSON.stringify(await response.json())).slice(0,2000);}catch{ /* Do not expose arbitrary HTML error pages. */ }
      throw Error('langfuse_http_'+response.status+': '+path.split('?')[0]+(detail?' '+detail:''));
    }
    if(response.status===204)return null;
    return await response.json() as unknown;
  }
  async pages(path:string):Promise<unknown[]> {
    const result:unknown[]=[];
    for(let page=1;page<=1000;page++){
      const separator=path.includes('?')?'&':'?',value=pageSchema.parse(await this.request(path+separator+new URLSearchParams({page:String(page),limit:'100'})));
      result.push(...value.data);
      if(value.meta?.totalPages!==undefined?page>=value.meta.totalPages:value.data.length<100)return result;
    }
    throw Error('langfuse_pagination_limit');
  }
  async projectId():Promise<string> {
    const projects=z.array(z.object({id:z.string().min(1)})).parse(await this.pages('/api/public/projects'));
    if(projects.length!==1)throw Error('langfuse_project_scope_must_be_unique');
    return projects[0].id;
  }
  async writeScores(scores:unknown[]):Promise<void> {
    for(let offset=0;offset<scores.length;offset+=100){
      const result=await this.request('/api/public/scores',scores.slice(offset,offset+100));
      // The bulk endpoint may return a successful HTTP status with individual failures.
      if(result&&typeof result==='object'&&'errors' in result&&Array.isArray(result.errors)&&result.errors.length)throw Error('langfuse_score_partial_failure');
    }
  }
}
