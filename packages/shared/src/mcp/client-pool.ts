import { abortable, type SourceClient, type ToolDefinition } from "@cwatch/core/types";
interface Entry { client:SourceClient; references:number; lifetime:AbortController; tools?:Promise<ToolDefinition[]>; closed?:Promise<void> }
/** Per-host, per-run pool. The Agent receives proxies over its single existing IPC bridge. */
export class McpConnectionPool {
  private readonly entries = new Map<string,Entry>();
  private closed=false;
  constructor(readonly capacity=64) {}
  get size():number{return this.entries.size;}
  acquire(key:string,create:()=>SourceClient):SourceClient {
    if(this.closed)throw new Error('mcp_pool_closed');
    let entry=this.entries.get(key);
    if(!entry){if(this.entries.size>=this.capacity)throw new Error('mcp_pool_capacity');entry={client:create(),references:0,lifetime:new AbortController()};this.entries.set(key,entry);}
    const shared=entry;shared.references++;let released=false;
    const guard=()=>{if(released||this.closed||shared.lifetime.signal.aborted)throw new Error('mcp_pool_lease_closed');};
    return {
      guide:shared.client.guide ? { path:shared.client.guide.path, read:async signal=>{guard();return shared.client.guide!.read(AbortSignal.any([signal,shared.lifetime.signal]));}, check:()=>{guard();return shared.client.guide!.check();}, reset:()=>{guard();shared.client.guide!.reset();} } : undefined,
      resolveAction:shared.client.resolveAction ? (name,args,task)=>{guard();return shared.client.resolveAction!(name,args,task);} : undefined,
      checkPrerequisites:(name,args)=>{guard();return shared.client.checkPrerequisites?.(name,args);},
      listTools:async signal=>{guard();signal.throwIfAborted();shared.tools??=shared.client.listTools(shared.lifetime.signal);return structuredClone(await abortable(shared.tools,signal));},
      callTool:async(name,args,signal,context)=>{guard();return shared.client.callTool(name,args,AbortSignal.any([signal,shared.lifetime.signal]),context);},
      validateScope:(name,args,task)=>{guard();return shared.client.validateScope?.(name,args,task);},
      close:async()=>{if(released)return;released=true;if(--shared.references===0){if(this.entries.get(key)===shared)this.entries.delete(key);await this.dispose(shared);}},
    };
  }
  private dispose(entry:Entry):Promise<void>{entry.lifetime.abort(new Error('mcp_pool_entry_closed'));return entry.closed??=entry.client.close();}
  async close():Promise<void>{this.closed=true;const entries=[...this.entries.values()];this.entries.clear();await Promise.allSettled(entries.map(entry=>this.dispose(entry)));}
}
