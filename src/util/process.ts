export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Every subprocess in prbb goes through this runner so tests can substitute a fake.
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<CommandResult>;

export function commandString(command: string, args: string[]): string {
  return [command, ...args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))].join(" ");
}

// Spawns directly (argv array, no shell) so arguments are never interpolated.
export const runCommand: CommandRunner = async (command, args, options = {}) => {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
