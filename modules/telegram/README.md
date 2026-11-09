# telegram

Cortex's channel to the operator on Telegram: items from producers, replies
routed to roles, alerts. It runs in the Cortex host on a service node
(`cortex-install --service --with telegram`).

## It has no built-in bot

The module refuses to run until an install names, for each bot it may use:

- **the identity Telegram must report** for the token (`identity.username`,
  checked with getMe when the service starts);
- **where the token comes from**, as a secret reference, never the value;
- **the operators' chats**, also as secret references. The bot sends only to
  these chats and answers only them.

Nothing has a default: no key name, no path, no bot. Anything missing or
mismatched refuses the bot, with the reason in `cortex-status` and the host
log:

| Case | What happens |
| --- | --- |
| no `telegram.json` | the module does not start ("not configured") |
| a token-shaped value in `telegram.json` | the file is refused |
| the old shape (`tokenEnv`, `chatEnv`) | refused; run `migrate` (below) |
| the token source gives nothing | that bot is refused, not run |
| getMe reports another username | that bot is refused, and nothing is sent through it |
| Telegram does not answer getMe | the bot waits, retrying each minute; its messages stay queued |
| `http.listen` set without `http.publishToken` | the file is refused |

## Secret references

```json
{ "from": "bao", "path": "kv/cortex/secrets", "key": "TG_MY_BOT_TOKEN" }
{ "from": "env", "name": "TG_MY_BOT_TOKEN" }
```

- `bao`: the module reads the secret from OpenBao itself when it starts,
  through `bao-run` (its AppRole login, from `BAO_ADDR`, `BAO_ROLE_ID` and
  `BAO_SECRET_ID`), and holds it in memory only. An environment variable of the
  same name is never read: there is no fallback.
- `env`: for an install without OpenBao. Write it explicitly; it is never assumed.
  The host reads these from its environment: `cortex-telegram-admin unit` prints a
  unit that loads `~/.config/ckn/telegram.env` (you create it, chmod 600, with the
  names it lists) and leaves OpenBao out unless a reference uses it.

## Setting it up

Without OpenBao, the same with env references:

```sh
cortex-telegram-admin init --bot dev --username @my_cortex_bot \
  --token env:TG_MY_BOT_TOKEN --operator me --chat env:TG_MY_CHAT_ID
```

With OpenBao:

```sh
cortex-telegram-admin init \
  --bot dev --username @my_cortex_bot \
  --token bao:kv/cortex/secrets#TG_MY_BOT_TOKEN \
  --operator me --chat bao:kv/cortex/secrets#TG_MY_CHAT_ID \
  --publish bao:kv/cortex/secrets#TG_PUBLISH_TOKEN
```

`init` writes `telegram.json` only after every reference resolves and Telegram
reports the named username for the token. Then restart the Cortex host.

- `cortex-telegram-admin check` says, for each reference, whether it resolves
  (yes or no, never the value).
- `cortex-telegram-admin migrate --secrets-path <path> --username <bot>=@name [--apply]`
  rewrites a `telegram.json` of the old shape: each environment variable name
  becomes an OpenBao reference under the path, and each bot gets its identity.
  Without `--apply` it prints the result; with it, the old file is kept beside
  the new one.
- `cortex-telegram-admin unit` prints the Cortex host's systemd unit. It passes
  no secrets: the module reads its own (OpenBao through bao-run, or the env file
  the unit names).

More bots (per role, per person) are more entries in `bots`, each with the same
required fields.
