# Manual Testing Guide: Task Deletion Feature

This guide provides step-by-step instructions for manually testing the task deletion feature.

---

## Prerequisites

1. **Start the development server:**
   ```bash
   npm install  # If dependencies not installed
   npm run dev
   ```

2. **Open the application:**
   - Navigate to `http://localhost:3000`
   - Wait for the Kanban board to load

3. **Have terminal ready for filesystem verification:**
   ```bash
   # In a separate terminal window
   cd /path/to/project
   ```

---

## Test 1: Delete Task with No Agent Running

### Setup
1. Click "New Task" button
2. Fill in:
   - Title: "Test Task - No Agent"
   - Description: "Testing deletion without agent"
   - Requires Human Review: Check the box
3. Click "Create Task"
4. Task should appear in "Planning" phase

### Test Execution
1. **Locate the task card** in the Planning column
2. **Hover over the card** - delete icon should appear at top-left
3. **Click the trash icon** 🗑️
4. **Verify modal appearance:**
   - [ ] Modal title says "Delete Task"
   - [ ] Alert triangle icon visible
   - [ ] Task title shown correctly
   - [ ] Task description displayed
   - [ ] Warning box present with red styling
   - [ ] "Cancel" and "Delete Task" buttons visible
5. **Click "Delete Task"**
6. **Observe loading state:**
   - [ ] Button text changes to "Deleting..."
   - [ ] Spinner icon appears and rotates
   - [ ] Both buttons become disabled
   - [ ] Try pressing ESC - modal should NOT close
7. **After deletion completes:**
   - [ ] Success toast appears: "Task deleted successfully"
   - [ ] Modal closes automatically
   - [ ] Task disappears from Kanban board
   - [ ] No errors in browser console (F12)

### Verification
```bash
# Check task file is deleted
ls .code-auto/tasks/ | grep "Test Task - No Agent"
# Should return nothing

# Check implementation plan updated
cat .code-auto/implementation_plan.json
# Should not list the deleted task
```

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 2: Delete Task with Agent in `in_progress` Phase

### Setup
1. Create a new task:
   - Title: "Test Task - Agent Running"
   - Description: "Testing deletion with active agent"
   - Requires Human Review: Uncheck (for auto-start)
2. Click "Start Planning" or similar to begin planning
3. Wait for planning to complete (or skip to development)
4. Start the development agent (task moves to "In Progress" phase)
5. Verify "🤖 Agent working" status appears

### Test Execution
1. **While agent is running**, click the delete icon
2. **Verify modal warnings:**
   - [ ] Warning mentions agent will be stopped
   - [ ] All four bullet points visible:
     - Permanently delete all task data and subtasks
     - Remove the associated git worktree if it exists
     - Delete any uncommitted changes in the worktree
     - Remove the task from all phases in the workflow
3. **Click "Delete Task"**
4. **Watch for:**
   - [ ] Loading state activates immediately
   - [ ] Task card shows agent stopping
5. **After completion:**
   - [ ] Success toast appears
   - [ ] Task removed from board
   - [ ] Agent no longer listed in any task

### Verification
```bash
# Check worktree was removed
git worktree list
# Should not show worktree for this task

# Check directory deleted
ls .code-auto/worktrees/
# Should not contain task directory

# Check task file deleted
ls .code-auto/tasks/
# Should not contain task JSON
```

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 3: Delete Task in `ai_review` Phase with Agent Running

### Setup
1. Create a task that will reach AI review phase
2. Complete all dev subtasks (or use test data)
3. Task moves to "AI Review" phase
4. Start the QA review agent
5. Verify "🤖 QA review in progress" status

### Test Execution
1. Click delete icon on the task
2. **Verify modal shows:**
   - [ ] Task with completed dev subtasks
   - [ ] QA subtasks in progress
   - [ ] Warning about agent termination
3. **Confirm deletion**
4. **Verify:**
   - [ ] QA agent stops
   - [ ] Loading state during deletion
   - [ ] Task and all subtasks removed
   - [ ] Worktree cleaned up

### Verification
```bash
# Check no QA processes running
ps aux | grep "qa" | grep -v grep

# Verify worktree removed
git worktree list
ls .code-auto/worktrees/

# Verify task deleted
ls .code-auto/tasks/
```

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 4: Delete Task Without Worktree

### Setup
1. Create a new task
2. Keep it in "Planning" phase
3. **Do NOT start development** - no worktree created yet
4. Verify in terminal:
   ```bash
   git worktree list
   # Should not show worktree for this task
   ```

### Test Execution
1. Click delete icon
2. **Verify modal shows:**
   - [ ] No branch name displayed (since no worktree)
   - [ ] Warning still mentions worktree (generic warning)
