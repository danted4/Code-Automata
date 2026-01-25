import { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Global Setup - Runs before all tests
 *
 * Cleans up ONLY test data (marked with isTestData: true) to ensure clean state
 * Preserves user-created tasks
 */
async function globalSetup(config: FullConfig) {
  console.log('\n🧹 Cleaning up test data before e2e tests...');

  const tasksDir = path.join(process.cwd(), '.code-auto', 'tasks');

  // Ensure the directory exists
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
    console.log('✅ Created tasks directory');
  } else {
    // Clear ONLY test task files (those with isTestData: true)
    const files = fs.readdirSync(tasksDir);
    const taskFiles = files.filter(f => f.endsWith('.json'));
    let deletedCount = 0;

    taskFiles.forEach(file => {
      const filePath = path.join(tasksDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const task = JSON.parse(content);

        // Only delete if this is test data
        if (task.metadata?.isTestData === true) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      } catch (error) {
        console.warn(`⚠️  Could not parse ${file}, skipping`);
      }
    });

    console.log(`✅ Cleared ${deletedCount} test task files (preserved ${taskFiles.length - deletedCount} user tasks)`);
  }

  console.log('✅ Test environment ready\n');
}

export default globalSetup;
