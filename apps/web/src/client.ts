import type { AgentTask, CompetitorTask } from '@cwatch/core/types';
import type { WorkbenchBootstrap, RunSnapshot, RunProfile, RunStartInput, RunStatus } from '@cwatch/core/types/runs';

const $=<E extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as E;
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const statusNames:Record<RunStatus,string>={preparing:'准备来源',running:'调查中',awaiting_approval:'等待审批',awaiting_user:'等待追问',cancelling:'正在取消',complete:'已完成',partial:'部分完成',failed:'运行失败',cancelled:'已取消',unknown:'运行中断'};
const active=(run?:RunSnapshot)=>Boolean(run&&['preparing','running','awaiting_approval','awaiting_user','cancelling'].includes(run.status));
const state:{bootstrap?:WorkbenchBootstrap;runs:RunSnapshot[];current?:RunSnapshot;tab:string;stream?:EventSource;submitting:boolean;sending:boolean;drafts:Map<string,string>;pendingMessage?:{runId:string;text:string;messageId:string};reportCache:Map<string,string>;loadingReports:Set<string>}={runs:[],tab:'process',submitting:false,sending:false,drafts:new Map(),reportCache:new Map(),loadingReports:new Set()};
function announce(text:string){$('announcer').textContent=text;}
function alertError(error:unknown){const text=error instanceof Error?error.message:String(error);$('alert').textContent=text;$('alert').hidden=false;announce(text);}
function clearError(){$('alert').hidden=true;}
async function api<T>(path:string,body?:unknown):Promise<T>{
  const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Cwatch-Token':state.bootstrap?.csrfToken??''},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await res.json();if(!res.ok)throw Error(value.error??'请求失败，请检查本地服务。');return value as T;
}
const investigation = (task:AgentTask):task is CompetitorTask => !('kind' in task);
const taskTitle = (task:AgentTask):string => investigation(task)?task.competitor.name+(task.competitor.name===task.product?' 动态调查':' · '+task.product):task.instruction.slice(0,80);
function currentProfile():RunProfile {return state.bootstrap!.profiles.find(p=>p.id===$<HTMLSelectElement>('profile').value)!;}
function mode() {return (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value??'replay') as 'live'|'replay';}
function formatTime(value:string){return new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}
function safeUrl(raw:string):string|undefined{try{const url=new URL(raw);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}}
function setConnection(text:string,online=true){$('connection').innerHTML='<span class="dot"></span>'+escape(text);$('connection').style.color=online?'':'#ae6c45';}
function profileForm(task=currentProfile().task){
  const domain=investigation(task);
  $('agent-fields').hidden=domain;$('investigation-fields').hidden=!domain;
  for(const id of ['competitor-name','competitor-id','product','domains','start-date','end-date'])$<HTMLInputElement>(id).required=domain;
  $<HTMLTextAreaElement>('instruction').required=!domain;
  $('page-title').textContent=domain?'竞品调查':'通用 Agent';
  $('page-description').textContent=domain?'追踪变化，让结论有据可查。':'交代目标，开始协作。';
  $('task-title').textContent=domain?'调查设置':'任务设置';
  $('start-run').innerHTML=(domain?'开始调查':'开始任务')+' <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg>';
  $('cancel-run').textContent=domain?'停止调查':'停止任务';
  $('tab-report').textContent=domain?'调查报告':'任务结果';
  if(domain){
    $<HTMLInputElement>('competitor-name').value=task.competitor.name;$<HTMLInputElement>('competitor-id').value=task.competitor.id;
    $<HTMLInputElement>('product').value=task.product;$<HTMLInputElement>('domains').value=task.competitor.domains.join(', ');
    $<HTMLInputElement>('start-date').value=task.window.start.slice(0,10);$<HTMLInputElement>('end-date').value=task.window.end.slice(0,10);
  }else $<HTMLTextAreaElement>('instruction').value=task.instruction;
  $('source-options').innerHTML=currentProfile().sources.map(source=>'<label class="source-option"><input type="checkbox" name="source" value="'+escape(source.slug)+'" '+(source.active&&task.allowedSources.includes(source.slug)?'checked ':'')+(!source.active?'disabled ':'')+'><span>'+escape(source.name)+'</span><small>'+escape(source.channel==='mcp'?'MCP':'内建')+'</small></label>').join('');
  modeChanged();
}
function modeChanged(){
  const replay=mode()==='replay',configured=state.bootstrap?.model.configured;
  for(const id of ['competitor-name','competitor-id','product','domains','start-date','end-date'])$<HTMLInputElement>(id).readOnly=replay;
  for(const input of document.querySelectorAll<HTMLInputElement>('input[name=source]'))input.disabled=replay||!currentProfile().sources.find(source=>source.slug===input.value)?.active;
  $<HTMLTextAreaElement>('instruction').readOnly=replay;
  $('mode-note').textContent=replay?'固定样例，可直接体验。':configured?'使用已配置的模型和来源。':'请先在本机 .env 配置模型并重启服务。';
  $('start-note').textContent=replay?'演示使用固定脚本与合成数据，不调用外部服务。':'将使用模型与来源服务，按实际用量消耗额度。';
  $<HTMLButtonElement>('start-run').disabled=state.submitting||(!replay&&!configured);
}
function renderHistory(){
  $('history-count').textContent=String(state.runs.length);
  $('history-list').innerHTML=state.runs.length?state.runs.map(run=>'<button class="history-item '+(state.current?.id===run.id?'active':'')+'" data-run="'+escape(run.id)+'" '+(state.current?.id===run.id?'aria-current="true" ':'')+'><strong>'+escape(taskTitle(run.task))+'</strong><small><span>'+escape(statusNames[run.status])+'</span><span>'+new Date(run.createdAt).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})+'</span></small></button>').join(''):'<p class="sidebar-empty">还没有任务记录</p>';
  const select=$<HTMLSelectElement>('history-select');select.innerHTML='<option value="">新建任务</option>'+state.runs.map(run=>'<option value="'+escape(run.id)+'">'+escape(taskTitle(run.task))+' · '+escape(statusNames[run.status])+'</option>').join('');select.value=state.current?.id??'';
}
function update(run:RunSnapshot){
  const previous=state.current?.status,index=state.runs.findIndex(item=>item.id===run.id);
  if(index>=0&&(state.runs[index].revision??0)>(run.revision??0))return;
  if(index<0)state.runs.unshift(run);else state.runs[index]=run;
  if(state.current?.id===run.id){state.current=run;if(previous!==run.status&&run.conversation&&run.status==='awaiting_user')showTab('report');renderRun();if(previous!==run.status)announce(statusNames[run.status]);}
  renderHistory();
}
function selectRun(run:RunSnapshot){
  state.stream?.close();state.current=run;localStorage.setItem('cwatch-selected-run',run.id);
  $<HTMLSelectElement>('profile').value=run.profile;
  const radio=document.querySelector<HTMLInputElement>('input[name=mode][value='+run.mode+']');if(radio)radio.checked=true;
  $<HTMLSelectElement>('permission').value=run.permission;profileForm(run.task);permissionChanged();showTab(run.status==='awaiting_approval'?'approvals':run.conversation?'report':'process');renderHistory();renderRun();
  const stream=new EventSource('/api/runs/'+run.id+'/events');state.stream=stream;
  stream.addEventListener('snapshot',event=>{if(state.current?.id!==run.id)return;setConnection('本地服务已连接');update(JSON.parse((event as MessageEvent<string>).data));});
  stream.onerror=()=>{if(state.current?.id===run.id)setConnection('连接中断，正在重连',false);};
}
function newRun(){
  state.stream?.close();state.current=undefined;localStorage.removeItem('cwatch-selected-run');clearError();
  $<HTMLSelectElement>('profile').value='agent';document.querySelector<HTMLInputElement>('input[name=mode][value=replay]')!.checked=true;
  $<HTMLSelectElement>('permission').value='explore';profileForm();permissionChanged();showTab('process');renderHistory();renderRun();announce('可以新建任务。');
}
function showTab(tab:string){
  state.tab=tab;
  for(const name of ['process','report','approvals']){const selected=name===tab;$('tab-'+name).setAttribute('aria-selected',String(selected));$('tab-'+name).tabIndex=selected?0:-1;$('panel-'+name).hidden=!selected;}
  if(tab==='report')renderReport();
}
function renderRun(){
  const run=state.current;
  document.querySelector<HTMLElement>('.workbench')!.dataset.hasRun=String(Boolean(run));
  $('run-title').textContent=run?taskTitle(run.task):'任务空间';
  $('run-stats').hidden=!run;
  $('run-label').textContent=run?statusNames[run.status]+' / '+(run.mode==='replay'?'离线演示':run.conversation?'真实会话':'真实调查'):'准备就绪';
  $('run-label').className='run-label '+(active(run)?'busy':run&&['failed','cancelled','unknown','partial'].includes(run.status)?'error':'');
  $('pipeline').hidden=run?!investigation(run.task):!investigation(currentProfile().task);
  $('pipeline').innerHTML=['计划','采集','分析','审阅','草稿'].map((name,index)=>'<div class="pipeline-step '+(run&&run.stage>index?'done':run&&run.stage===index&&active(run)?'current':'')+'"><span class="step-dot">'+(run&&run.stage>index?'✓':index+1)+'</span>'+name+'</div>').join('');
  $('stat-tools').textContent=run?String(run.toolCalls):'—';$('stat-turns').textContent=run&&run.mode==='live'?String(run.modelTurns):'—';
  $('stat-tokens').textContent=run&&run.totalTokens?run.totalTokens.toLocaleString():'—';elapsed();
  $('cancel-run').hidden=!active(run);$<HTMLButtonElement>('cancel-run').disabled=run?.status==='cancelling';
  $('approval-count').textContent=String(run?.approvals.length??0);$('approval-count').className='count-badge '+(run?.approvals.length?'pending':'');
  const permissionNames:Record<string,string>={explore:'只读探索',ask:'写入前审批','allow-all':'允许已配置操作'};
  $('run-footer-text').textContent=run?permissionNames[run.permission]+' · 工具调用已记录':'任务与对话保存在本机';
  $('provenance-label').textContent=run?.mode==='replay'?'合成数据演示':run?'来源与引用请核验':'按需选择来源与技能';
  renderProcess();renderApprovals();renderConversation();if(state.tab==='report')renderReport();
}
function renderConversation(){
  const run=state.current;$('conversation').hidden=!run?.conversation;
  if(!run?.conversation)return;
  const key=run.id+':'+(run.messages?.length??0),log=$('conversation-messages');
  if(log.dataset.key!==key){log.innerHTML=(run.messages??[]).map(message=>'<article class="conversation-message '+(message.role==='user'?'user':'assistant')+'"><h4>'+escape(message.role==='user'?'你':'Agent')+'</h4><div>'+escape(message.content)+'</div></article>').join('');log.dataset.key=key;}
  const waiting=run.status==='awaiting_user'&&!state.sending;
  const input=$<HTMLTextAreaElement>('follow-up');
  if(input.dataset.run!==run.id){input.value=state.drafts.get(run.id)??'';input.dataset.run=run.id;}
  input.disabled=!waiting;$<HTMLButtonElement>('send-message').disabled=!waiting;$<HTMLButtonElement>('end-conversation').disabled=!waiting;
  $('conversation-note').textContent=run.status==='awaiting_user'?'对话与工具结果会保留，用量按整段会话累计。':active(run)?'正在处理，答复后可以继续追问。':run.status==='unknown'?'服务已重启，会话已中断；请新建会话。':'会话已结束，对话记录已保存。';
}
function elapsed(){
  const run=state.current;
  if(!run){$('stat-time').textContent='—';return;}
  const seconds=Math.max(0,Math.floor((Date.parse(run.endedAt??new Date().toISOString())-Date.parse(run.createdAt))/1000));
  $('stat-time').textContent=seconds<60?seconds+'s':Math.floor(seconds/60)+'m '+seconds%60+'s';
}
const workspaceSymbol='<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="9" width="34" height="28" rx="5"/><path d="M7 17h34M17 17v20m7-12h10m-10 6h6"/><circle cx="12" cy="13" r=".8" fill="currentColor" stroke="none"/></svg>';
const researchIllustration='<svg class="research-illustration" viewBox="0 0 360 190" fill="none" aria-hidden="true"><ellipse cx="180" cy="95" rx="131" ry="67" stroke="#e4eaf4" stroke-dasharray="4 7"/><path d="M88 75 180 95l92-40M180 95l77 56M180 95l-84 53" stroke="#c4d1ed" stroke-width="1.5"/><circle cx="180" cy="95" r="46" fill="#f0f4ff"/><rect x="151" y="66" width="58" height="58" rx="18" fill="#3763d8"/><path d="M191 83a16 16 0 1 0 0 24M178 83v12l8 5" stroke="white" stroke-width="2.5" stroke-linecap="round"/><rect x="47" y="50" width="67" height="49" rx="10" fill="white" stroke="#dce4f1"/><path d="M60 64h21M60 72h39M60 80h30" stroke="#a0afc8" stroke-width="2" stroke-linecap="round"/><rect x="249" y="32" width="55" height="44" rx="10" fill="white" stroke="#dce4f1"/><path d="m263 57 8-8 8 6 11-12" stroke="#557ddc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="236" y="131" width="47" height="36" rx="9" fill="white" stroke="#dce4f1"/><path d="m249 148 7 6 13-14" stroke="#4b958b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="95" cy="149" r="10" fill="#e6edf9"/><path d="m91 149 3 3 5-6" stroke="#6c8ac4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="224" cy="22" r="3" fill="#c8d6f4"/><circle cx="132" cy="174" r="3" fill="#c8d6f4"/></svg>';
function empty(title:string,note:string,symbol=workspaceSymbol){
  return '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">'+symbol+'</div><h3>'+escape(title)+'</h3><p>'+escape(note)+'</p></div>';
}
function renderProcess(){
  const run=state.current;
  if(!run){
    const domain=investigation(currentProfile().task);
    $('process-content').innerHTML='<div class="workspace-welcome">'+researchIllustration+'<h3>'+(domain?'从变化中，找到下一步。':'把目标交给 Cwatch。')+'</h3><p>'+(domain?'从公开来源收集线索，核验变化与证据，整理为可追溯的调查草稿。':'阅读材料、研究问题、整理结论。<br>你来确定方向，让 Agent 把过程与结果带回来。')+'</p><div class="welcome-actions"><button type="button" data-template="agent"'+(!domain?' aria-pressed="true"':' aria-pressed="false"')+'>'+workspaceSymbol+'<span>通用任务<small>从一个问题开始</small></span></button><button type="button" data-template="standard"'+(domain?' aria-pressed="true"':' aria-pressed="false"')+'><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5 5M7 10h6m-3-3v6"/></svg><span>竞品调查<small>追踪变化与来源</small></span></button></div><p class="welcome-note">设置好任务，点击“'+(domain?'开始调查':'开始任务')+'”即可运行</p></div>';return;
  }
  const old=$('process-content').querySelector('.activity-scroll'),scroll=old?.scrollTop??0,atBottom=!old||old.scrollHeight-old.clientHeight-scroll<70;
  $('process-content').innerHTML=(run.mode==='replay'?'<div class="run-notice">离线演示使用固定脚本和合成数据。</div>':'')+(run.error?'<div class="run-notice">'+escape(run.error)+'</div>':'')+'<div class="activity-scroll"><ol class="activity-list">'+run.activities.map(event=>'<li class="activity '+escape(event.kind)+'"><div class="activity-header"><span class="activity-message">'+escape(event.message)+'</span><time datetime="'+escape(event.timestamp)+'">'+formatTime(event.timestamp)+'</time></div>'+(event.detail?'<details><summary>查看调用详情</summary><pre>'+escape(event.detail)+'</pre></details>':'')+'</li>').join('')+'</ol></div>';
  const next=$('process-content').querySelector('.activity-scroll');if(next)next.scrollTop=atBottom?next.scrollHeight:scroll;
}
function renderApprovals(){
  const run=state.current;
  if(!run?.approvals.length){$('approval-content').innerHTML=empty('当前没有待处理审批','Ask 模式下，修改、发送或发布操作会在这里等待你逐次确认。','✓');return;}
  $('approval-content').innerHTML=run.approvals.map(request=>'<article class="approval-card"><h3>这次操作需要你的确认</h3><p class="approval-tool">'+escape(request.tool)+'</p><p>仅批准本次请求和下方参数。批准后，主进程仍会复查来源与当前权限。</p><pre class="approval-params">'+escape(request.argsSummary)+'</pre><dl><dt>请求</dt><dd>'+escape(request.requestId)+'</dd><dt>参数哈希</dt><dd>'+escape(request.argsHash)+'</dd></dl><span class="approval-clock" data-expires="'+escape(request.expiresAt)+'"></span><div class="approval-actions"><button class="button approve" data-approve="'+escape(request.requestId)+'" data-hash="'+escape(request.argsHash)+'">批准这一次</button><button class="button secondary" data-deny="'+escape(request.requestId)+'" data-hash="'+escape(request.argsHash)+'">拒绝操作</button></div></article>').join('');clocks();
}
function clocks(){for(const node of document.querySelectorAll<HTMLElement>('[data-expires]')){const remaining=Math.ceil((Date.parse(node.dataset.expires!)-Date.now())/1000);node.textContent=remaining>0?'审批剩余 '+remaining+' 秒':'审批已到期，正在更新状态';}}
function inline(value:string){return escape(value).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>');}
function markdown(value:string){
  return value.split('\n').map(line=>{
    const heading=/^(#{1,4})\s+(.+)$/.exec(line);
    if(heading)return '<h3>'+inline(heading[2])+'</h3>';
    if(/^\|[- :|]+\|$/.test(line))return '';
    if(line.startsWith('|'))return '<p>'+inline(line.replace(/^\||\|$/g,'').split('|').map(s=>s.trim()).join('　 /　 '))+'</p>';
    if(/^[-*]\s/.test(line))return '<p>• '+inline(line.slice(2))+'</p>';
    return line.trim()?'<p>'+inline(line)+'</p>':'';
  }).join('');
}
async function loadReport(run:RunSnapshot){
  if(state.loadingReports.has(run.id)||state.reportCache.has(run.id))return;
  state.loadingReports.add(run.id);
  try{const response=await fetch('/api/runs/'+run.id+'/report');if(!response.ok)throw Error('报告读取失败。');state.reportCache.set(run.id,await response.text());if(state.current?.id===run.id&&state.tab==='report')renderReport();}
  catch(error){alertError(error);}finally{state.loadingReports.delete(run.id);}
}
function renderReport(){
  const run=state.current;
  if(run?.conversation){
    const latest=run.messages?.filter(message=>message.role==='assistant').at(-1)?.content;
    if(latest!==undefined)state.reportCache.set(run.id,latest);
    $('report-content').innerHTML=latest===undefined?'':'<div class="report-actions"><a class="button secondary" href="/api/runs/'+escape(run.id)+'/report" download="agent-result.md">下载最新回答</a><button class="button secondary" id="copy-report">复制最新回答</button></div>';
    return;
  }
  if(!run?.reportReady){const domain=investigation(run?.task??currentProfile().task);$('report-content').innerHTML=empty(run&&['failed','cancelled','unknown'].includes(run.status)?'本次运行未生成结果':'结果将在这里呈现',run?.error??(domain?'调查完成后，在这里查看结论、来源与完整报告。':'任务完成后，在这里阅读、复制或下载回答。'));return;}
  const document=run.conversation?run.messages?.filter(message=>message.role==='assistant').at(-1)?.content:state.reportCache.get(run.id);
  if(document!==undefined&&run.conversation)state.reportCache.set(run.id,document);
  if(document===undefined)void loadReport(run);
  if(!investigation(run.task)){
    $('report-content').innerHTML='<div class="report-heading"><h3>任务结果</h3><span class="report-mode">'+(run.mode==='replay'?'固定脚本演示':'Agent 回答')+'</span></div>'+(run.gaps.length?'<div class="run-notice">'+run.gaps.map(escape).join('<br>')+'</div>':'')+'<div class="report-document">'+(document===undefined?'正在读取…':markdown(document))+'</div><div class="report-actions"><a class="button secondary" href="/api/runs/'+escape(run.id)+'/report" download="agent-result.md">下载 Markdown 结果</a><button class="button secondary" id="copy-report">复制完整报告</button></div>';
    return;
  }
  $('report-content').innerHTML='<div class="report-heading"><h3>调查结论与引用</h3><span class="report-mode">'+(run.mode==='replay'?'合成快照 · 演示':'本地草稿 · 待核对')+'</span></div>'+
    (run.gaps.length?'<div class="run-notice"><strong>本次有 '+run.gaps.length+' 项缺口</strong><br>'+run.gaps.map(gap=>escape(gap)).join('<br>')+'</div>':'')+
    (run.claims.length?run.claims.map(claim=>'<article class="claim"><p>'+escape(claim.text)+'</p><div class="evidence-links">'+claim.evidence.map(evidence=>{const url=safeUrl(evidence.url);return '<div>'+(url?'<a href="'+escape(url)+'" target="_blank" rel="noopener noreferrer">'+escape(evidence.source)+' · '+escape(evidence.title)+'</a>':'<span>'+escape(evidence.title)+'</span>')+'<small>'+escape(evidence.publishedAt?new Date(evidence.publishedAt).toLocaleDateString('zh-CN'):'发布时间未知')+(evidence.provenance==='fixture'?' · 合成快照':'')+'</small></div>';}).join('')+'</div></article>').join(''):'<p class="field-note">本次没有可进入结构化主张的证据，请查看缺口与完整报告。</p>')+
    '<div class="report-actions"><a class="button secondary" href="/api/runs/'+escape(run.id)+'/report" download="competitor-report.md">下载 Markdown 报告</a><button class="button secondary" id="copy-report">复制完整报告</button></div><details class="report-full"><summary>查看完整报告</summary><div class="report-document">'+(document===undefined?'<p>正在读取报告…</p>':markdown(document))+'</div></details>';
}
function permissionChanged(){
  const value=$<HTMLSelectElement>('permission').value;
  $('permission-note').textContent=value==='explore'?'可读取与分析，禁止修改、发送和发布。':value==='ask'?'每次写入、发送或发布前由你确认。':'已配置操作无需逐次审批，仍受来源范围限制。';
}
function renderConnections(){
  const bootstrap=state.bootstrap!,sources=[...new Map(bootstrap.profiles.flatMap(p=>p.sources).map(source=>[source.slug,source])).values()];
  $('connections-panel').innerHTML='<h2>来源与连接</h2><p>这里展示已加载的本地来源。来源、MCP 和 Skill 通过项目配置与 CLI 管理，密钥保留在本机环境。</p>'+sources.map(source=>'<div class="connection-row"><span>'+escape(source.name)+' <small>'+escape(source.slug)+'</small></span><small>'+escape(source.channel)+' · '+(source.active?'已配置':'未启用')+'</small></div>').join('')+'<div class="connection-row"><span>模型连接</span><small>'+(bootstrap.model.configured?escape(bootstrap.model.provider)+' / '+escape(bootstrap.model.id):'待配置 .env')+'</small></div><div class="connection-row"><span>可选技能</span><small>'+bootstrap.skills.filter(s=>s.enabled).length+' 个已启用</small></div><p>“已配置”表示本地配置已加载；服务是否可达会在真实调查调用时核验。</p>';
}
$('run-form').addEventListener('submit',event=>{
  event.preventDefault();if(state.submitting)return;clearError();
  void(async()=>{
    state.submitting=true;modeChanged();
    try{
      const profile=currentProfile(),replay=mode()==='replay',task=structuredClone(profile.task);
      if(!replay&&investigation(task)){
        task.taskId='web-'+Date.now();task.competitor.name=$<HTMLInputElement>('competitor-name').value.trim();task.competitor.id=$<HTMLInputElement>('competitor-id').value.trim();
        task.competitor.domains=$<HTMLInputElement>('domains').value.split(/[,，\s]+/).filter(Boolean);task.product=$<HTMLInputElement>('product').value.trim();
        task.window={start:$<HTMLInputElement>('start-date').value+'T00:00:00+08:00',end:$<HTMLInputElement>('end-date').value+'T00:00:00+08:00',basis:'published_at',timezone:'Asia/Shanghai'};
        task.allowedSources=[...document.querySelectorAll<HTMLInputElement>('input[name=source]:checked')].map(input=>input.value);
      }
      if(!investigation(task)){task.instruction=$<HTMLTextAreaElement>('instruction').value.trim();if(!replay){task.taskId='task-'+Date.now();task.allowedSources=[...document.querySelectorAll<HTMLInputElement>('input[name=source]:checked')].map(input=>input.value);}}
      if(investigation(task)&&Date.parse(task.window.start)>=Date.parse(task.window.end))throw Error('结束日期须晚于开始日期。');
      if(investigation(task)&&!task.allowedSources.length)throw Error('请至少选择一个采集来源。');
      const input:RunStartInput={profile:profile.id,mode:mode(),permission:$<HTMLSelectElement>('permission').value as RunStartInput['permission'],...(!investigation(task)&&!replay?{conversation:true}:{}),task,skills:[...document.querySelectorAll<HTMLInputElement>('input[name=skill]:checked')].map(input=>input.value),limits:{timeoutMs:Number($<HTMLInputElement>('timeout').value)*1000,maxTokens:Number($<HTMLInputElement>('tokens').value)}};
      const run=await api<RunSnapshot>('/api/runs',input);state.runs.unshift(run);selectRun(run);announce('调查已启动。');
    }catch(error){alertError(error);}finally{state.submitting=false;modeChanged();}
  })();
});
$('follow-up').addEventListener('input',()=>{if(state.current)state.drafts.set(state.current.id,$<HTMLTextAreaElement>('follow-up').value);});
$('message-form').addEventListener('submit',event=>{
  event.preventDefault();const run=state.current,text=$<HTMLTextAreaElement>('follow-up').value.trim();
  if(!run||run.status!=='awaiting_user'||state.sending||!text)return;
  const pending=state.pendingMessage;
  const message=pending?.runId===run.id&&pending.text===text?pending:{runId:run.id,text,messageId:crypto.randomUUID()};
  state.pendingMessage=message;state.sending=true;clearError();renderConversation();
  void api<RunSnapshot>('/api/runs/'+run.id+'/messages',{text,messageId:message.messageId}).then(value=>{
    state.drafts.delete(run.id);state.pendingMessage=undefined;
    if(state.current?.id===run.id)$<HTMLTextAreaElement>('follow-up').value='';
    update(value);announce('追问已发送。');
  }).catch(alertError).finally(()=>{state.sending=false;renderConversation();});
});
$('end-conversation').addEventListener('click',()=>{
  const run=state.current;if(!run||run.status!=='awaiting_user'||state.sending)return;
  state.sending=true;clearError();renderConversation();
  void api<RunSnapshot>('/api/runs/'+run.id+'/end',{}).then(update).catch(alertError).finally(()=>{state.sending=false;renderConversation();});
});
$('new-run').addEventListener('click',newRun);$('profile').addEventListener('change',()=>{profileForm();if(!state.current)renderRun();});
$('process-content').addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-template]');
  if(!button||state.current||!state.bootstrap?.profiles.some(profile=>profile.id===button.dataset.template))return;
  $<HTMLSelectElement>('profile').value=button.dataset.template!;profileForm();renderRun();
  announce('已选择'+currentProfile().name+'模板。');
});
for(const input of document.querySelectorAll<HTMLInputElement>('input[name=mode]'))input.addEventListener('change',modeChanged);
$('permission').addEventListener('change',permissionChanged);
$('cancel-run').addEventListener('click',()=>{const run=state.current;if(!run)return;clearError();void api<RunSnapshot>('/api/runs/'+run.id+'/cancel',{}).then(update).catch(alertError);});
$('history-list').addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-run]');const run=state.runs.find(r=>r.id===target?.dataset.run);if(run){clearError();selectRun(run);}});
$('history-select').addEventListener('change',()=>{const run=state.runs.find(r=>r.id===$<HTMLSelectElement>('history-select').value);if(run)selectRun(run);else newRun();});
for(const button of document.querySelectorAll<HTMLElement>('[data-tab]'))button.addEventListener('click',()=>showTab(button.dataset.tab!));
document.querySelector('[role=tablist]')!.addEventListener('keydown',event=>{
  const key=(event as KeyboardEvent).key;if(!['ArrowLeft','ArrowRight','Home','End'].includes(key))return;
  event.preventDefault();const names=['process','report','approvals'],index=names.indexOf(state.tab),next=key==='Home'?0:key==='End'?2:(index+(key==='ArrowRight'?1:2))%3;showTab(names[next]);$('tab-'+names[next]).focus();
});
$('approval-content').addEventListener('click',event=>{
  const target=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-approve],[data-deny]'),run=state.current;if(!target||!run)return;
  const requestId=target.dataset.approve??target.dataset.deny!;target.disabled=true;
  void api<RunSnapshot>('/api/runs/'+run.id+'/approvals/'+requestId,{allowed:Boolean(target.dataset.approve),argsHash:target.dataset.hash}).then(update).catch(error=>{alertError(error);target.disabled=false;});
});
$('report-content').addEventListener('click',event=>{if((event.target as HTMLElement).closest('#copy-report')){const report=state.current&&state.reportCache.get(state.current.id);if(report)void navigator.clipboard.writeText(report).then(()=>{const button=$('copy-report');button.textContent='已复制';announce('报告已复制。');}).catch(()=>alertError('浏览器未允许复制，请下载报告。'));}});
function showConnections(visible:boolean){
  $('connections-panel').hidden=!visible;
  $('nav-sources').classList.toggle('selected',visible);$('nav-workbench').classList.toggle('selected',!visible);
  $('nav-sources').setAttribute('aria-expanded',String(visible));$('mobile-sources').setAttribute('aria-expanded',String(visible));
}
$('nav-sources').addEventListener('click',()=>showConnections($('connections-panel').hidden));
$('mobile-sources').addEventListener('click',()=>showConnections($('connections-panel').hidden));
$('nav-workbench').addEventListener('click',()=>showConnections(false));
setInterval(()=>{elapsed();clocks();},1000);
async function init(){
  try{
    const bootstrap=await api<WorkbenchBootstrap>('/api/bootstrap');state.bootstrap=bootstrap;state.runs=bootstrap.runs;
    $('profile').innerHTML=bootstrap.profiles.map(profile=>'<option value="'+escape(profile.id)+'">'+escape(profile.name)+'</option>').join('');
    $<HTMLSelectElement>('profile').value='agent';
    $('skill-options').innerHTML=bootstrap.skills.filter(skill=>skill.enabled).map(skill=>'<label class="source-option"><input type="checkbox" name="skill" value="'+escape(skill.name)+'"><span>'+escape(skill.name)+'</span></label>').join('')||'<p class="field-note">使用所选模板的基础指导；可通过 CLI 安装和选择自己的 Skill。</p>';
    $('model-status').textContent=bootstrap.model.configured?'模型：'+bootstrap.model.provider+' / '+bootstrap.model.id:'模型未配置 · 离线演示可用';
    setConnection('本地服务已连接');renderConnections();profileForm();permissionChanged();renderHistory();
    const selected=state.runs.find(run=>run.id===localStorage.getItem('cwatch-selected-run'))??state.runs.find(active)??state.runs[0];
    if(selected)selectRun(selected);else{showTab('process');renderRun();}
  }catch(error){setConnection('本地服务未连接',false);alertError(error);$<HTMLButtonElement>('start-run').disabled=true;}
}
void init();
