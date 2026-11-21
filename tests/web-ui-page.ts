import type { Page } from 'playwright-core';

export class WorkbenchPage {
  constructor(readonly page: Page, readonly origin: string) {}

  async selectProfile(profile: 'agent' | 'web' = 'web'): Promise<void> {
    const label = profile === 'web' ? '产品调查' : '通用 Agent';
    await this.page.locator('fieldset.mode-pills label').filter({ hasText: label }).click();
  }

  async open(profile: 'agent' | 'web' = 'web'): Promise<void> {
    await this.page.goto(this.origin);
    await this.page.getByText('本地服务已连接', { exact: true }).waitFor();
    await this.selectProfile(profile);
  }

  async openSettings(): Promise<void> {
    if (!(await this.page.locator('#settings-popover').isVisible())) {
      await this.page.locator('#settings-toggle').click();
      await this.page.locator('#settings-popover').waitFor({ state: 'visible' });
    }
  }

  async closeSettings(): Promise<void> {
    if (await this.page.locator('#settings-popover').isVisible()) {
      await this.page.locator('#settings-toggle').click();
    }
  }

  async setMode(mode: 'live' | 'replay'): Promise<void> {
    await this.openSettings();
    const label = mode === 'live' ? '真实运行' : '离线演示';
    await this.page.locator('#settings-popover .segmented label').filter({ hasText: label }).click();
  }

  async setPermission(permission: 'explore' | 'ask' | 'allow-all'): Promise<void> {
    await this.openSettings();
    await this.page.getByLabel('工具权限', { exact: true }).selectOption(permission);
  }

  async openTrace(): Promise<void> {
    await this.page.locator('#toggle-trace-drawer').click();
    await this.page.locator('#trace-drawer').waitFor({ state: 'visible' });
  }

  async closeTrace(): Promise<void> {
    await this.page.locator('#close-trace-drawer').click();
    await this.page.locator('#trace-drawer').waitFor({ state: 'hidden' });
  }

  async start(): Promise<void> {
    await this.page.getByRole('button', { name: /开始调查|开始任务/ }).click();
  }

  async completed(): Promise<void> {
    await this.page.getByText('已完成 / 离线演示', { exact: true }).waitFor({ timeout: 20000 });
  }

  async report(): Promise<void> {
    await this.page.getByRole('tab', { name: /^(调查报告|任务结果)$/ }).click();
    await this.page.getByRole('link', { name: /下载 Markdown (报告|结果)/ }).waitFor();
  }

  reportClaims() {
    return this.page.getByRole('tabpanel', { name: '调查报告', exact: true }).getByRole('article');
  }

  reportCitations() {
    return this.reportClaims().getByRole('link');
  }

  async awaitingInput(): Promise<void> {
    await this.page.getByText('等待追问 / 真实会话', { exact: true }).waitFor({ timeout: 30000 });
  }

  async followUp(text: string): Promise<void> {
    await this.page.getByLabel('继续追问', { exact: true }).fill(text);
    await this.page.getByRole('button', { name: '发送追问', exact: true }).click();
  }

  async cancel(): Promise<void> {
    await this.page.getByRole('button', { name: '停止调查', exact: true }).click();
    await this.page.getByText('已取消 / 离线演示', { exact: true }).waitFor();
  }
}
