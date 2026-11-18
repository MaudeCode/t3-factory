The `{{workflow}}` workflow of `{{repo}}` failed on its release branch: run {{runId}} ({{runUrl}}) at commit `{{sha}}`. These jobs failed:

{{failedJobs}}

1. Read the repository's instructions. If it has a guide for repairing a failed release-branch or CI run, follow it; it takes precedence over the steps below where they differ.
2. Read the failed jobs' logs with `gh run view {{runId}} --repo {{repo}} --log-failed`. Find the root cause of each failure before you change anything.
3. Repair every failure you can in one pull request against the release branch. Run the repository's documented checks for what you changed, then publish, wait for its required CI and review, and merge it when the repository's merge rules allow. Do not change repository settings, secrets, rulesets or workflow permissions.
4. For a failure you cannot repair (it needs a credential, an outside service, a product decision or a person), open one GitHub issue for it, or update the open issue that already covers it, saying that a person is needed and why. Do not open a second issue for the same failure.
5. After your pull request merges, look once at the newest run of `{{workflow}}` on the release branch. If it fails in a way your change did not cover, do at most one more round of steps 2 to 4. Then stop.
6. Report as the scheduler asks, naming the failed jobs you repaired and those you did not. Then end your turn.
