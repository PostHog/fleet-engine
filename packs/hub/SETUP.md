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
2. Once item 2 of step 9 has turned it on, the proxy needs at least two of their
   own subscriptions. This prints the sign-in command that adds one:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge cli-proxy plan'
   ```

   The sign-in needs their keyboard and browser, so run the printed
   command in a Terminal window as `ssh -t coder.<hub> '<command>'`, once
   for each subscription, and follow what it prints.
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
