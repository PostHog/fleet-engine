---
title: Ship it
shelf: build
for: Your first proven pull request, before you ship it.
after: You know what happens by default, after full send, and after stamp it, and what still waits for you.
---

## How far should it go?

Your first build is back. A draft pull request. Tested, reviewed, and proven. One question is left. How far should it go? The agent never decides that alone. You decide, with a phrase. Say nothing. Say full send. Or say stamp it. This lesson shows all three.

## By default, you ship it

By default, the agent stops at the draft. It never marks it ready. It never merges. You read the pull request first. The risk callout, the testing section, the known issues. Then you mark it ready yourself. A teammate reviews it, as always. And you merge it. Nothing ships until you ship it.

## Full send ships it for you

Do you trust the proof? Then say full send. Or say ship it to production. Now the agent owns the rest. First, the QA swarm reviews it. Then it marks the pull request ready. It keeps the checks green. It answers the review bots. Once a teammate approves, it merges. So say it only for work you would merge yourself.

## The merge waits for a gate

Full send is not a blank check. The merge waits for a gate. Every check is green. Every bot finding is fixed, or answered. A person approved it. And no comment from a teammate waits for you. Does a teammate ask a question? Then the merge holds, until you answer. Is the change risky? Or a one-way door? Then it asks you once more, before the merge.

## Then it watches the rollout

Merged is not done. The agent waits for the deploy. Then it reads the errors and the logs. A risky change ships behind a feature flag. The flag turns on for your team first. Then for ten percent of users. Then half. Then everyone. A low-risk change skips the middle steps. A change with no flag gets a check an hour after the deploy. Before each step, it checks again. Between checks, the thread settles. It leaves your inbox. It comes back only with a problem.

## A bad sign turns it back

What if the errors climb? The agent checks again, half an hour later. Still bad? Then it turns the flag back a step. Fewer users see the change. It starts the fix in a new thread. It prepares a revert, but does not open it. Then it asks you, with the evidence and your options. From then on, the flag moves forward only when you say so. Or once a fix has shipped.

## Stamp it uses your approval bot

Some teams have an approval bot. It reads a pull request, and approves it. Name yours once, with one setting. Then say stamp it. It is full send, with the bot in place of a teammate. But some code always goes to a person. Such as sign-in and permissions. Secrets. Billing. Database migrations. Code that another team owns? Then it asks you first. And with no bot set, stamp it works like full send.

## Pick the phrase per change

So you pick, change by change. Say nothing, and you ship it yourself. Say full send, and a teammate's approval lets the agent ship it. Say stamp it, and your bot's approval does. Start with the default. Use the phrases once you trust the proof. The next lesson is the QA swarm. It shows what the reviewers check. And how to read a proven pull request.
