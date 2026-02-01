import { test, expect } from '@playwright/test';

/**
 * E2E smoke test: Worktrees page
 *
 * Verifies that:
 * 1. Navigating to /worktrees loads the real worktrees UI (not "Coming Soon").
 * 2. Either the empty state (no worktrees) or the worktrees list/cards is visible.
 */

test.describe('Worktrees page smoke', () => {
  test('worktrees page shows real UI: no Coming Soon, empty state or list visible', async ({
    page,
  }) => {
    await page.goto('/worktrees');

    // Wait for loading to finish: one of empty state, list, or error state must appear
    const emptyState = page.getByTestId('worktrees-empty-state');
    const list = page.getByTestId('worktrees-list');
    const errorState = page.getByTestId('worktrees-error-state');
    await expect(emptyState.or(list).or(errorState)).toBeVisible({ timeout: 15000 });

    // "Coming Soon" must not be displayed anywhere on the page
    await expect(page.getByRole('heading', { name: 'Coming Soon' })).not.toBeVisible();
    await expect(page.getByText('Coming Soon')).not.toBeVisible();

    // Either (a) empty state is visible or (b) worktrees list/cards are visible
    const emptyVisible = await emptyState.isVisible();
    const listVisible = await list.isVisible();
    const hasCards = (await page.getByTestId(/^worktree-card-/).count()) > 0;

    expect(
      emptyVisible || listVisible || hasCards,
      'Expected empty state (No worktrees), worktrees list, or at least one worktree card to be visible'
    ).toBe(true);
  });
});
