---
name: review
description: Review the current diff (or a branch, PR number, commit range, or path) and relay the verified findings. Use for /review, "review this", or "check my changes".
---

1. Launch the review with the Agent tool: `subagent_type: "code-reviewer"`. Pass the target from `$ARGUMENTS` (default: the uncommitted working tree). Name any files another session owns so the reviewer skips them.
2. Wait for the agent's report. Relay every finding it confirmed, ranked most severe first, with the file and line, the defect in one sentence, and the failure scenario.
3. If the user asks for fixes, apply the verified changes.
