# Contributing to Cortex

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

```bash
git clone https://github.com/cz-zwtech/cortex.git cortex && cd cortex && npm ci
npm run typecheck
npm test                # every suite, each in an isolated sandbox
```

Node.js 22 or later. `npm test` never touches your real Claude Code config or memory: under test,
every path that would reach them is refused.

The container simulations under `test/sim` run multi-node and multi-user setups in throwaway
containers. They need Docker and the lab image:

```bash
docker compose -f compose.lab.yaml build      # builds cortex-lab:dev
bash test/sim/comms-local.sh                  # one at a time; each cleans up after itself
```

## Making a change

- Write the test first, then the change. A fix comes with the test that would have caught it.
- Keep a module to itself: it reaches another module only through capabilities that module
  publishes (or, for code running inside comms' mesh daemon, comms' `server/api.ts`).
  `test/boundary.test.ts` holds every module to that.
- Comments say why, when it is not obvious. Not what.
- One change per commit, with a message that says what changed and why.
- Run `npm run typecheck`, `npm test`, and the sims your change touches before opening a pull request.

## Writing a module

See [docs/module-author-guide.md](docs/module-author-guide.md) and `examples/hello-world`.

## Licence

By contributing, you agree that your contribution is licensed under the Apache License 2.0
(see [LICENSE](LICENSE)).
