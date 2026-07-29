/** Platform opener argv for a workbench URL. */
export function browserOpenArgv(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") return ["open", url];
  return ["xdg-open", url];
}
