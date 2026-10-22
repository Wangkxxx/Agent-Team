import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('workspace browser lists only folders and rejects invalid paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-'))
  const workspace = join(root, '项目 with spaces')
  await mkdir(join(workspace, 'child'), { recursive: true })
  await writeFile(join(workspace, 'note.txt'), 'not a directory')
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], {
    env: { ...process.env, TEAM_PORT: '4193', TEAM_DATA_DIR: join(root, 'state') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  server.stderr.on('data', chunk => { logs += chunk })
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch('http://127.0.0.1:4193/api/runs')).ok) { ready = true; break } } catch {}
      await new Promise(r => setTimeout(r, 50))
    }
    assert(ready, 'Test server starts: ' + logs)
    const browse = path => fetch('http://127.0.0.1:4193/api/workspace/folders?path=' + encodeURIComponent(path))
    const response = await browse(workspace)
    assert.equal(response.status, 200)
    const listing = await response.json()
    assert.equal(listing.path, resolve(workspace))
    assert.equal(listing.parent, dirname(workspace))
    assert.deepEqual(listing.folders, [{ name: 'child', path: join(workspace, 'child') }])
    assert.equal((await browse(join(workspace, 'note.txt'))).status, 400)
    assert.equal((await browse('relative/path')).status, 400)
    assert.equal((await browse('')).status, 200)
    assert.equal((await fetch('http://127.0.0.1:4193/api/runs')).status, 200)
  } finally {
    if (server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('exit', resolve))
      server.kill(); await stopped
    }
    await rm(root, { recursive: true, force: true })
  }
})
