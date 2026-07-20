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
  await expect(page.getByRole("button", { name: "Edit layout" })).toBeHidden();
  await expectAccessible(page, "dashboard");

  await page.evaluate(async () => {
    const layout = [
      { id: "stats", cols: 4, rows: 1 },
      { id: "calendar", cols: 2, rows: 2, options: { view: "month" } },
      { id: "nowplaying", cols: 2, rows: 1 },
      { id: "downloads", cols: 2, rows: 1 },
    ];
    const response = await fetch("/api/auth/prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout: JSON.stringify(layout) }),
    });
    if (!response.ok) throw new Error(`layout setup failed: ${response.status}`);
  });
  await page.reload();
  await page.addStyleTag({ content: ".widget { animation: none !important; }" });
  await expect(page.locator('[data-widget-id="stats"]')).toBeVisible();
  await expect(page.locator('[data-widget-id="calendar"]')).toBeVisible();
  await expect(page.locator('[data-widget-id="nowplaying"]')).toBeVisible();
  await expect(page.locator('[data-widget-id="downloads"]')).toBeVisible();
  const packed = await page.evaluate(() => {
    const slotFor = (id: string) =>
      document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!;
    const box = (id: string) => slotFor(id).getBoundingClientRect();
    const card = (id: string) =>
      slotFor(id)
        .querySelector<HTMLElement>(":scope > .widget-frame > .widget")!
        .getBoundingClientRect();
    const statsCard = card("stats");
    const statsSlot = box("stats");
    const tall = box("calendar");
    const upper = box("nowplaying");
    const lower = box("downloads");
    return {
      sameRightColumn: Math.abs(upper.x - lower.x),
      rightOfTall: upper.x > tall.x,
      stacked: lower.y > upper.y,
      alignedBottoms: Math.abs(tall.bottom - lower.bottom),
      appliedCardsStayInSlots: ["stats", "calendar", "nowplaying", "downloads"].every((id) => {
        const slot = box(id);
        const widget = card(id);
        return widget.top >= slot.top && widget.bottom <= slot.bottom + 1;
      }),
      visibleRowGap: tall.top - statsCard.bottom,
      calendarWallHeight:
        slotFor("calendar").querySelector<HTMLElement>(".cal-wall")?.getBoundingClientRect()
          .height ?? 0,
      compactStats: statsSlot.height < upper.height * 0.55,
      statsContentFits:
        slotFor("stats").querySelector<HTMLElement>(".stats-strip")!.scrollHeight <=
        slotFor("stats").querySelector<HTMLElement>(".stats-strip")!.clientHeight,
      titlePlaqueOverhangs: (() => {
        const tag = slotFor("calendar").querySelector<HTMLElement>(".panel-tag")!;
        const tagBox = tag.getBoundingClientRect();
        const cardBox = card("calendar");
        return (
          getComputedStyle(tag.closest<HTMLElement>(".widget")!).overflow === "visible" &&
          tagBox.top < cardBox.top &&
          tagBox.bottom > cardBox.top
        );
      })(),
    };
  });
  expect(packed.rightOfTall).toBe(true);
  expect(packed.stacked).toBe(true);
  expect(packed.sameRightColumn).toBeLessThanOrEqual(1);
  expect(packed.alignedBottoms).toBeLessThanOrEqual(1);
  expect(packed.appliedCardsStayInSlots).toBe(true);
  expect(packed.visibleRowGap).toBeGreaterThanOrEqual(18);
  expect(packed.visibleRowGap).toBeLessThanOrEqual(22);
  expect(packed.calendarWallHeight).toBeGreaterThan(250);
  expect(packed.compactStats).toBe(true);
  expect(packed.statsContentFits).toBe(true);
  expect(packed.titlePlaqueOverhangs).toBe(true);

  const constrainedLongList = await page.evaluate(() => {
    const slot = document.querySelector<HTMLElement>('[data-widget-id="downloads"]')!;
    const body = slot.querySelector<HTMLElement>(".widget-body")!;
    for (let i = 0; i < 30; i += 1) {
      const row = document.createElement("div");
      row.style.height = "32px";
      row.style.flexShrink = "0";
      row.textContent = `Overflow regression row ${i + 1}`;
      body.append(row);
    }
    const slotBox = slot.getBoundingClientRect();
    const cardBox = slot.querySelector<HTMLElement>(".widget")!.getBoundingClientRect();
    return {
      scrollable: body.scrollHeight > body.clientHeight,
      cardContained: cardBox.bottom <= slotBox.bottom + 1,
    };
  });
  expect(constrainedLongList.scrollable).toBe(true);
  expect(constrainedLongList.cardContained).toBe(true);

  await page.locator('button[title="captain"]').click();
  await page.getByRole("menuitem", { name: "Edit dashboard layout" }).click();
  await expect(page.getByRole("button", { name: "Save my layout" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Resize / }).first()).toBeVisible();
  const calendarSlot = page.locator('[data-widget-id="calendar"]');
  const resizeHandle = calendarSlot.getByRole("button", { name: "Resize Release calendar" });
  await resizeHandle.scrollIntoViewIfNeeded();
  const beforeResize = await calendarSlot.boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  expect(beforeResize).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2 + 260,
    handleBox!.y + handleBox!.height / 2 + 230
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const after = await calendarSlot.boundingBox();
      return Boolean(
        after &&
        beforeResize &&
        after.width > beforeResize.width &&
        after.height > beforeResize.height
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Follow default" }).click();

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(page.getByLabel("Search commands")).toBeFocused();
  await expectAccessible(page, "command palette");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.locator('button[title="captain"]').click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const account = page.getByRole("dialog", { name: /Settings · captain/ });
  await expect(account).toBeVisible();
  await expect(page.getByLabel("Close account settings")).toBeFocused();
  await expectAccessible(page, "account dialog");
  await page.keyboard.press("Escape");
  await expect(account).toBeHidden();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Harbormaster" })).toBeVisible();
  await expect(page.getByText(/Harbor 0\.1\.0-e2e · schema 4/)).toBeVisible();
  await expectAccessible(page, "administrator settings");

  await page.locator('button[title="captain"]').click();
  await page.getByRole("menuitem", { name: "Edit dashboard layout" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("button", { name: "Save my layout" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.goto("/settings");

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
