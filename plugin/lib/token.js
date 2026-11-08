/**
 * Pairing token shared by the plugin and the Edge extension.
 *
 * The bridge listens on the loopback interface, which still means any local
 * process (or any page allowed to open a websocket) could reach it, so the
 * extension must prove it was paired. The token is generated once per profile
 * and cached next to the DSH home so restarts keep the same pairing.
 *
 * @module dsh-edge-bridge/token
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = 'edge-bridge-token';

/** Resolve the directory that holds per-profile bridge state. */
export function stateDir() {
  const configured = process.env.DSH_HOME?.trim();
  if (configured) return configured;
  return join(homedir(), '.dsh');
}

/** Path of the cached pairing token for this DSH home. */
export function tokenFile() {
  return join(stateDir(), TOKEN_FILE);
}

/**
 * Read the pairing token, creating and persisting one on first use.
 * @param {string} configured an explicit `token` from the plugin config
 * @param {{ warn?: Function }} [logger]
 */
export function ensureToken(configured, logger) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit.length > 0) return { token: explicit, source: 'config', file: undefined };
  const file = tokenFile();
  try {
    const cached = readFileSync(file, 'utf8').trim();
    if (cached.length >= 16) return { token: cached, source: 'file', file };
  } catch {
    /* first run */
  }
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on Windows */
    }
    return { token, source: 'generated', file };
  } catch (error) {
    logger?.warn?.(`edge-bridge: cannot persist the pairing token to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return { token, source: 'memory', file };
  }
}

/** Constant-time-ish comparison for a shared secret. */
export function tokenMatches(expected, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  return diff === 0;
}