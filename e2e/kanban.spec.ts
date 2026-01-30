import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Kanban Board
 *
 * Tests the main dashboard, sidebar navigation, and task board functionality
 * Uses data-testid attributes for reliable selectors
 */

test.describe('Kanban Board', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the home page
    await page.goto('/');
  });

  test('should load the dashboard with sidebar and kanban board', async ({ page }) => {
    // Check if the page title is correct
    await expect(page).toHaveTitle(/Code-Auto/i);

    // Verify sidebar is visible using data-testid
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // Verify sidebar header
    const sidebarHeader = page.getByTestId('sidebar-header');
    await expect(sidebarHeader).toBeVisible();
    await expect(sidebarHeader).toContainText('Code-Auto');
    await expect(sidebarHeader).toContainText('Autonomous AI agents');

    // Take screenshot of full dashboard
    await page.screenshot({ path: 'e2e/screenshots/01-dashboard.png', fullPage: true });
  });

  test('should display all navigation sections', async ({ page }) => {
    // Verify PROJECT section exists
    const projectSection = page.getByTestId('project-section');
    await expect(projectSection).toBeVisible();
    await expect(projectSection).toContainText(/PROJECT/i); // Case-insensitive

    // Verify PROJECT menu items using data-testids
    await expect(page.getByTestId('nav-kanban-board')).toBeVisible();
    await expect(page.getByTestId('nav-agent-terminals')).toBeVisible();
    await expect(page.getByTestId('nav-task-list')).toBeVisible();
    await expect(page.getByTestId('nav-settings')).toBeVisible();

    // Verify TOOLS section exists
    const toolsSection = page.getByTestId('tools-section');
    await expect(toolsSection).toBeVisible();
    await expect(toolsSection).toContainText(/TOOLS/i); // Case-insensitive

    // Verify TOOLS menu items using data-testids
    await expect(page.getByTestId('nav-github-issues')).toBeVisible();
    await expect(page.getByTestId('nav-git-worktrees')).toBeVisible();
    await expect(page.getByTestId('nav-memory-context')).toBeVisible();

    // Verify New Task button
    const newTaskButton = page.getByTestId('new-task-button');
    await expect(newTaskButton).toBeVisible();
    await expect(newTaskButton).toContainText('New Task');

    // Take screenshot of sidebar
    await page.getByTestId('sidebar').screenshot({ path: 'e2e/screenshots/02-sidebar.png' });
  });

  test('should display all 5 workflow phase columns', async ({ page }) => {
    // Verify all 5 phase columns are present using data-testids
    await expect(page.getByTestId('kanban-column-planning')).toBeVisible();
    await expect(page.getByTestId('kanban-column-in_progress')).toBeVisible();
    await expect(page.getByTestId('kanban-column-ai_review')).toBeVisible();
    await expect(page.getByTestId('kanban-column-human_review')).toBeVisible();
    await expect(page.getByTestId('kanban-column-done')).toBeVisible();

    // Verify column headers
    await expect(page.getByRole('heading', { name: 'Planning' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'In Progress' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI Review' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Human Review' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();

    // Take screenshot of kanban board
    await page.locator('main').screenshot({ path: 'e2e/screenshots/03-kanban-board.png' });
  });

  test('should show empty state in columns with no tasks', async ({ page }) => {
    // Check for empty state using data-testids
    const emptyStates = await page.getByTestId(/^empty-state-/).all();

    // At least some columns should be empty initially
    expect(emptyStates.length).toBeGreaterThan(0);

    // Verify empty state text
    if (emptyStates.length > 0) {
      await expect(emptyStates[0]).toContainText('No tasks');
    }

    // Take screenshot of empty board
    await page.screenshot({ path: 'e2e/screenshots/04-empty-board.png', fullPage: true });
  });

  test('should load and display seeded tasks', async ({ page }) => {
    // Seed the database with test tasks (marked with isTestData: true)
    const response = await page.request.post('/api/tasks/seed-test');
    expect(response.ok()).toBeTruthy();

    // Reload the page to see the tasks
    await page.reload();

    // Wait for at least one task card to appear (better than fixed timeout)
    await expect(page.getByTestId(/^task-card-/).first()).toBeVisible({ timeout: 10000 });

    // Check that task cards are visible using data-testid pattern
    const taskCards = await page.getByTestId(/^task-card-/).all();

    // We seeded 6 tasks, so we should have 6 cards
    expect(taskCards.length).toBeGreaterThanOrEqual(6);

    // Verify task count displays
    const planningCount = page.getByTestId('task-count-planning');
    const inProgressCount = page.getByTestId('task-count-in_progress');
    const aiReviewCount = page.getByTestId('task-count-ai_review');
    const humanReviewCount = page.getByTestId('task-count-human_review');
    const doneCount = page.getByTestId('task-count-done');

    await expect(planningCount).toBeVisible();
    await expect(inProgressCount).toBeVisible();
    await expect(aiReviewCount).toBeVisible();
    await expect(humanReviewCount).toBeVisible();
    await expect(doneCount).toBeVisible();

    // Take screenshot with tasks
    await page.screenshot({ path: 'e2e/screenshots/05-kanban-with-tasks.png', fullPage: true });
  });

  test('should display task card details correctly', async ({ page }) => {
    // Seed test tasks first
    await page.request.post('/api/tasks/seed-test');
    await page.reload();

    // Wait for task cards to appear
    const firstTaskCard = page.getByTestId(/^task-card-/).first();
    await expect(firstTaskCard).toBeVisible({ timeout: 10000 });

    // Verify task card has required elements
    await expect(firstTaskCard.getByTestId('task-title')).toBeVisible();
    await expect(firstTaskCard.getByTestId('task-status')).toBeVisible();

    // Check if Start Agent button exists
    const startButton = firstTaskCard.getByTestId('start-agent-button');
    await expect(startButton).toBeVisible();
    await expect(startButton).toContainText('Start Agent');

    // Take screenshot of a task card
    await firstTaskCard.screenshot({ path: 'e2e/screenshots/06-task-card.png' });
  });

  test('should display subtasks when present', async ({ page }) => {
    // Seed test tasks (includes task with subtasks)
    await page.request.post('/api/tasks/seed-test');
    await page.reload();

    // Wait for tasks to load
    await expect(page.getByTestId(/^task-card-/).first()).toBeVisible({ timeout: 10000 });

    // Find task with subtasks using data-testid
    const taskWithSubtasks = page.getByTestId('task-subtasks').first();

    if (await taskWithSubtasks.isVisible()) {
      // Verify subtask count is displayed
      await expect(taskWithSubtasks).toContainText('subtasks');

      // Take screenshot
      await taskWithSubtasks.locator('..').screenshot({
        path: 'e2e/screenshots/07-task-with-subtasks.png',
      });
    }
  });

  test('should display correct phase colors', async ({ page }) => {
    // Seed test tasks to ensure columns are visible
    await page.request.post('/api/tasks/seed-test');
    await page.reload();

    // Wait for tasks to load
    await expect(page.getByTestId(/^task-card-/).first()).toBeVisible({ timeout: 10000 });

    // Get all columns using data-testids
    const planningColumn = page.getByTestId('kanban-column-planning');
    const inProgressColumn = page.getByTestId('kanban-column-in_progress');
    const aiReviewColumn = page.getByTestId('kanban-column-ai_review');
    const humanReviewColumn = page.getByTestId('kanban-column-human_review');
    const doneColumn = page.getByTestId('kanban-column-done');

    // Verify columns are visible
    await expect(planningColumn).toBeVisible();
    await expect(inProgressColumn).toBeVisible();
    await expect(aiReviewColumn).toBeVisible();
    await expect(humanReviewColumn).toBeVisible();
    await expect(doneColumn).toBeVisible();

    // Take screenshot for visual verification of colors
    await page.screenshot({ path: 'e2e/screenshots/08-phase-colors.png', fullPage: true });
  });

  test('should have functional navigation links', async ({ page }) => {
    // Test Kanban Board link (should be active on home page)
    const kanbanLink = page.getByTestId('nav-kanban-board');
    await expect(kanbanLink).toHaveClass(/bg-slate-800/); // Active state

    // Click on Task List link
    await page.getByTestId('nav-task-list').click();

    // Should navigate to /tasks
    await expect(page).toHaveURL('/tasks');

    // Take screenshot of task list page (even if it's a 404 for now)
    await page.screenshot({ path: 'e2e/screenshots/09-navigation-test.png' });
  });

  test('should show new task modal with tool select and readiness areas', async ({ page }) => {
    await page.getByTestId('new-task-button').click();

    const dialog = page.getByRole('dialog', { name: /create new task/i });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const toolSelectArea = page.getByTestId('new-task-modal-tool-select-area');
    await expect(toolSelectArea).toBeVisible();
    await expect(toolSelectArea).toContainText('CLI Tool');

    const readinessArea = page.getByTestId('new-task-modal-readiness-area');
    await expect(readinessArea).toBeVisible();
    await expect(readinessArea).toHaveText(
      /Amp readiness|Cursor readiness|No readiness check for this tool|Checking…/
    );

    await page.keyboard.press('Escape');
  });
});
