# QA Quick Checklist: Task Deletion Feature

**Tester:** ________________  **Date:** ________________  **Browser:** ________________

---

## Pre-Testing Setup

- [ ] Development server running (`npm run dev`)
- [ ] Browser DevTools open (F12)
- [ ] Terminal ready for filesystem verification
- [ ] No critical console errors on load

---

## Core Functionality Tests

### 1. Delete Task - No Agent Running
- [ ] Create new task in Planning phase
- [ ] Click trash icon → Modal opens
- [ ] Verify task details displayed
- [ ] Click "Delete Task" → Loading spinner appears
- [ ] Task deleted successfully
- [ ] Task removed from board

### 2. Delete Task - Agent Running (In Progress)
- [ ] Start agent on a task
- [ ] Verify "🤖 Agent working" status
- [ ] Delete task while agent active
- [ ] Agent stops + task deletes
- [ ] Worktree removed: `git worktree list`

### 3. Delete Task - AI Review Phase
- [ ] Task in AI Review with QA agent running
- [ ] Delete task → QA agent stops
- [ ] All subtasks removed
- [ ] Worktree cleaned up

### 4. Delete Task - No Worktree
- [ ] Task in Planning (no worktree created)
- [ ] Delete completes without errors
- [ ] No worktree warnings

### 5. Cancel Button
- [ ] Open delete modal
- [ ] Click "Cancel" → Modal closes
- [ ] Task unchanged
- [ ] No API calls made (check Network tab)

### 6. Rapid Click Protection
- [ ] Open delete modal
- [ ] Rapidly click "Delete Task" 5+ times
- [ ] Button disables after first click
- [ ] Only one DELETE request sent
- [ ] No errors in console

### 7. Worktree Filesystem Cleanup
**Before deletion:**
```bash
git worktree list  # Note the worktree path
ls .code-auto/worktrees/
```
- [ ] Worktree directory exists

**After deletion:**
```bash
git worktree list  # Should be removed
ls .code-auto/worktrees/  # Directory gone
```
- [ ] Worktree completely removed
- [ ] No orphaned files

### 8. Task Removed from Kanban
- [ ] Task disappears after deletion
- [ ] Board layout adjusts properly
- [ ] Refresh page → Task doesn't reappear
- [ ] Task JSON deleted: `ls .code-auto/tasks/`

---

## Loading State Tests

- [ ] Button text changes to "Deleting..."
- [ ] Spinner icon appears and animates
- [ ] Both buttons disabled during deletion
- [ ] ESC key blocked during deletion
- [ ] Backdrop click blocked during deletion
- [ ] Modal remains locked until completion

---

## Theme Tests

### Modern Dark Theme
- [ ] Switch to Modern Dark
- [ ] Open delete modal
- [ ] Delete icon visible (red)
- [ ] Modal background dark (`#1e293b`)
- [ ] Text readable (white/light slate)
- [ ] Warning box red accent
- [ ] Delete button red background
- [ ] Overall appearance good

### Light Mode Theme
- [ ] Switch to Light Mode
- [ ] Open delete modal
- [ ] Delete icon visible (dark red)
- [ ] Modal background light (`#f8fafc`)
- [ ] Text readable (dark)
- [ ] Warning box visible
- [ ] Delete button red background
- [ ] High contrast throughout

### Retro Terminal Theme
- [ ] Switch to Retro Terminal
- [ ] Open delete modal
- [ ] Delete icon bright red (`#ff0000`)
- [ ] Modal black with green text
- [ ] Retro aesthetic maintained
- [ ] Green borders visible
- [ ] Warning box red on black
- [ ] CRT feel preserved

---

## Error Handling Tests

### Network Failure Test
- [ ] Enable "Offline" mode in DevTools
- [ ] Try to delete task
- [ ] Error toast appears: "Failed to delete task"
- [ ] Loading state clears
- [ ] Modal remains open (can retry)
- [ ] Buttons re-enable
- [ ] Task still on board

### Partial Failure Test (Agent Stop Fails)
- [ ] Task with agent - force agent stop to fail (if possible)
- [ ] Task still deletes
- [ ] Warning message shown (if applicable)
- [ ] Graceful degradation

---

## Accessibility Tests

### Keyboard Navigation
- [ ] Tab to delete icon area
- [ ] Enter/Space opens modal
- [ ] Tab between Cancel and Delete buttons
- [ ] Shift+Tab moves backwards
- [ ] Enter on Delete button deletes task
- [ ] ESC closes modal (when not deleting)
- [ ] Focus indicators visible

### Visual Accessibility
- [ ] All text has good contrast
- [ ] Destructive actions clearly marked (red)
- [ ] Loading states visible
- [ ] No color-only information
- [ ] Icon meanings clear

---

## Browser Testing (Optional)

Test in multiple browsers:

- [ ] Chrome/Edge (Chromium)
- [ ] Firefox
- [ ] Safari (Mac only)

---

## Performance Checks

- [ ] Modal opens instantly (< 100ms)
- [ ] Loading spinner smooth
- [ ] No UI freezing during deletion
- [ ] Task removal smooth (< 50ms)
- [ ] No memory leaks (check DevTools)

---

## Console & Network Verification

### Console Checks
- [ ] No errors during normal operation
- [ ] Only expected logs present
- [ ] No warnings about deprecated features

### Network Checks
- [ ] Only one DELETE request per deletion
- [ ] Request includes taskId parameter
- [ ] Response status 200 on success
- [ ] Response includes success message

---

## Filesystem Verification Commands

```bash
# Check task files
ls -la .code-auto/tasks/

# Check worktrees
git worktree list

# Verify specific worktree removed
ls .code-auto/worktrees/<task-id>  # Should not exist

# Check implementation plan
cat .code-auto/implementation_plan.json | jq '.totalTasks'
```

---

## Issues Found

| Issue # | Description | Severity | Steps to Reproduce |
|---------|-------------|----------|-------------------|
| 1       |             |          |                   |
| 2       |             |          |                   |
| 3       |             |          |                   |

**Severity Levels:**
- 🔴 Critical: Blocks functionality
- 🟡 Major: Significant impact
- 🟢 Minor: Cosmetic/small issue

---

## Test Summary

**Total Tests:** 33  
**Passed:** _____  
**Failed:** _____  
**Skipped:** _____  

**Overall Result:** ⬜ PASS / ⬜ FAIL

---

## Final Verification

Before signing off:

- [ ] All core functionality tests passed
- [ ] All three themes working correctly
- [ ] No critical console errors
- [ ] Filesystem cleanup verified
- [ ] Loading states working
- [ ] Error handling tested
- [ ] Accessibility checked
- [ ] Documentation reviewed

---

## Sign-Off

**Tested By:** ______________________  
**Date:** ________________  
**Status:** ⬜ Approved / ⬜ Needs Work  

**Notes:**

---

## Quick Commands Reference

```bash
# Start dev server
npm run dev

# Run automated E2E tests
npm run test:e2e

# Check git status
git status
git worktree list

# List task files
ls .code-auto/tasks/*.json

# List worktree directories
ls .code-auto/worktrees/

# View implementation plan
cat .code-auto/implementation_plan.json

# Count tasks
ls .code-auto/tasks/*.json | wc -l
```

---

## Help & Resources

- **Full QA Report:** See `QA_VERIFICATION_REPORT.md`
- **Manual Testing Guide:** See `MANUAL_TESTING_GUIDE.md`
- **Implementation Details:** See `DELETE_MODAL_IMPLEMENTATION.md`

---

**Print this checklist and mark items as you test!**