3. **Click "Delete Task"**
4. **Verify:**
   - [ ] Deletion completes successfully
   - [ ] No errors about missing worktree
   - [ ] Clean success message (no warnings about worktree)

### Verification
```bash
# Verify task deleted
ls .code-auto/tasks/
# Should not contain task JSON

# Check console logs
# Should show: "Worktree does not exist: ..." (not an error)
```

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 5: Cancel Button Closes Modal Without Action

### Setup
1. Use any existing task
2. Note the task's current state

### Test Execution
1. Click delete icon to open modal
2. **Verify modal is visible**
3. **Click "Cancel" button**
4. **Verify:**
   - [ ] Modal closes immediately
   - [ ] Task remains on board unchanged
   - [ ] No toast notifications appear
   - [ ] No API calls made (check Network tab in DevTools)

### Alternative Test - ESC Key
1. Open delete modal again
2. Press ESC key
3. **Verify:**
   - [ ] Modal closes
   - [ ] Task unchanged

### Alternative Test - Backdrop Click
1. Open delete modal again
2. Click outside the modal (on the dark backdrop)
3. **Verify:**
   - [ ] Modal closes
   - [ ] Task unchanged

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 6: Rapid Clicking / Race Condition Protection

### Setup
1. Use any existing task with worktree
2. Open browser DevTools (F12)
3. Go to Network tab
4. Filter for "delete" requests

### Test Execution
1. Click delete icon
2. Modal opens
3. **Rapidly click "Delete Task" button 5-10 times very quickly**
4. **Observe:**
   - [ ] Button becomes disabled after first click
   - [ ] Loading spinner appears immediately
   - [ ] Additional clicks have no effect
   - [ ] Only ONE network request shows in DevTools
   - [ ] No error messages in console
   - [ ] No UI flickering or glitches

### Verification
```bash
# Check only one task was deleted (not multiple)
ls .code-auto/tasks/
# Should show remaining tasks, but test task only deleted once

# Check browser console - no errors
# Check Network tab - only one DELETE request
```

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 7: Worktree Directory Verification

### Setup
1. Create a task that will get a worktree
2. Start development to create the worktree
3. **Before deletion**, verify worktree exists:
   ```bash
   # Note the exact path
   git worktree list
   
   # List directory contents
   ls -la .code-auto/worktrees/
   
   # Note the task ID from the directory name
   ```

### Test Execution
1. **Before deletion - document state:**
   ```bash
   # Take note of exact directory path
   TASK_ID="<task-id-from-worktree>"
   echo "Worktree path: .code-auto/worktrees/$TASK_ID"
   
   # Verify it exists
   ls -la .code-auto/worktrees/$TASK_ID
   
   # Check git knows about it
   git worktree list | grep $TASK_ID
   ```

2. **Perform deletion via UI**

3. **After deletion - verify cleanup:**
   ```bash
   # Check directory is gone
   ls -la .code-auto/worktrees/$TASK_ID
   # Should return: "No such file or directory"
   
   # Verify git worktree list updated
   git worktree list
   # Should not show the deleted worktree
   
   # Check for orphaned files
   find .code-auto/worktrees/ -name "*$TASK_ID*"
   # Should return nothing
   
   # Check git branch deleted (optional)
   git branch -a | grep "code-auto/$TASK_ID"
   # May or may not be present - branch deletion is optional
   ```

### Verification Checklist
- [ ] Worktree directory completely removed
- [ ] Git worktree list updated
- [ ] No orphaned files remain
- [ ] Parent directory (.code-auto/worktrees/) still exists
- [ ] Other worktrees (if any) unaffected

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 8: Task Disappears from Kanban Board

### Setup
1. Create a task in any phase
2. Take screenshot or note its position
3. Count total tasks on board

### Test Execution
1. **Before deletion:**
   ```bash
   # Count task files
   ls .code-auto/tasks/*.json | wc -l
   ```
   Total tasks: _______

2. **Delete the task via UI**

3. **Immediately after deletion:**
   - [ ] Task card disappears from board
   - [ ] Other tasks shift to fill space
   - [ ] Board layout remains intact
   - [ ] No empty spaces or broken cards

4. **Refresh the page (F5)**
   - [ ] Task does not reappear
   - [ ] Board state is consistent

5. **Check persistence:**
   ```bash
   # Count task files again
   ls .code-auto/tasks/*.json | wc -l
   ```
   Total tasks: _______ (should be 1 less)

   ```bash
   # Verify task JSON deleted
   ls .code-auto/tasks/ | grep "<task-id>"
   # Should return nothing
   
   # Check implementation plan updated
   cat .code-auto/implementation_plan.json | grep "<task-id>"
   # Should return nothing
   ```

