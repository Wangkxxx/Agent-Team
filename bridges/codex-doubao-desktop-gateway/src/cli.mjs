import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function cliConfig(env = process.env) {
  const cli = env.DOUBAO_CLI_ENTRY || path.resolve('deps/doubao-cli/bin/doubao.mjs');
  if (!fs.existsSync(cli)) throw new Error(`Patched doubao-cli entry not found: ${cli}`);
  const app = env.DOUBAO_APP;
  if (!app || !path.isAbsolute(app) || !fs.existsSync(app)) throw new Error('Set DOUBAO_APP to the installed Doubao.exe');
  const dataDir = env.DOUBAO_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir) || !fs.existsSync(dataDir)) throw new Error('Set DOUBAO_DATA_DIR to the Doubao User Data directory');
  return { cli, app, dataDir };
}

export async function runCli(args, { timeoutMs = 30_000, env = process.env, acceptNonZeroResult = () => false } = {}) {
  const config = cliConfig(env);
  const childEnv = {
    ...env,
    DOUBAO_APP: config.app,
    DOUBAO_DATA_DIR: config.dataDir,
    DOUBAO_CDP_ENDPOINT: env.DOUBAO_CDP_ENDPOINT || 'http://127.0.0.1:9225',
    DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1',
  };
  const commandArgs = [config.cli, '--app', 'doubao', ...args, '--json'];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4_000_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 100_000) child.kill(); });
    child.on('error', error => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch { return reject(new Error(code !== 0 ? (stderr || stdout || `doubao-cli exited ${code}`).trim().slice(0, 1000) : 'doubao-cli did not return valid JSON')); }
      if (code !== 0 && !acceptNonZeroResult(parsed, code)) {
        return reject(new Error((stderr || stdout || `doubao-cli exited ${code}`).trim().slice(0, 1000)));
      }
      resolve(parsed);
    });
  });
}

export function checkedWorkspace(workspace) {
  if (!path.isAbsolute(workspace) || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('workspace must be an existing absolute directory');
  }
  return path.resolve(workspace);
}
