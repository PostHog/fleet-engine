# Setup note: Hub

Read this when the person picks the Hub pack in step 9.

The hub is the one devbox that looks after the others. With the Hub pack
on, it keeps an SSH tunnel and a T3 link to every node, so each machine can
start threads on the others, and it cleans a node's disk before it fills.
Every machine keeps working when the hub is down.

1. Turn it on with `--add hub`. Boxes start off. They lend short-lived
   devboxes from a warm pool, and each box takes a full devbox's CPUs
   from the cloud quota, so a pool can stop your devboxes from starting.
   They also need a Coder template and more setup than a first day needs.
   Turn them on later with `hedge packs --workflows boxes=on`.
2. The hub must already be named in the profile. Step 9 does that with
   `hedge hub here` before it turns the pack on.
3. Own-account balancing, Proxy panel, and Provider recovery start off.
   Provider recovery needs own-account balancing; the section below turns
   both on when the person wants threads to go on after a usage limit. Proxy
   panel needs own-account balancing too; turn it on only when the person asks
   for the proxy's web panel. Dream moved to the Memory pack.
   With own-account balancing on, the hub installs and runs the proxy even
   while it holds none of their subscriptions, and setup goes on. Each
   machine keeps its own sign-in until the proxy serves the agent. Until the
   proxy holds `hub.proxyAccounts` of their subscriptions (2 by default),
   `hedge doctor` on the hub shows a `To do:` line with the login command.
   Relay that line; it does not fail setup.
4. Each node joins when `hedge devbox add` adds it. The hub takes the new
   node at its next `hedge update`, or at once when it answers.

## Provider recovery

Ask with your question tool whether threads should go on by themselves after
a usage limit or an outage. When they should:

A thread that stops on a usage limit or a provider outage continues by
itself once the provider answers again. Provider recovery asks the provider through
the hub's own-account proxy, so it needs own-account balancing. Without it,
provider recovery never knows that a provider has capacity, and continues nothing.

1. Add `provider-recovery=on,own-account-balancing=on` to `--workflows` of
   the command in item 2 of step 9.
2. Once item 2 of step 9 has turned it on, provider recovery needs at least
   one of their own subscriptions in the proxy, and the proxy should hold
   two. Setup does not wait for them: until the proxy holds them,
   `hedge doctor` shows a `To do:` line with the sign-in command, and nothing
   fails. This prints the sign-in command that adds one:

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
   Each one reads the hub's proxy key, so it runs on the hub. It saves the
   key on the node, then runs `hedge apply` on that node. Connect alone
   only saves the key: the node uses the proxy only after `hedge apply`
   runs there.

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

   Read the `To do:` and `Fix:` lines that `hedge apply` prints for the
   node. If connect fails, it runs no `hedge apply` and changes nothing:
   fix what it prints, then run the same command again.
