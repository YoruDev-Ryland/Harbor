import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SETUP_TOKEN = "example-playwright-setup-token-at-least-32-characters";
const PASSWORD = "example-playwright-password";

async function expectAccessible(page: Page, context: string): Promise<void> {
  // Scan stable end-state colors instead of the intentional fade-in frame,
  // whose temporary opacity changes axe's computed contrast.
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations,
    `${context}: ${result.violations
      .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.length}`)
      .join(", ")}`
  ).toEqual([]);
}

test("setup, keyboard dialogs, responsive settings, sign-out, and local login", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("First light. Create the harbormaster account.")).toBeVisible();
  await expectAccessible(page, "setup");

  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Username").fill("captain");
  await page.getByLabel("Email (optional)").fill("captain@example.test");
  await page.getByLabel("Password (12+ characters)").fill(PASSWORD);
  await page.getByRole("button", { name: "Take the helm" }).click();
  await expect(page.getByRole("button", { name: "Edit layout" })).toBeVisible();
  await expectAccessible(page, "dashboard");

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(page.getByLabel("Search commands")).toBeFocused();
  await expectAccessible(page, "command palette");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const account = page.getByRole("dialog", { name: /Account · captain/ });
  await expect(account).toBeVisible();
  await expect(page.getByLabel("Close account settings")).toBeFocused();
  await expectAccessible(page, "account dialog");
  await page.keyboard.press("Escape");
  await expect(account).toBeHidden();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Harbormaster" })).toBeVisible();
  await expect(page.getByText(/Harbor 0\.1\.0-e2e · schema 3/)).toBeVisible();
  await expectAccessible(page, "administrator settings");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Harbormaster" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.locator('button[title="captain"]').click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectAccessible(page, "login");

  await page.getByLabel("Username").fill("captain");
  await page.getByLabel("Password").fill("example-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("invalid credentials");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Harbormaster" })).toBeVisible();
});
