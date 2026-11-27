import type { Page } from 'playwright-core';

export class WorkbenchPage {
  constructor(readonly page: Page, readonly origin: string) {}

  async showTaskSetup(): Promise<void> {
    const edit = this.page.getByRole('button', { name: '修改需求', exact: true });
    if (await edit.isVisible()) {
      await edit.click();
    }
    await this.page.getByRole('textbox', { name: '输入你的任务', exact: true }).waitFor();
  }

  async showTaskDetails(): Promise<void> {
    await this.page.getByRole('button', { name: '发送任务', exact: true }).click();
  }

  async sendTask(instruction: string): Promise<void> {
    await this.showTaskSetup();
    await this.page.getByRole('textbox', { name: '输入你的任务', exact: true }).fill(instruction);
    await this.showTaskDetails();
  }

  async selectProfile(_profile: 'web' = 'web'): Promise<void> {
    await this.showTaskSetup();
    await this.showTaskDetails();
  }

  async open(_profile: 'web' = 'web'): Promise<void> {
    await this.page.goto(this.origin);
    await this.page.getByText('本地服务已连接', { exact: true }).waitFor();
    await this.selectProfile('web');
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
    await this.showTaskSetup();
    await this.page.getByRole('combobox', { name: '运行方式', exact: true }).selectOption(mode);
    await this.showTaskDetails();
  }

  async setPermission(permission: 'explore' | 'ask' | 'allow-all'): Promise<void> {
    await this.openSettings();
    await this.page.getByLabel('工具权限', { exact: true }).selectOption(permission);
  }

  langfuseLink() {
    return this.page.locator('#langfuse-trace-link');
  }

  async start(): Promise<void> {
    if (await this.page.getByRole('button', { name: '发送任务', exact: true }).isVisible()) await this.showTaskDetails();
    await this.page.getByRole('button', { name: '开始调查', exact: true }).click();
  }

  async completed(): Promise<void> {
    await this.page.getByText('已完成 / 离线演示', { exact: true }).waitFor({ timeout: 20000 });
  }

  async openSavedRun(runId: string): Promise<void> {
    await this.page.getByRole('button', { name: '我的调研', exact: true }).click();
    await this.page.locator(`[data-research-run="${runId}"]`).click();
  }

  async saveReport(): Promise<void> {
    await this.page.getByRole('button', { name: '保存到我的调研', exact: true }).click();
    await this.page.getByRole('button', { name: '已保存到我的调研', exact: true }).waitFor();
  }

  async report(): Promise<void> {
    await this.page.getByRole('tab', { name: '调查报告', exact: true }).click();
    await this.page.locator('#export-run').waitFor({ state: 'visible' });
  }

  reportClaims() {
    return this.page.getByRole('tabpanel', { name: '调查报告', exact: true }).getByRole('article');
  }

  reportCitations() {
    return this.reportClaims().getByRole('link');
  }

  async cancel(): Promise<void> {
    await this.page.getByRole('button', { name: '停止调查', exact: true }).click();
    await this.page.getByText('已取消 / 离线演示', { exact: true }).waitFor();
  }
}
