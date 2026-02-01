#!/usr/bin/env node
/**
 * Remove dist-electron with retries (handles "directory in use" when build triggered quickly).
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(process.cwd(), 'dist-electron');
const maxRetries = 5;
const retryDelayMs = 500;

for (let i = 0; i < maxRetries; i++) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    process.exit(0);
  } catch (err) {
    if (i < maxRetries - 1) {
      const { execSync } = require('child_process');
      execSync(`sleep ${Math.max(0.5, retryDelayMs / 1000)}`);
    } else {
      console.error('Failed to remove dist-electron:', err.message);
      process.exit(1);
    }
  }
}
