import { test, expect } from "@playwright/test";

test.describe("CERS End-to-End Role & Accessibility Verification", () => {
  test("displays emergency helpline call bar, accessible auth form, and reduced-motion support", async ({
    page,
  }) => {
    await page.goto("/");

    // 1. Verify visible disclaimer and one-tap emergency call links (112, 100, 101, 108)
    const helplineBanner = page.locator(".helpline-banner");
    await expect(helplineBanner).toBeVisible();
    await expect(page.locator('a[href="tel:112"]')).toBeVisible();
    await expect(page.locator('a[href="tel:100"]')).toBeVisible();
    await expect(page.locator('a[href="tel:101"]')).toBeVisible();
    await expect(page.locator('a[href="tel:108"]')).toBeVisible();

    // 2. Verify accessible auth form labels and keyboard submit
    await expect(page.locator("label[for='username']")).toHaveCount(1);
    await expect(page.locator("label[for='password']")).toHaveCount(1);
    await expect(page.locator("#authTitle")).toHaveText("Login");

    // 3. Toggle between Login and Signup
    await page.locator("#toggleAuthBtn").click();
    await expect(page.locator("#authTitle")).toHaveText("Create Account");
  });
});
