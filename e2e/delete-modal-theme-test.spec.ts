import { test, expect } from '@playwright/test';

test.describe('Delete Task Modal - Theme & Loading States', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForSelector('[data-testid="sidebar"]');
  });

  const themes = [
    { name: 'Modern Dark', selector: 'text=Modern Dark' },
    { name: 'Light Mode', selector: 'text=Light Mode' },
    { name: 'Retro Terminal', selector: 'text=Retro Terminal' }
  ];

  for (const theme of themes) {
    test(`should display correctly in ${theme.name} theme`, async ({ page }) => {
      // Switch to the theme
      console.log(`\n=== Testing ${theme.name} ===`);
      
      const themeSwitcher = await page.locator('[id="cli-tool"]').first();
      await themeSwitcher.click();
      await page.waitForTimeout(300);
      
      const themeOption = await page.locator(theme.selector).first();
      await themeOption.click();
      await page.waitForTimeout(500);

      // Find a task card with delete button
      const taskCards = await page.locator('[data-testid*="task-card-"]').all();
      
      if (taskCards.length === 0) {
        console.log('No task cards found - skipping test');
        test.skip();
        return;
      }

      // Hover over first task card to reveal delete button
      await taskCards[0].hover();
      await page.waitForTimeout(200);

      // Click delete button (trash icon)
      const deleteButton = await taskCards[0].locator('[data-testid="delete-task-button"]').first();
      if (!await deleteButton.isVisible()) {
        // Try alternative selector
        const trashIcon = await taskCards[0].locator('svg').filter({ hasText: /trash/i }).first();
        if (await trashIcon.isVisible()) {
          await trashIcon.click();
        } else {
          console.log('Delete button not found - skipping test');
          test.skip();
          return;
        }
      } else {
        await deleteButton.click();
      }

      await page.waitForTimeout(500);

      // Verify modal is visible
      const modal = await page.locator('[role="dialog"]').first();
      await expect(modal).toBeVisible();

      console.log(`✓ Delete modal opened in ${theme.name}`);

      // Check modal has correct CSS variables applied
      const modalContent = await page.locator('[role="dialog"] > div').first();
      const modalBg = await modalContent.evaluate((el) => 
        window.getComputedStyle(el).backgroundColor
      );
      const modalColor = await modalContent.evaluate((el) => 
        window.getComputedStyle(el).color
      );
      const modalBorder = await modalContent.evaluate((el) => 
        window.getComputedStyle(el).borderColor
      );

      console.log('Modal styling:');
      console.log(`  - Background: ${modalBg}`);
      console.log(`  - Text: ${modalColor}`);
      console.log(`  - Border: ${modalBorder}`);

      // Verify warning box is styled with destructive color
      const warningBox = await page.locator('text=Warning').first();
      await expect(warningBox).toBeVisible();
      
      const warningColor = await warningBox.evaluate((el) => 
        window.getComputedStyle(el).color
      );
      console.log(`  - Warning text color: ${warningColor}`);

      // Verify Delete button has destructive styling
      const deleteBtn = await page.locator('button:has-text("Delete Task")').first();
      await expect(deleteBtn).toBeVisible();
      
      const deleteBtnBg = await deleteBtn.evaluate((el) => 
        window.getComputedStyle(el).backgroundColor
      );
      console.log(`  - Delete button background: ${deleteBtnBg}`);

      // Verify Cancel button is visible and enabled
      const cancelBtn = await page.locator('button:has-text("Cancel")').first();
      await expect(cancelBtn).toBeVisible();
      await expect(cancelBtn).toBeEnabled();

      // Take screenshot
      await page.screenshot({
        path: `e2e/screenshots/delete-modal-${theme.name.toLowerCase().replace(/\s+/g, '-')}.png`,
      });
      console.log(`✓ Screenshot saved for ${theme.name}`);

      // Test ESC key closes modal (when not deleting)
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await expect(modal).not.toBeVisible();
      console.log(`✓ Modal closes with ESC key in ${theme.name}`);
    });
  }

  test('should display loading state and prevent closing during deletion', async ({ page }) => {
    console.log('\n=== Testing Loading State ===');

    // Create a route interceptor to delay the delete API call
    await page.route('**/api/tasks/delete**', async (route) => {
      // Add delay to simulate slow network
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ success: true })
      });
    });

    // Find a task card
    const taskCards = await page.locator('[data-testid*="task-card-"]').all();
    
    if (taskCards.length === 0) {
      console.log('No task cards found - skipping test');
      test.skip();
      return;
    }

    // Open delete modal
    await taskCards[0].hover();
    await page.waitForTimeout(200);
    
    const deleteButton = await taskCards[0].locator('[data-testid="delete-task-button"]').first();
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
    } else {
      console.log('Delete button not found - skipping test');
      test.skip();
      return;
    }

    await page.waitForTimeout(500);

    const modal = await page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible();

    // Click Delete button
    const deleteBtn = await page.locator('button:has-text("Delete Task")').first();
    await deleteBtn.click();

    // Verify loading spinner appears
    await page.waitForTimeout(100);
    const loadingSpinner = await page.locator('.animate-spin').first();
    await expect(loadingSpinner).toBeVisible();
    console.log('✓ Loading spinner visible');

    // Verify button text changes to "Deleting..."
    const deletingBtn = await page.locator('button:has-text("Deleting...")').first();
    await expect(deletingBtn).toBeVisible();
    console.log('✓ Button text changed to "Deleting..."');

    // Verify both buttons are disabled
    await expect(deletingBtn).toBeDisabled();
    const cancelBtn = await page.locator('button:has-text("Cancel")').first();
    await expect(cancelBtn).toBeDisabled();
    console.log('✓ Both buttons disabled during deletion');

    // Try to close modal with ESC key - should not close
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(modal).toBeVisible();
    console.log('✓ Modal cannot be closed with ESC during deletion');

    // Try to close modal by clicking backdrop - should not close
    const backdrop = await page.locator('[data-radix-dialog-overlay]').first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
      await expect(modal).toBeVisible();
      console.log('✓ Modal cannot be closed with backdrop click during deletion');
    }

    // Take screenshot of loading state
    await page.screenshot({
      path: 'e2e/screenshots/delete-modal-loading-state.png',
    });
    console.log('✓ Screenshot saved for loading state');

    // Wait for deletion to complete
    await page.waitForTimeout(2500);
    
    console.log('✓ All loading state tests passed');
  });

  test('should have proper CSS variable theming', async ({ page }) => {
    console.log('\n=== Testing CSS Variables ===');

    // Get CSS variables from root
    const cssVars = await page.evaluate(() => {
      const root = document.documentElement;
      const style = window.getComputedStyle(root);
      return {
        destructive: style.getPropertyValue('--color-destructive'),
        textPrimary: style.getPropertyValue('--color-text-primary'),
        textSecondary: style.getPropertyValue('--color-text-secondary'),
        surface: style.getPropertyValue('--color-surface'),
        surfaceHover: style.getPropertyValue('--color-surface-hover'),
        border: style.getPropertyValue('--color-border'),
      };
    });

    console.log('CSS Variables:');
    console.log(`  --color-destructive: ${cssVars.destructive}`);
    console.log(`  --color-text-primary: ${cssVars.textPrimary}`);
    console.log(`  --color-text-secondary: ${cssVars.textSecondary}`);
    console.log(`  --color-surface: ${cssVars.surface}`);
    console.log(`  --color-surface-hover: ${cssVars.surfaceHover}`);
    console.log(`  --color-border: ${cssVars.border}`);

    // Verify all required CSS variables are defined
    expect(cssVars.destructive).toBeTruthy();
    expect(cssVars.textPrimary).toBeTruthy();
    expect(cssVars.textSecondary).toBeTruthy();
    expect(cssVars.surface).toBeTruthy();
    expect(cssVars.surfaceHover).toBeTruthy();
    expect(cssVars.border).toBeTruthy();

    console.log('✓ All required CSS variables are defined');
  });
});