### Verification Checklist
- [ ] Task immediately removed from UI
- [ ] Task doesn't reappear on refresh
- [ ] Task JSON file deleted
- [ ] Implementation plan updated
- [ ] Task count decreased by 1
- [ ] Other tasks unaffected

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 9: Theme Testing - Modern Dark

### Setup
1. Click theme switcher in sidebar (monitor/CLI icon)
2. Select "Modern Dark"
3. Wait for theme to apply

### Test Execution
1. Open delete modal on any task
2. **Verify colors and styling:**
   - [ ] Modal background: Dark slate (`#1e293b`)
   - [ ] Text: White and readable
   - [ ] Delete icon: Red (`#ef4444`)
   - [ ] Warning box: Red border/accent
   - [ ] Delete button: Red background, white text
   - [ ] Cancel button: Gray with proper contrast
   - [ ] All text clearly readable
   - [ ] No visual glitches or artifacts

3. **Take screenshot for documentation:**
   - Use browser screenshot tool or Cmd+Shift+4 (Mac)
   - Save as: `test-screenshots/delete-modal-dark.png`

4. **Hover interactions:**
   - [ ] Delete button hover state works
   - [ ] Cancel button hover state works

5. **Test delete icon visibility on task card:**
   - [ ] Hover over task card
   - [ ] Delete icon appears in top-left
   - [ ] Icon is red and clearly visible
   - [ ] Icon doesn't blend into background

**Result:** ✅ PASS / ❌ FAIL  
**Visual Issues:**

---

## Test 10: Theme Testing - Light Mode

### Setup
1. Switch to "Light Mode" theme
2. Wait for theme to apply

### Test Execution
1. Open delete modal on any task
2. **Verify colors and styling:**
   - [ ] Modal background: Light (`#f8fafc`)
   - [ ] Text: Dark and readable
   - [ ] Delete icon: Dark red (`#dc2626`)
   - [ ] Warning box: Red accent visible
   - [ ] Delete button: Red background, white text
   - [ ] Cancel button: Light gray with border
   - [ ] High contrast throughout
   - [ ] No washed-out colors

3. **Take screenshot:**
   - Save as: `test-screenshots/delete-modal-light.png`

4. **Verify readability:**
   - [ ] All text has sufficient contrast
   - [ ] Warning text clearly visible
   - [ ] No eye strain reading modal content

5. **Test delete icon on card:**
   - [ ] Icon visible against light card background
   - [ ] Red color stands out clearly

**Result:** ✅ PASS / ❌ FAIL  
**Visual Issues:**

---

## Test 11: Theme Testing - Retro Terminal

### Setup
1. Switch to "Retro Terminal" theme
2. Embrace the CRT aesthetic

### Test Execution
1. Open delete modal on any task
2. **Verify retro styling:**
   - [ ] Modal background: Black (`#000000`)
   - [ ] Text: Green (`#00ff00`, `#00cc00`)
   - [ ] Delete icon: Bright red (`#ff0000`)
   - [ ] Warning box: Red on black
   - [ ] Delete button: Red, high contrast
   - [ ] Cancel button: Green text on dark
   - [ ] Borders: Green terminal style
   - [ ] Maintains retro CRT feel

3. **Take screenshot:**
   - Save as: `test-screenshots/delete-modal-retro.png`

4. **Verify theme consistency:**
   - [ ] All elements follow retro palette
   - [ ] No modern colors bleeding through
   - [ ] Text shadow/glow effects present (if applicable)

5. **Test in low light:**
   - [ ] Comfortable to read in dark room
   - [ ] Green text not too harsh

**Result:** ✅ PASS / ❌ FAIL  
**Visual Issues:**

---

## Test 12: Loading State During Deletion

### Setup
1. Open browser DevTools
2. Go to Network tab
3. Click "Throttling" dropdown
4. Select "Slow 3G" (to slow down deletion)

### Test Execution
1. Open delete modal
2. Click "Delete Task"
3. **Immediately verify:**
   - [ ] Button text changes to "Deleting..."
   - [ ] Spinner icon appears (rotating circle)
   - [ ] Spinner animates smoothly
   - [ ] Delete button disabled (grayed out)
   - [ ] Cancel button disabled
   - [ ] Buttons remain in proper position (no layout shift)

4. **During deletion, try to:**
   - [ ] Click Delete button again → No effect
   - [ ] Click Cancel button → No effect
   - [ ] Press ESC key → Modal stays open
   - [ ] Click backdrop → Modal stays open
   - [ ] Click other UI elements → Blocked by modal

5. **After deletion completes:**
   - [ ] Loading state clears
   - [ ] Modal closes
   - [ ] Success toast appears
   - [ ] Task removed from board

