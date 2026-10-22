import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runCli, checkedWorkspace } from './cli.mjs';

const server = new McpServer({ name: 'codex-doubao-desktop-gateway', version: '0.1.0' });
const id = z.string().regex(/^\d{12,24}$/);
const permission = z.enum(['AlwaysAsk', 'AskOnRisk', 'FullAccess']).default('AskOnRisk');
const waitSeconds = z.number().int().min(1).max(180).default(120);
const workspaceByConversation = new Map();

function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function tool(action) {
  return async input => {
    try { return result(await action(input)); }
    catch (error) { return { ...result({ ok: false, error: error.message }), isError: true }; }
  };
}

async function waitForRun({ conversationId, runId, timeoutSeconds }) {
  return runCli([
    'sessions', 'wait', conversationId, '--run', runId, '--timeout', String(timeoutSeconds),
  ], {
    timeoutMs: (timeoutSeconds + 10) * 1000,
    acceptNonZeroResult: isPendingWaitResult,
  });
}

function waitResult(value) {
  const pending = value?.status === 'running' && !value.reply
    || value?.status === 'unknown' && !value.reply && ['timeout', 'task_unavailable'].includes(value.error);
  return pending ? { ...value, pending: true } : value;
}

function isPendingWaitResult(value) {
  return value?.status === 'running' && !value.reply
    || value?.status === 'unknown' && !value.reply && ['timeout', 'task_unavailable'].includes(value.error);
}

function submittedRun(createResult) {
  const { conversationId, runId } = createResult || {};
  if (!conversationId || !runId) {
    throw new Error('Doubao did not return a conversationId and runId for the submitted task');
  }
  return { conversationId, runId };
}

server.tool('doubao_desktop_status', 'Check whether the localhost CDP endpoint belongs to the Doubao desktop app. Does not restart it.', {}, tool(async () => runCli(['cdp', 'status'])));
server.tool('doubao_desktop_sessions', 'List existing Doubao desktop conversations. Treat titles and messages as private user data.', {}, tool(async () => runCli(['sessions', 'list'])));
server.tool('doubao_desktop_create_task', 'Send a new task to a real Doubao desktop conversation in an existing local workspace. Returns conversationId and runId; inspect task result independently.', {
  objective: z.string().min(1).max(50_000),
  workspace: z.string().min(1),
  permission,
  newConversation: z.literal(true).default(true),
}, tool(async ({ objective, workspace, permission, newConversation }) => {
  if (!newConversation) throw new Error('create_task always starts a new Doubao conversation');
  const workspacePath = checkedWorkspace(workspace);
  const result = await runCli([
    'sessions', 'create', objective, '--runtime', 'local', '--workspace', workspacePath, '--permission', permission,
  ], { timeoutMs: 60_000 });
  if (result?.conversationId) workspaceByConversation.set(workspacePath, result.conversationId);
  return result;
}));
server.tool('doubao_desktop_create_and_wait', 'Send a task to Doubao and wait for its reply in one call. Set newConversation=true on the first call for a workbench conversation to bypass a remembered workspace conversation; later calls must pass that conversationId. Running or unconfirmed results include IDs for continuing to wait; an unconfirmed result does not mean the task was cancelled.', {
  objective: z.string().min(1).max(50_000),
  workspace: z.string().min(1),
  conversationId: id.optional(),
  permission,
  newConversation: z.boolean().default(false),
  timeoutSeconds: waitSeconds,
}, tool(async ({ objective, workspace, conversationId, permission, newConversation, timeoutSeconds }) => {
  const workspacePath = checkedWorkspace(workspace);
  if (newConversation && conversationId) throw new Error('newConversation cannot be combined with conversationId');
  const existingConversationId = newConversation ? undefined : conversationId || workspaceByConversation.get(workspacePath);
  if (existingConversationId) {
    const result = await runCli([
      'sessions', 'send', existingConversationId, objective, '--runtime', 'local', '--permission', permission,
      '--wait', '--timeout', String(timeoutSeconds),
    ], {
      timeoutMs: (timeoutSeconds + 10) * 1000,
      acceptNonZeroResult: isPendingWaitResult,
    });
    const runId = result?.runId;
    if (!runId) throw new Error('Doubao did not return a runId for the continued task');
    workspaceByConversation.set(workspacePath, existingConversationId);
    return { ...waitResult(result), conversationId: existingConversationId, runId, continued: true, reused: true };
  }
  const result = await runCli([
    'sessions', 'create', objective, '--runtime', 'local', '--workspace', workspacePath, '--permission', permission,
    '--wait', '--timeout', String(timeoutSeconds),
  ], {
    timeoutMs: (timeoutSeconds + 10) * 1000,
    acceptNonZeroResult: isPendingWaitResult,
  });
  const { conversationId: createdConversationId, runId } = submittedRun(result);
  workspaceByConversation.set(workspacePath, createdConversationId);
  return { ...waitResult(result), conversationId: createdConversationId, runId, created: true };
}));
server.tool('doubao_desktop_continue_task', 'Send a follow-up to a specified existing Doubao desktop conversation. Does not choose a conversation automatically.', {
  conversationId: id,
  message: z.string().min(1).max(50_000),
  permission,
}, tool(async ({ conversationId, message, permission }) => runCli([
  'sessions', 'send', conversationId, message, '--runtime', 'local', '--permission', permission,
], { timeoutMs: 60_000 })));
server.tool('doubao_desktop_continue_and_wait', 'Send a follow-up to a specified Doubao conversation and wait for its reply in one call. Running or unconfirmed results include IDs for continuing to wait; an unconfirmed result does not mean the task was cancelled.', {
  conversationId: id,
  message: z.string().min(1).max(50_000),
  permission,
  timeoutSeconds: waitSeconds,
}, tool(async ({ conversationId, message, permission, timeoutSeconds }) => {
  const result = await runCli([
    'sessions', 'send', conversationId, message, '--runtime', 'local', '--permission', permission,
    '--wait', '--timeout', String(timeoutSeconds),
  ], {
    timeoutMs: (timeoutSeconds + 10) * 1000,
    acceptNonZeroResult: isPendingWaitResult,
  });
  const runId = result?.runId;
  if (!runId) throw new Error('Doubao did not return a runId for the submitted follow-up');
  return { ...waitResult(result), conversationId, runId, continued: true };
}));
server.tool('doubao_desktop_wait', 'Wait for an already submitted desktop run. Running or unconfirmed results mean the task was not confirmed complete or cancelled; retry waiting with the same IDs instead of resending the task.', {
  conversationId: id,
  runId: id,
  timeoutSeconds: waitSeconds,
}, tool(async ({ conversationId, runId, timeoutSeconds }) => waitResult(await waitForRun({ conversationId, runId, timeoutSeconds }))));
server.tool('doubao_desktop_stop', 'Stop a submitted Doubao desktop run. It does not undo completed file or tool effects.', {
  conversationId: id,
  runId: id,
}, tool(async ({ conversationId, runId }) => runCli([
  'sessions', 'stop', conversationId, '--run', runId,
], { timeoutMs: 45_000 })));
server.tool('doubao_desktop_read', 'Read messages from a specified Doubao desktop conversation.', {
  conversationId: id,
  limit: z.number().int().min(1).max(100).default(20),
}, tool(async ({ conversationId, limit }) => runCli([
  'sessions', 'read', conversationId, '--limit', String(limit),
], { timeoutMs: 45_000 })));

await server.connect(new StdioServerTransport());
