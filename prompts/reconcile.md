Reconcile {{ticketKey}} ({{title}}): {{link}}

The scheduler will not start {{ticketKey}} because earlier work still references it in `{{repo}}`. This is what it found:

{{evidence}}

Your job is to settle that earlier work so the ticket is either finished or free to start again. Inspect every item above first: the T3 threads (status, pending requests, branch and worktree), the Git branches and their worktrees (`git status`, whether the head is merged into `{{baseBranch}}`), and the open pull requests that mention {{ticketKey}}. Search for further threads, branches and pull requests that name the ticket. Then take exactly one of these outcomes:

1. **Work already merged on the release branch.** Record the evidence on the ticket (the merged pull request or commit on `{{baseBranch}}`), close it in a configured done status and verify the closure. Delete merged local branches and their clean worktrees, and archive the stale T3 threads. Report `no-work` with `"prUrls":[]`.
2. **An unmerged branch or open pull request with real work.** Deliver it through the supplied delivery workflow, with every gate unchanged, and merge it. Work on that existing branch or pull request; do not start a second implementation. Report `complete` with the merged pull request URLs once the ticket is verified done.
3. **Abandoned or superseded leftovers with nothing worth keeping.** Comment on the ticket what you found and why it is safe to drop. Then delete the clean local branches and worktrees and archive the threads, so the ticket becomes eligible again. Archive rather than settle: the scheduler skips only archived threads, and a settled thread whose worktree is gone still holds the ticket back. Leave the ticket open in its ready status. Report `no-work` with `"prUrls":[]`.
4. **A T3 session still active on the ticket** (running, waiting for input, or holding a pending request). Touch nothing. Report `awaiting-human` naming the session and what it is doing.

Report `awaiting-human` too when the right outcome needs a product decision or the owner's judgement.

Deletion rules:

- Delete a local branch or worktree only when it is clean and its head is merged or its work is recorded on the ticket. Use `git branch -d` and `git worktree remove` without force.
- Never force-delete a remote branch or close a pull request without recording why on the ticket.
- This prompt is the owner's instruction to archive the idle T3 threads that reference {{ticketKey}}. Archive one only when it is idle and has no pending request. Never stop, message or steer another session, and touch no thread that does not reference {{ticketKey}}.
- Leave this run's own worktree clean with no commits unless outcome 2 needs them on the existing branch.
