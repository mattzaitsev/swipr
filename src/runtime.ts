import { pathToFileURL } from 'node:url';

/** True when this module is the process entrypoint (so each process file can also be imported by dev/all.ts). */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return !!entry && moduleUrl.toLowerCase() === pathToFileURL(entry).href.toLowerCase();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function logger(scope: string) {
  return (msg: string, extra?: unknown) =>
    console.log(`${new Date().toTimeString().slice(0, 8)} ${scope.padEnd(8)} ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`);
}
export type Logger = ReturnType<typeof logger>;

/** Run `main` as a process entrypoint: log fatal errors and exit non-zero. */
export function runMain(main: () => Promise<unknown>) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
