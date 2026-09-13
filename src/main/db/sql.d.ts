declare module '*.sql?raw' {
  const content: string;
  export default content;
}

/** Injected at build time from package.json (see electron.vite.config.ts). */
declare const __APP_VERSION__: string;