### Verification
- [ ] Loading spinner visible for at least 1 second
- [ ] No flicker between states
- [ ] Modal remains locked during operation
- [ ] Clean state reset after completion

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 13: Error Handling - Network Failure

### Setup
1. Open browser DevTools
2. Go to Network tab
3. Enable "Offline" mode (checkbox at top)

### Test Execution
1. Open delete modal
2. Click "Delete Task"
3. **Verify error handling:**
   - [ ] Loading state activates
   - [ ] Request fails (network error)
   - [ ] Error toast appears: "Failed to delete task"
   - [ ] Loading state clears
   - [ ] Modal remains open (deletion didn't complete)
   - [ ] Buttons re-enable
   - [ ] Task still present on board

4. **Re-enable network:**
   - Uncheck "Offline" mode
   - Try deleting again
   - [ ] Works correctly this time

### Verification
- [ ] Graceful error handling
- [ ] User can retry
- [ ] No broken state
- [ ] Clear error message

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 14: Keyboard Accessibility

### Test Execution
1. Use keyboard only (no mouse)
2. Navigate to a task card using Tab key
3. **Test delete modal keyboard access:**
   - [ ] Tab to delete icon area
   - [ ] Press Enter or Space to open modal
   - [ ] Modal opens and focus moves inside

4. **Inside modal:**
   - [ ] Tab key moves between Cancel and Delete buttons
   - [ ] Shift+Tab moves backwards
   - [ ] Enter on Delete button deletes task
   - [ ] Enter on Cancel button closes modal
   - [ ] ESC key closes modal (when not deleting)

5. **During deletion:**
   - [ ] Focus remains on modal
   - [ ] ESC key disabled during deletion
   - [ ] Tab still works but buttons disabled

### Verification
- [ ] All interactive elements keyboard accessible
- [ ] Logical tab order
- [ ] Visual focus indicators present
- [ ] No keyboard traps

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Test 15: Screen Reader Accessibility (Optional)

### Setup
- Enable screen reader (VoiceOver on Mac, NVDA on Windows)

### Test Execution
1. Navigate to task card
2. **Verify announcements:**
   - [ ] Delete button announced with label
   - [ ] "Delete task" or similar heard
3. Activate delete modal
4. **Verify modal content read:**
   - [ ] Dialog role announced
   - [ ] "Delete Task" title read
   - [ ] Warning description read
   - [ ] Button labels clear

**Result:** ✅ PASS / ❌ FAIL  
**Notes:**

---

## Summary Checklist

Mark each test as completed:

- [ ] Test 1: Delete task without agent
- [ ] Test 2: Delete task with agent in in_progress
- [ ] Test 3: Delete task in ai_review with agent
- [ ] Test 4: Delete task without worktree
- [ ] Test 5: Cancel button functionality
- [ ] Test 6: Rapid click protection
- [ ] Test 7: Worktree filesystem verification
- [ ] Test 8: Task disappears from Kanban
- [ ] Test 9: Modern Dark theme
- [ ] Test 10: Light Mode theme
- [ ] Test 11: Retro Terminal theme
- [ ] Test 12: Loading state display
- [ ] Test 13: Network error handling
- [ ] Test 14: Keyboard accessibility
- [ ] Test 15: Screen reader support (optional)

---

## Issues Found

Document any issues discovered:

| Test # | Issue Description | Severity | Steps to Reproduce |
|--------|-------------------|----------|-------------------|
|        |                   |          |                   |
|        |                   |          |                   |
|        |                   |          |                   |

---

## Testing Notes

**Testing Environment:**
- OS: _________________
- Browser: _____________
- Browser Version: _____
- Screen Resolution: ___
- Date Tested: _________
- Tester: ______________

**Overall Result:** ✅ PASS / ❌ FAIL

**Additional Comments:**

---

## Quick Test Script

For rapid testing, run all scenarios:

```bash
#!/bin/bash
# Quick verification script

echo "=== Task Deletion Feature - Quick Verification ==="
echo ""

echo "1. Checking task files..."
ls -la .code-auto/tasks/

echo ""
echo "2. Checking worktrees..."
git worktree list

echo ""
echo "3. Checking implementation plan..."
cat .code-auto/implementation_plan.json | jq '.totalTasks'

echo ""
echo "=== Manual steps required ==="
echo "1. Start dev server: npm run dev"
echo "2. Go through each test in this guide"
echo "3. Mark checkboxes as you complete each test"
echo "4. Document any issues found"
echo ""
echo "=== Automated tests ==="
echo "Run: npm run test:e2e"
```

Save as `test-deletion-feature.sh`, make executable with `chmod +x test-deletion-feature.sh`, then run `./test-deletion-feature.sh`.
