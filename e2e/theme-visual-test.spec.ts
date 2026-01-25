import { test, expect } from '@playwright/test';

test.describe('Theme Visual Test', () => {
  test('capture all three themes', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForSelector('[data-testid="sidebar"]');

    // Test Dark Theme (default)
    console.log('📸 Capturing Modern Dark theme...');
    await page.screenshot({
      path: 'e2e/screenshots/theme-modern-dark.png',
      fullPage: true
    });

    // Open New Task modal for dark theme
    await page.click('[data-testid="new-task-button"]');
    await page.waitForTimeout(500);
    await page.screenshot({
      path: 'e2e/screenshots/theme-modern-dark-modal.png',
      fullPage: true
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Switch to Light Theme
    console.log('📸 Capturing Light theme...');

    // Find the theme selector in the sidebar
    const themeTrigger = await page.locator('text=Modern Dark').first();
    await themeTrigger.click();
    await page.waitForTimeout(300);

    const lightOption = await page.locator('text=Light Mode').first();
    await lightOption.click();
    await page.waitForTimeout(1000); // Wait for theme to apply

    await page.screenshot({
      path: 'e2e/screenshots/theme-light.png',
      fullPage: true
    });

    // Open New Task modal for light theme
    await page.click('[data-testid="new-task-button"]');
    await page.waitForTimeout(500);
    await page.screenshot({
      path: 'e2e/screenshots/theme-light-modal.png',
      fullPage: true
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Switch to Retro Theme
    console.log('📸 Capturing Retro Terminal theme...');

    const themeTriggerAgain = await page.locator('text=Light Mode').first();
    await themeTriggerAgain.click();
    await page.waitForTimeout(300);

    const retroOption = await page.locator('text=Retro Terminal').first();
    await retroOption.click();
    await page.waitForTimeout(1000); // Wait for theme to apply

    await page.screenshot({
      path: 'e2e/screenshots/theme-retro.png',
      fullPage: true
    });

    // Open New Task modal for retro theme
    await page.click('[data-testid="new-task-button"]');
    await page.waitForTimeout(500);
    await page.screenshot({
      path: 'e2e/screenshots/theme-retro-modal.png',
      fullPage: true
    });

    console.log('✅ All theme screenshots captured successfully!');
    console.log('📁 Check e2e/screenshots/ folder');
  });
});
