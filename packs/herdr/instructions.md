## Herdr

Herdr runs my threads on this machine. A thread is a terminal in herdr-core, and `hc` controls it. Run `hc --skill` for the full manual.

- Start separate work with a Hedge template: `hc run --bg --keep --name <name> --label herdr.space=hedge hedge-<role> "<task>"`. `hc templates` lists one template for each row of the model table. Give the thread its task in `run`, and check `first_message.sent`.
- Start the thread in a new worktree from the default branch on origin: make it with `git worktree add`, and pass it with `--cwd`. The task carries the problem, the evidence, and the terminal it came from (`$HC_TERMINAL_ID`). It asks the new thread to open the pull request.
- To start a thread on another machine, add `--on <machine>`. `hc machine ls` lists the machines.
- Read a thread with `hc get <t>` and `hc read <t>`, and send to it with `hc send <t> "<text>"`. A `blocked` status means the person must answer. Do not answer for them with `send --force`.
- `hedge threads` lists, reads, and sends to threads the same way under any runtime.
