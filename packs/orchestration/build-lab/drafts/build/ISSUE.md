# Build: issue

An **issue** is the plan for one stack: the problem, the decisions, and the slices. The human reads it once, at the plan, and then the build runs to draft pull requests.

1. **First steps.** For each `research` fact, run the `research` skill in a background worker. For `prototype`, run the `prototype` skill, and for `architecture`, the `architecture` skill. Show the result and let the human pick. Done when every first step has an answer.
2. **Write the issue** in the tracker the user's agent instructions name for plans, else in the code repository's issues: the problem in one paragraph, the destination, each decision with its recommended answer, the slices in merge order, and what is out of scope. Each slice is a thin vertical slice of at most about 400 changed production lines that a test proves. Done when the issue exists and links every first-step result.
3. **Ask at the plan.** Ask one question with the issue link and every open decision, the recommended answer first. Use the harness's question tool when it has one. Done when the human answered.
4. **Build the slices.** Run the `full-stop` skill once per slice, in order. Each pull request stacks on the one before it and links the issue. Tick each slice on the issue with its pull request.

Done when every slice has a draft pull request that passes the gate of `full-stop`, and the issue lists them.
