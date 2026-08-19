import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const owner = {
  name: "Alice",
  email: "alice-gitlab@example.com",
  password: "alice-gitlab-password",
};

test("issues a GitLab webhook credential the endpoint actually accepts", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openOrganizationSection("Connections");

  const token = await app.connections.addGitLab("Acme GitLab", "https://gitlab.example.com");
  const webhookUrl = await page.getByRole("status").locator("code").first().innerText();

  expect(
    await hub.deliverGitLabMergeRequest({ webhookUrl, token, deliveryId: "gl-accepted" }),
  ).toBe(200);
  // No project routes GitLab events yet, so the delivery is recorded and dropped for a stated
  // reason rather than being refused — which is how an operator finds a misconfigured hook.
  expect(await hub.gitlabDeliveryReasons("gl-accepted")).toEqual(["no_project_route"]);

  expect(
    await hub.deliverGitLabMergeRequest({
      webhookUrl,
      token: "not-the-token",
      deliveryId: "gl-refused",
    }),
  ).toBe(401);
  expect(await hub.gitlabDeliveryReasons("gl-refused")).toEqual([]);
});

test("rotating a GitLab token retires the previous one", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", { ...owner, email: "alice-gitlab-rotate@example.com" });
  await hub.createOrganization("owner", "Acme");
  await app.navigation.openOrganizationSection("Connections");

  const original = await app.connections.addGitLab("Acme GitLab", "https://gitlab.example.com");
  const webhookUrl = await page.getByRole("status").locator("code").first().innerText();
  const rotated = await app.connections.rotateGitLabToken("Acme GitLab");

  expect(rotated).not.toBe(original);
  expect(
    await hub.deliverGitLabMergeRequest({
      webhookUrl,
      token: original,
      deliveryId: "gl-rotated-old",
    }),
  ).toBe(401);
  expect(
    await hub.deliverGitLabMergeRequest({
      webhookUrl,
      token: rotated,
      deliveryId: "gl-rotated-new",
    }),
  ).toBe(200);
});
