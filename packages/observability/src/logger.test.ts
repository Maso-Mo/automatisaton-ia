import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { currentLogContext, runWithLogContext, setLogContext } from './context';
import { createLogger } from './logger';

class MemoryStream extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(chunk.toString());
    callback();
  }

  json(): Array<Record<string, unknown>> {
    return this.lines
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function makeLogger() {
  const stream = new MemoryStream();
  const logger = createLogger({ level: 'debug', pretty: false, name: 'test', destination: stream });
  return { logger, stream };
}

describe('journal corrélé (docs/08 §5)', () => {
  it('ajoute automatiquement le contexte du job, sans le répéter à chaque appel', () => {
    const { logger, stream } = makeLogger();
    runWithLogContext({ jobId: 'job-1', workerId: 'w-1', task: 'noop' }, () => {
      logger.info('début du job');
      setLogContext({ step: 'llm_call' });
      logger.info('appel du modèle');
    });
    const [first, second] = stream.json();
    expect(first?.jobId).toBe('job-1');
    expect(first?.task).toBe('noop');
    expect(first?.process).toBe('test');
    expect(second?.step).toBe('llm_call');
  });

  it('n’invente pas de contexte hors job', () => {
    const { logger, stream } = makeLogger();
    logger.info('démarrage');
    const [line] = stream.json();
    expect(line?.jobId).toBeUndefined();
    expect(currentLogContext()).toEqual({});
  });

  it('n’écrit jamais un secret, même collé dans le message (docs/07 §8)', () => {
    const { logger, stream } = makeLogger();
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    logger.error({ apiKey: secret, detail: `échec avec ${secret}` }, 'requête refusée');
    const raw = stream.lines.join('');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
  });

  it('respecte le niveau configuré', () => {
    const stream = new MemoryStream();
    const logger = createLogger({ level: 'warn', pretty: false, destination: stream });
    logger.debug('invisible');
    logger.warn('visible');
    expect(stream.json()).toHaveLength(1);
    expect(stream.json()[0]?.level).toBe('warn');
  });

  it('produit du JSON structuré exploitable en base', () => {
    const { logger, stream } = makeLogger();
    logger.info({ microUsd: 81_400 }, 'coût calculé');
    const [line] = stream.json();
    expect(line?.msg).toBe('coût calculé');
    expect(line?.microUsd).toBe(81_400);
    expect(typeof line?.time).toBe('string');
  });
});
