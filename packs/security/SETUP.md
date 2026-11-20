# Setup note: Security

Read this when the person picks the Security pack, in step 8. It needs a
hub with the MCP gateway.

Agents on every machine read the person's Wiz tenant through the hub. The
hub signs in to Wiz once, with OAuth, and asks only for `read:all` and
`offline_access`, so agents cannot resolve, assign, or file anything in
Wiz. Tell them this before they turn it on.

1. The workflow starts off. Add `--workflows wiz=on` to the setup
   command.
2. **Check the prerequisite.** Ask with your question tool whether they
   can sign in to Wiz at <https://app.wiz.io>. The gateway acts as their
   Wiz user and sees what that user sees. Stop here until they can.
3. **Sign in.** After the hub's `hedge update` and `hedge apply`, run on
   the hub:

   ```sh
   ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge mcp-gateway sign-in wiz'
   ```

   It prints an address. They open it, sign in to Wiz, and approve. The
   browser then fails to load a `127.0.0.1` page; they paste that page's
   full address into the terminal. Wiz's own sign-in asks for every scope
   it offers, writes included, so the gateway signs in by hand with the two
   read scopes instead.
4. **Check it.** In a new agent session on any machine, ask the agent to
   call the `wiz-discover` tool of `hedge-hub`. It lists Wiz's domains, such as
   threats and vulnerabilities.
