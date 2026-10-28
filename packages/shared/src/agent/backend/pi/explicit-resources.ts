import { createExtensionRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';

/** All prompts/Skills/tools come from the host. Never scan global or project resources. */
export class ExplicitResourceLoader implements ResourceLoader {
  private readonly extensions={extensions:[],errors:[],runtime:createExtensionRuntime()};
  constructor(private readonly prompt:string){}
  getExtensions(){return this.extensions;}
  getSkills(){return{skills:[],diagnostics:[]};}
  getPrompts(){return{prompts:[],diagnostics:[]};}
  getThemes(){return{themes:[],diagnostics:[]};}
  getAgentsFiles(){return{agentsFiles:[]};}
  getSystemPrompt(){return this.prompt;}
  getSystemPromptSource(){return undefined;}
  getAppendSystemPrompt(){return[];}
  getAppendSystemPromptSources(){return[];}
  extendResources(paths:Parameters<ResourceLoader['extendResources']>[0]):void{
    if(Object.values(paths).some(items=>items?.length))throw Error('implicit_sdk_resources_disabled');
  }
  async reload():Promise<void>{}
}
