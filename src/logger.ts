// SPDX-License-Identifier: BSD-3-Clause

/** Logging mirroring Python's `logging` usage in WeasyPrint (stderr, levels). */
export type Level = 'debug' | 'info' | 'warning' | 'error';

type Sink = (level: Level, message: string) => void;

// Runtime-agnostic default sink: stderr when available (Node), console.error otherwise.
const defaultSink: Sink = (level, message) => {
  if (level === 'debug' || level === 'info') return;
  const line = `${level.toUpperCase()}: ${message}\n`;
  const g = globalThis as any;
  if (typeof g.process?.stderr?.write === 'function') g['process']['stderr'].write(line);
  else if (typeof g.console?.error === 'function') g.console.error(line.trimEnd());
};

let sink: Sink = defaultSink;

export function setLogSink(s: Sink): void {
  sink = s;
}

/** Restore the default stderr sink (test helpers that stub one out use this). */
export function resetLogSink(): void {
  sink = defaultSink;
}

export const LOGGER = {
  debug: (message: string) => sink('debug', message),
  info: (message: string) => sink('info', message),
  warning: (message: string) => sink('warning', message),
  error: (message: string) => sink('error', message),
  log: (level: Level, message: string) => sink(level, message),
};