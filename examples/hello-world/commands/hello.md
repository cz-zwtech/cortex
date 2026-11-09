---
description: Say hello from the example module
---

Run this command and show the user its output:

```bash
curl -s localhost:3011/api/hello
```

This is the example module's contributed subcommand. It exists to demonstrate that
a module can add a slash command without core knowing anything about it in
advance, and that removing the module removes the command.
