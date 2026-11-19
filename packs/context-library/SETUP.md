# Setup note: Context library

Read this when the person picks the Context library pack.

The library is one private GitHub repo of Markdown notes, and every machine
keeps a checkout of it. Ask with your question tool:

- **Their context repo**: when they have one, add
  `--set context.repo=<owner/name>`. The checkout is then `context.path`,
  `~/dev/context` unless they set it.
- **A repo they already have**: add `--set context-library.repo=<owner/name>`.
  When the checkout should live somewhere other than `~/dev/context-library`,
  also add `--set context-library.path=<folder>`.
- **New repo**: create a private repo first, such as
  `gh repo create <their login>/context-library --private --add-readme`, then
  add `--set context-library.repo=<their login>/context-library`.

With the MCP gateway on, the hub also serves the library's search as the
`context_search` tool. It mounts the hub's checkout read-only and logs no
search. Until the hub's first sync clones the library, the gateway runs
without the tool, and its upstream check says what it waits for.

`fleet context add <url>` reads the source in code before an agent starts. A
web page comes from a plain request. A Slack thread or canvas, a Google Doc,
or a Wispr Flow link comes from one fixed tool of the hub's MCP gateway, so
those links need the gateway key that `fleet apply` gives a machine. Then a
Claude agent on the survey row turns the text into a note. It runs without
tools, MCP servers, or settings files, in an empty folder, and sees only the
source's text, the topics the library uses, and the note it updates. A page
that tells it to read or send notes finds no note to read and no way out.
Fleet writes the one note under `notes/` and refuses any other path. It keeps
only the links that appear in what the agent read, turns images into plain
links, escapes HTML, and shows code and diagram blocks as plain text, so
opening the note sends nothing new to another host.

With the Slack pack's trigger on, their own `:brain:` reaction on a Slack
message saves its thread as a note. The reaction shows `:eyes:` while it runs
and goes away once the note is saved. After that, the note updates by itself
when the thread gets new replies and then stays quiet for 30 minutes. A
thread with no reply for a month stops updating; a second `:brain:` updates the
note at once and follows the thread again. A capture that a restart of the
service cuts off runs again when the service starts.

The capture also looks for a Wispr Flow meeting held within an hour of the
thread's start, such as the recording of a huddle, and folds its decisions and
action items into the same note. When the meeting's Wispr notes are not ready
yet, it looks once more 30 minutes later.

After the note is saved, Fleet sends its context to the open T3 threads that
need it, on every linked machine. A router agent without tools, on the survey
row of the model table, reads the note and the list of open top-level threads,
picks at most 8, a conductor before its lanes, and writes each a message with
only the facts it needs. Fleet frames each message as information, not
instructions. The ephemeral reply links each thread that got it. Later replies
only update the note; Wispr notes that arrive late go out once more, with only
what is new. `fleet context share <note> [--dry-run]` and
`fleet context add <url> --share` do the same by hand.
