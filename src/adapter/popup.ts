export function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
