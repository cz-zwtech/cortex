/**
 * `--help` / `-h` for every CLI: print the usage and exit 0.
 *
 * Each bin calls this before any other statement, so asking for help never
 * installs, writes, connects or loads a module. A command whose arguments carry
 * free text passes only the arguments before the text, so a message that says
 * "-h" is still sent.
 */
export const exitOnHelp = (usage: string, args: readonly string[] = process.argv.slice(2)): void => {
  if (!args.includes('--help') && !args.includes('-h')) return
  console.log(usage.trim())
  process.exit(0)
}
