import type { Page } from 'playwright-core';
export class WorkbenchPage {
  constructor(readonly page:Page,readonly origin:string){}
  async open(profile='web'){await this.page.goto(this.origin);await this.page.getByText('本地服务已连接',{exact:true}).waitFor();await this.page.getByLabel('任务模板',{exact:true}).selectOption(profile);}
  async start(){await this.page.getByRole('button',{name:/开始调查|开始任务/}).click();}
  async completed(){await this.page.getByText('已完成 / 离线演示',{exact:true}).waitFor({timeout:20000});}
  async report(){await this.page.getByRole('tab',{name:/^(调查报告|任务结果)$/}).click();await this.page.getByRole('link',{name:/下载 Markdown (报告|结果)/}).waitFor();}
  reportClaims(){return this.page.getByRole('tabpanel',{name:'调查报告',exact:true}).getByRole('article');}
  reportCitations(){return this.reportClaims().getByRole('link');}
  sourceOptions(){return this.page.getByRole('group',{name:'可用来源',exact:true}).getByRole('checkbox');}
  async selectedSources(){return this.page.getByRole('group',{name:'可用来源',exact:true}).getByRole('checkbox',{checked:true}).evaluateAll(nodes=>nodes.map(node=>(node as HTMLInputElement).value));}
  async approvals(){await this.page.getByRole('tab',{name:/待处理审批/}).click();}
  async awaitingInput(){await this.page.getByText('等待追问 / 真实会话',{exact:true}).waitFor({timeout:30000});}
  async followUp(text:string){await this.page.getByLabel('继续追问',{exact:true}).fill(text);await this.page.getByRole('button',{name:'发送追问',exact:true}).click();}
  async cancel(){await this.page.getByRole('button',{name:'停止调查',exact:true}).click();await this.page.getByText('已取消 / 离线演示',{exact:true}).waitFor();}
}
