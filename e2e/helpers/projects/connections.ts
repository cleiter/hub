import { expect, type Page } from "@playwright/test";

export class ProjectConnections {
  constructor(private readonly page: Page) {}

  async connectGitHub() {
    await this.page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(this.page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
    await expect(
      this.page.getByRole("list", { name: "GitHub connections" }).getByRole("listitem"),
    ).toContainText(/acme-inc.*installation/u);
  }

  /** Returns the secret token, which is readable only in the response to creating the connection. */
  async addGitLab(label: string, baseUrl: string): Promise<string> {
    await this.page.getByRole("button", { name: "Add GitLab" }).click();
    const form = this.page.getByRole("dialog");
    await form.getByLabel("Label").fill(label);
    await form.getByLabel("GitLab instance URL").fill(baseUrl);
    await form.getByRole("button", { name: "Create connection" }).click();
    const status = this.page.getByRole("status");
    await expect(status).toContainText(`${label} is ready to receive GitLab webhooks.`);
    await expect(status).toContainText("/api/integrations/gitlab/webhook/");
    await expect(this.page.getByRole("cell", { name: label, exact: true })).toBeVisible();
    return this.revealedToken();
  }

  async rotateGitLabToken(label: string): Promise<string> {
    await this.page.getByRole("button", { name: `Actions for ${label}` }).click();
    await this.page.getByRole("menuitem", { name: "Issue new token" }).click();
    await this.page.getByRole("button", { name: "Issue new token" }).click();
    await expect(this.page.getByRole("status")).toContainText(`${label} has a new secret token.`);
    return this.revealedToken();
  }

  private async revealedToken(): Promise<string> {
    const values = this.page.getByRole("status").locator("code");
    const token = await values.last().innerText();
    expect(token.length).toBeGreaterThan(0);
    return token;
  }
}
