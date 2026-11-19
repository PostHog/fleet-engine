# Setup note: Recovery

Read this when the person picks Recovery in step 9.

A thread that stops on a usage limit or a provider outage continues by
itself once the provider answers again. Recovery asks the provider through
the hub's own-account proxy, so it needs own-account balancing. Without it,
Recovery never knows that a provider has capacity, and continues nothing.

1. Add `--add recovery` to the command in item 2 of step 9, and add
   `provider-recovery=on,own-account-balancing=on` to `--workflows`.
2. Once item 2 of step 9 has turned it on, the proxy needs at least two of their
   own subscriptions. This prints the sign-in command that adds one:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge cli-proxy plan'
   ```

   The sign-in needs their keyboard and browser, so run the printed
   command in a Terminal window as `ssh -t coder.<hub> '<command>'`, once
   for each subscription, and follow what it prints.

   On a Coder box, the Claude sign-in of the proxy, `-claude-login
   -no-browser`, prints a link and then waits for the browser to come back
   to `localhost:54545` on the hub. Its hint, an SSH port forward to the
   box's public address as root, does not work for a Coder workspace. Instead, the person
   opens the link on the Mac and signs in. The browser then fails to load an
   address that starts with `http://localhost:54545/`. Ask for that whole
   address with the secret prompt, delivered as a file, because it holds a
   one-time code. While the sign-in still waits, send the address to it on
   the hub. `curl` reads the address from its standard input, so it never
   shows, and goes around any proxy that the hub's environment sets, so
   the address reaches the waiting sign-in and no proxy:

   ```sh
   ssh coder.<hub> 'sed "s/^/url = /" | curl -q --noproxy "*" -fsS -K -' < <file>
   ```
3. After step 9 adds the node, connect it to the proxy. On the hub,
   `hedge cli-proxy doctor` prints one `Connect <node>:` command per node.
   Each one reads the hub's proxy key, so it runs on the hub:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge cli-proxy doctor'
   ```

   Then run each `Connect` command it printed on the hub, without the
   `Connect <node>:` label:

   ```sh
   ssh coder.<hub> sh -s <<'SCRIPT'
   export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
   <the command after Connect <node>:>
   SCRIPT
   ```
