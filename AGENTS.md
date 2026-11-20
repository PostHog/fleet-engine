# Hedge engine

The public Hedge engine: the `hedge` CLI, `get.sh`, and the public packs.
`GLOSSARY.md` holds the words to use.

- Use Bun. Do not use npm or Yarn.
- Keep owned code small and typed. Write no comments; let names explain the code.
- Run `bun run test` and `bun run typecheck` after every change. Keep
  `bun run test` under 5 seconds, and never wait on real time.
- The Hedge site is generated, with one HTML file for each route. No built
  file is in the repository. `bun scripts/build-page.ts` writes the site to
  `site/`, which git ignores, and the Pages workflow builds it on each push to
  `main`. After you change a `pack.json`, `presets.json`, or `page/`, build the
  site and look at each route in a browser.
- The hedgehogs and the PostHog logo in `page/art/` are PostHog's own files.
  Never draw, change, or generate one. `page/art/README.md` names the source of
  each file.
- Tests that touch a home directory use a temporary `HOME`. Never run
  `hedge apply` or `get.sh` against a real home directory from an agent.
- This repo will be public. Never commit private hostnames, Slack IDs, private
  repo names, email addresses, internal numbers, customer data, or secrets.
  The `privacy` CI job enforces this with gitleaks and a deny-list that lives
  outside this repo.
- Write documentation in simplified technical English.
- Reach threads through the runtime seam (`ctx.threads`, `activeRuntime`,
  `hedge threads`), never through one runtime's client. Code that needs
  T3 Code's own records lives behind a workflow with `needs: ["t3"]`.
