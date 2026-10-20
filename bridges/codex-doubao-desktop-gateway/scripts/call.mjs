#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [name, raw = '{}'] = process.argv.slice(2);
if (!name?.startsWith('doubao_desktop_')) throw new Error('Usage: node scripts/call.mjs doubao_desktop_<tool> <JSON>');
const args = JSON.parse(raw);
const client = new Client({ name: 'doubao-desktop-smoke', version: '0.1.0' });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs')], cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), stderr: 'inherit' });
try {
  await client.connect(transport);
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  for (const item of response.content || []) if (item.type === 'text') process.stdout.write(item.text + '\n');
  if (response.isError) process.exitCode = 1;
} finally { await client.close(); }
