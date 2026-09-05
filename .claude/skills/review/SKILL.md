---
name: review
description: Review the current diff (or a branch, PR number, commit range, or path) on Opus and relay the verified findings. Use for /review, "review this", or "check my changes".
---

Reviews run on Opus and fixes run on Fable, whatever model the session is on. This skill puts the review in the `code-reviewer` agent, whose definition pins the model.

1. Launch the review with the Agent tool: `subagent_type: "code-reviewer"`. Pass the target from `$ARGUMENTS` (default: the uncommitted working tree). Name any files another session owns so the reviewer skips them. Do not pass `subagent_type: "fork"`: a fork runs on the session model.
2. Wait for the agent's report. Relay every finding it confirmed, ranked most severe first, with the file and line, the defect in one sentence, and the failure scenario.
3. If the user asks for fixes and the session is on Fable, apply them here. If the session is on another model, apply them in an agent launched with `model: "fable"`.
