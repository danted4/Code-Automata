import { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Global Teardown - Runs after all tests
 *
 * Cleans up ONLY test data created during test runs
 * Preserves user-created tasks
 */
async function globalTeardown(config: FullConfig) {
  console.log('\n🧹 Cleaning up test data after e2e tests...');

  const tasksDir = path.join(process.cwd(), '.code-auto', 'tasks');

  if (fs.existsSync(tasksDir)) {
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

  console.log('✅ Test cleanup complete\n');
}

export default globalTeardown;
