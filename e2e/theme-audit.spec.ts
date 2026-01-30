import { test } from '@playwright/test';

test.describe('Theme System Audit', () => {
  test('identify theme issues across all components', async ({ page }) => {
    await page.goto('http://localhost:3000');

    // Wait for page to load
    await page.waitForSelector('[data-testid="sidebar"]');

    console.log('\n=== THEME AUDIT REPORT ===\n');

    // Test 1: Check main page background
    const mainBg = await page.evaluate(() => {
      return window.getComputedStyle(document.querySelector('main')!).backgroundColor;
    });
    console.log('1. Main page background:', mainBg);

    // Test 2: Check Kanban board styling
    const kanbanBoard = await page.locator('.overflow-x-auto').first();
    const kanbanBg = await kanbanBoard.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });
    console.log('2. Kanban board background:', kanbanBg);

    // Test 3: Check all phase columns
    const columns = await page.locator('[data-testid*="column-"]').all();
    console.log(`\n3. Found ${columns.length} phase columns`);

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const testId = await col.getAttribute('data-testid');
      const bg = await col.evaluate((el) => window.getComputedStyle(el).backgroundColor);
      const borderColor = await col.evaluate((el) => window.getComputedStyle(el).borderColor);
      const color = await col.evaluate((el) => window.getComputedStyle(el).color);

      console.log(`   Column ${testId}:`);
      console.log(`     - Background: ${bg}`);
      console.log(`     - Border: ${borderColor}`);
      console.log(`     - Text: ${color}`);
    }

    // Test 4: Check task cards
    const taskCards = await page.locator('[data-testid*="task-card-"]').all();
    console.log(`\n4. Found ${taskCards.length} task cards`);

    if (taskCards.length > 0) {
      const card = taskCards[0];
      const cardBg = await card.evaluate((el) => window.getComputedStyle(el).backgroundColor);
      const cardBorder = await card.evaluate((el) => window.getComputedStyle(el).borderColor);
      const cardColor = await card.evaluate((el) => window.getComputedStyle(el).color);

      console.log('   First task card:');
      console.log(`     - Background: ${cardBg}`);
      console.log(`     - Border: ${cardBorder}`);
      console.log(`     - Text: ${cardColor}`);
    }

    // Test 5: Open New Task modal
    await page.click('[data-testid="new-task-button"]');
    await page.waitForTimeout(500);

    const modal = await page.locator('[role="dialog"]').first();
    const modalVisible = await modal.isVisible();
    console.log(`\n5. New Task Modal visible: ${modalVisible}`);

    if (modalVisible) {
      const modalBg = await modal.evaluate((el) => window.getComputedStyle(el).backgroundColor);
      const modalColor = await modal.evaluate((el) => window.getComputedStyle(el).color);
      const modalBorder = await modal.evaluate((el) => window.getComputedStyle(el).borderColor);

      console.log('   Modal styling:');
      console.log(`     - Background: ${modalBg}`);
      console.log(`     - Text: ${modalColor}`);
      console.log(`     - Border: ${modalBorder}`);

      // Check inputs
      const titleInput = await page.locator('#title');
      const inputBg = await titleInput.evaluate(
        (el) => window.getComputedStyle(el).backgroundColor
      );
      const inputColor = await titleInput.evaluate((el) => window.getComputedStyle(el).color);
      const inputBorder = await titleInput.evaluate(
        (el) => window.getComputedStyle(el).borderColor
      );

      console.log('   Title input:');
      console.log(`     - Background: ${inputBg}`);
      console.log(`     - Text: ${inputColor}`);
      console.log(`     - Border: ${inputBorder}`);
    }

    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Test 6: Switch to Light theme
    console.log('\n6. Testing Light Theme');
    const themeSwitcherForOptions = await page.locator('text=Modern Dark').first();
    if (await themeSwitcherForOptions.isVisible()) {
      await themeSwitcherForOptions.click();
      await page.waitForTimeout(300);
      const themeOptions = await page.locator('[role="option"]').all();
      console.log(`   Found ${themeOptions.length} theme options`);
    }

    // Test 7: Take screenshots of each theme
    console.log('\n7. Taking screenshots for visual inspection');

    await page.screenshot({
      path: 'e2e/screenshots/theme-dark-default.png',
      fullPage: true,
    });
    console.log('   ✓ Saved: theme-dark-default.png');

    // Try to switch to light theme
    const themeSwitcher = await page.locator('text=Modern Dark').first();
    if (await themeSwitcher.isVisible()) {
      await themeSwitcher.click();
      await page.waitForTimeout(300);

      const lightOption = await page.locator('text=Light Mode').first();
      if (await lightOption.isVisible()) {
        await lightOption.click();
        await page.waitForTimeout(500);

        await page.screenshot({
          path: 'e2e/screenshots/theme-light.png',
          fullPage: true,
        });
        console.log('   ✓ Saved: theme-light.png');
      }

      // Switch to retro
      await themeSwitcher.click();
      await page.waitForTimeout(300);
      const retroOption = await page.locator('text=Retro Terminal').first();
      if (await retroOption.isVisible()) {
        await retroOption.click();
        await page.waitForTimeout(500);

        await page.screenshot({
          path: 'e2e/screenshots/theme-retro.png',
          fullPage: true,
        });
        console.log('   ✓ Saved: theme-retro.png');
      }
    }

    console.log('\n=== END AUDIT ===\n');
    console.log('Check e2e/screenshots/ for visual comparison');
    console.log('Look for hardcoded colors like:');
    console.log('  - bg-slate-* classes');
    console.log('  - text-slate-* classes');
    console.log('  - border-slate-* classes');
    console.log('  - Any other hardcoded Tailwind color classes\n');
  });
});
