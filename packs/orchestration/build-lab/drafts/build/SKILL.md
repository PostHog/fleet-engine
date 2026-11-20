---
name: build
description: Size and run new work that changes code, docs, or config, from a one-line fix to a project of many pull requests. Use at the start of every task that builds, fixes, or changes something, and when running work outgrows its size.
---

# Build

Take a request to shipped work at the smallest size that holds it. The **judge** picks the size, and you read only that size's file.

## Judge

Read the request, the thread so far, and the code it touches. Take the first size whose test holds:

| Size | Test | Path |
| --- | --- | --- |
| `none` | A question, a status check, a lookup, an explanation, or a review of someone else's work. | Answer it. The build ends. |
| `one-off` | One session finishes it in one pull request of at most about 400 changed production lines, or in a change with no pull request, and the human has no decision to make first. | **One-off** below |
| `issue` | One stack of at most 3 pull requests, or a decision the human must make before the code. | [ISSUE.md](ISSUE.md) |
| `map` | Several stacks, several repositories, or a destination still in fog: you cannot yet list the decisions. | [MAP.md](MAP.md) |

Then add each **first step** whose test holds. A first step other than `research` makes the size at least `issue`.

- `research`: a fact outside this repository decides the shape, such as a third-party API, a price, or a limit.
- `prototype`: how it looks or behaves is open, such as a layout or a state model the human should see first.
- `architecture`: it changes a contract between modules, the data model, or caching.

When two sizes fit, take the smaller one: judging again catches growth.

Done when you said the **verdict line** to the human, before any other work: `Build: issue + research. <one reason>.`

## Judge again

Judge again when the work outgrows its size: the diff passes about 400 production lines or needs a second pull request, a decision for the human appears, the work reaches another repository, or the human adds scope. Say the new verdict line, read the new size's file, and carry the work you have: a one-off becomes the first slice of the issue, and an issue becomes the destination of the map. A running build only grows; when scope shrinks, finish at the current size.

## Start

Before the first change, run the **Start** decision of the `impact` skill, and its **Worth** check for a fix, when the skill is installed. A park ends the build with its park line.

## One-off

1. With `research`, read the source first and cite it in the pull request.
2. Build the change test-first.
3. When it ends in a pull request, run the `full-stop` skill.

Done when the change is in a draft pull request that passes the gate of `full-stop`, or, without a pull request, when the change is applied and checked.
