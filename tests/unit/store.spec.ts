import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EWM_DIR,
  appendAudit,
  createTask,
  ensureWorkspace,
  joinPath,
  listTasks,
  loadLedger,
  loadTask,
  ledgerKey,
  nextTaskId,
  readArtifact,
  redactSecrets,
  saveLedger,
  saveTask,
  taskDir,
  trustedTask,
  updateLedgerEntry,
  writeArtifact,
} from '../../src/store.ts'
import { ARTIFACT_NAMES, EwmError } from '../../src/types.ts'
import type { Approval, ArtifactName, AuditEntry, Ledger, LedgerEntry, ValidationRun } from '../../src/types.ts'
import { createMemoryIo } from '../support/memory-io.ts'
import type { MemoryIo } from '../support/memory-io.ts'
import { AT, deepFreeze, makeProfile, makeTask } from '../support/fixtures.ts'

const ROOT = '/repo'
const TASKS = '/repo/.ewm/tasks'

/** Asserts that a call rejects (or throws) with an EwmError carrying `code` and an "ewm: " message. */
async function assertEwmError(call: () => unknown, code: string): Promise<EwmError> {
  let caught: unknown
  try {
    await call()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof EwmError, `expected EwmError(${code}) but got ${String(caught)}`)
  assert.equal(caught.code, code)
  assert.ok(caught.message.startsWith('ewm: '), `message should start with "ewm: ": ${caught.message}`)
  return caught
}

async function seedTask(io: MemoryIo, id: string, overrides: Parameters<typeof makeTask>[0] = {}): Promise<void> {
  await saveTask(io, ROOT, makeTask({ id, ...overrides }))
}

const INVALID_IDS = ['../x', 'TASK-1', 'task-001/../../etc', 'task-001', 'TASK-001/', 'TASK-001\n', 'TASK-0a1', '', ' TASK-001', 'TASK-001/../TASK-002']

// Secret-shaped test data is assembled at run time so this file never contains a literal that
// secret scanners (or push protection) would flag.
const fake = (...parts: string[]): string => parts.join('')
const GITHUB_TOKEN = fake('gh', 'p_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6')
const GITHUB_PAT = fake('github', '_pat_', '11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ0123456789')
const AWS_KEY = fake('AK', 'IA', 'IOSFODNN7EXAMPLE')
const SK_KEY = fake('s', 'k-', 'ant-api03-', 'AbCdEfGhIjKlMnOpQrStUvWx_yz0123456789')
const PEM_BEGIN = fake('-----BEGIN ', 'RSA PRIVATE KEY-----')
const PEM_END = fake('-----END ', 'RSA PRIVATE KEY-----')

describe('joinPath', () => {
  it('joins with single slashes, ignoring empty parts', () => {
    assert.equal(joinPath('/repo', '.ewm', 'tasks'), '/repo/.ewm/tasks')
    assert.equal(joinPath('a', '', 'b'), 'a/b')
    assert.equal(joinPath('', ''), '')
  })

  it('collapses duplicate slashes and keeps a leading slash', () => {
    assert.equal(joinPath('/repo/', '/.ewm//', 'x'), '/repo/.ewm/x')
    assert.equal(joinPath('/', 'repo'), '/repo')
    assert.equal(joinPath('/'), '/')
    assert.equal(joinPath('rel', 'path'), 'rel/path')
  })

  it('never resolves ".."', () => {
    assert.equal(joinPath('/repo', '../x'), '/repo/../x')
  })
})

describe('taskDir', () => {
  it('builds <root>/.ewm/tasks/<id>', () => {
    assert.equal(EWM_DIR, '.ewm')
    assert.equal(taskDir(ROOT, 'TASK-001'), '/repo/.ewm/tasks/TASK-001')
    assert.equal(taskDir('/repo/', 'TASK-1000'), '/repo/.ewm/tasks/TASK-1000')
  })

  it('rejects ids that are not TASK-NNN', async () => {
    for (const id of INVALID_IDS) await assertEwmError(() => taskDir(ROOT, id), 'invalid_id')
  })

  it('names the bad id and how to find a good one', async () => {
    const error = await assertEwmError(() => taskDir(ROOT, '../x'), 'invalid_id')
    assert.match(error.message, /"\.\.\/x"/)
    assert.match(error.message, /TASK-001/)
    assert.match(error.message, /\/ewm list/)
  })
})

describe('ensureWorkspace', () => {
  it('creates .ewm/.gitignore with exactly "tasks/\\n"', async () => {
    const io = createMemoryIo()
    await ensureWorkspace(io, ROOT)
    assert.equal(io.files.get('/repo/.ewm/.gitignore'), 'tasks/\n')
  })

  it('does not overwrite an existing .gitignore', async () => {
    const io = createMemoryIo({ '/repo/.ewm/.gitignore': 'tasks/\nproject.local.yaml\n' })
    await ensureWorkspace(io, ROOT)
    assert.equal(io.files.get('/repo/.ewm/.gitignore'), 'tasks/\nproject.local.yaml\n')
  })

  it('is safe to call twice and writes nothing else', async () => {
    const io = createMemoryIo()
    await ensureWorkspace(io, ROOT)
    await ensureWorkspace(io, ROOT)
    assert.deepEqual([...io.files.keys()], ['/repo/.ewm/.gitignore'])
  })
})

describe('nextTaskId', () => {
  it('is TASK-001 with no tasks, with or without a tasks directory', async () => {
    const io = createMemoryIo()
    assert.equal(await nextTaskId(io, ROOT), 'TASK-001')
    await ensureWorkspace(io, ROOT)
    assert.equal(await nextTaskId(io, ROOT), 'TASK-001')
  })

  it('follows the highest existing id, not the count', async () => {
    const io = createMemoryIo()
    await seedTask(io, 'TASK-001')
    assert.equal(await nextTaskId(io, ROOT), 'TASK-002')
    await seedTask(io, 'TASK-007')
    assert.equal(await nextTaskId(io, ROOT), 'TASK-008')
  })

  it('grows past three digits', async () => {
    const io = createMemoryIo()
    await seedTask(io, 'TASK-999')
    assert.equal(await nextTaskId(io, ROOT), 'TASK-1000')
    await seedTask(io, 'TASK-1000')
    assert.equal(await nextTaskId(io, ROOT), 'TASK-1001')
  })

  it('ignores junk entries in the tasks directory', async () => {
    const io = createMemoryIo({
      '/repo/.ewm/tasks/notes/readme.md': 'x',
      '/repo/.ewm/tasks/TASK-1/task.json': '{}',
      '/repo/.ewm/tasks/task-050/task.json': '{}',
      '/repo/.ewm/tasks/TASK-abc/task.json': '{}',
      '/repo/.ewm/tasks/TASK-0099x/task.json': '{}',
      '/repo/.ewm/tasks/TASK-090': 'a file, not a task directory',
      '/repo/.ewm/tasks/stray.txt': 'x',
    })
    await seedTask(io, 'TASK-003')
    assert.equal(await nextTaskId(io, ROOT), 'TASK-004')
  })

  it('reads zero-padded ids by value', async () => {
    const io = createMemoryIo({ '/repo/.ewm/tasks/TASK-0007/task.json': '{}' })
    assert.equal(await nextTaskId(io, ROOT), 'TASK-008')
  })
})

describe('createTask', () => {
  const input = {
    id: 'TASK-001',
    title: 'Investigate sum()',
    goal: 'Find why sum() is wrong',
    profile_id: 'default',
    repo: { root: '.', branch: 'main', base_commit: 'aaaaaaa' },
    at: AT,
    next_action: 'Confirm problem, goal and success criteria with the user.',
  }

  it('builds a fresh INTAKE task with empty collections', () => {
    assert.deepEqual(createTask(input), makeTask())
  })

  it('sets the identifying fields and timestamps from the input', () => {
    const task = createTask({ ...input, id: 'TASK-042', title: 'T', goal: 'G', profile_id: 'silicon-dv', at: '2026-01-02T03:04:05.000Z', next_action: 'Go.' })
    assert.equal(task.schema_version, 1)
    assert.equal(task.id, 'TASK-042')
    assert.equal(task.project_profile, 'silicon-dv')
    assert.equal(task.title, 'T')
    assert.equal(task.goal, 'G')
    assert.equal(task.phase, 'INTAKE')
    assert.equal(task.paused_from, null)
    assert.equal(task.mode, 'deep')
    assert.equal(task.system_map, null)
    assert.equal(task.plan, null)
    assert.equal(task.created_at, '2026-01-02T03:04:05.000Z')
    assert.equal(task.updated_at, '2026-01-02T03:04:05.000Z')
    assert.equal(task.next_action, 'Go.')
  })

  it('supports a repo without git information', () => {
    const task = createTask({ ...input, repo: { root: '.', branch: null, base_commit: null } })
    assert.deepEqual(task.repo, { root: '.', branch: null, base_commit: null })
  })

  it('does not alias its input or share collections between tasks', () => {
    const frozen = deepFreeze({ ...input, repo: { ...input.repo } })
    const a = createTask(frozen)
    const b = createTask(frozen)
    a.findings.length = 0
    a.repo.branch = 'changed'
    a.success_criteria.push('x')
    assert.deepEqual(b.success_criteria, [])
    assert.equal(b.repo.branch, 'main')
    assert.equal(frozen.repo.branch, 'main')
  })
})

describe('saveTask and loadTask', () => {
  it('round-trips a task deep-equal', async () => {
    const io = createMemoryIo()
    const task = makeTask({
      phase: 'PLAN',
      success_criteria: ['sum() adds'],
      findings: [
        {
          id: 'F-001',
          claim: 'sum() starts at 1',
          evidence: [{ path: 'src/sum.ts', line_start: 1, line_end: 3, note: 'init' }],
          confidence: 'high',
          open_questions: [],
          last_verified_commit: 'aaaaaaa',
          source: 'lead',
          stale: false,
          recorded_at: AT,
        },
      ],
      usage_by_phase: { EXPLORE: { turns: 2, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    })
    await saveTask(io, ROOT, task)
    assert.deepEqual(await loadTask(io, ROOT, 'TASK-001'), task)
  })

  it('writes pretty JSON with a trailing newline at <root>/.ewm/tasks/<id>/task.json', async () => {
    const io = createMemoryIo()
    const task = makeTask({ id: 'TASK-012' })
    await saveTask(io, ROOT, task)
    const text = io.files.get('/repo/.ewm/tasks/TASK-012/task.json')
    assert.equal(text, JSON.stringify(task, null, 2) + '\n')
    assert.ok(text?.startsWith('{\n  "schema_version": 1,\n'))
  })

  it('overwrites the previous version', async () => {
    const io = createMemoryIo()
    await saveTask(io, ROOT, makeTask())
    await saveTask(io, ROOT, makeTask({ phase: 'EXPLORE', updated_at: '2026-10-09T18:00:00.000Z' }))
    const loaded = await loadTask(io, ROOT, 'TASK-001')
    assert.equal(loaded.phase, 'EXPLORE')
    assert.equal(loaded.updated_at, '2026-10-09T18:00:00.000Z')
  })

  it('does not mutate the task it saves', async () => {
    const io = createMemoryIo()
    const task = deepFreeze(makeTask())
    await saveTask(io, ROOT, task)
    assert.deepEqual(task, makeTask())
  })

  it('rejects invalid ids on load and save', async () => {
    const io = createMemoryIo()
    for (const id of INVALID_IDS) {
      await assertEwmError(() => loadTask(io, ROOT, id), 'invalid_id')
      await assertEwmError(() => saveTask(io, ROOT, makeTask({ id })), 'invalid_id')
    }
    assert.equal(io.files.size, 0, 'nothing may be written for a rejected id')
  })

  it('reports not_found for a missing task and says how to proceed', async () => {
    const io = createMemoryIo()
    const error = await assertEwmError(() => loadTask(io, ROOT, 'TASK-005'), 'not_found')
    assert.match(error.message, /TASK-005/)
    assert.match(error.message, /\/ewm list/)
  })

  it('reports parse_error for corrupt JSON and for JSON that is not a task', async () => {
    const io = createMemoryIo({
      '/repo/.ewm/tasks/TASK-001/task.json': '{ "id": "TASK-001", ',
      '/repo/.ewm/tasks/TASK-002/task.json': '[]',
      '/repo/.ewm/tasks/TASK-003/task.json': 'null',
      '/repo/.ewm/tasks/TASK-004/task.json': JSON.stringify({ ...makeTask({ id: 'TASK-004' }), schema_version: 2 }),
      '/repo/.ewm/tasks/TASK-005/task.json': JSON.stringify(makeTask({ id: 'TASK-001' })),
    })
    for (const id of ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005']) {
      const error = await assertEwmError(() => loadTask(io, ROOT, id), 'parse_error')
      assert.match(error.message, new RegExp(`${EWM_DIR}/tasks/${id}/task\\.json`))
    }
  })
})

describe('listTasks', () => {
  it('is empty when there are no tasks', async () => {
    assert.deepEqual(await listTasks(createMemoryIo(), ROOT), [])
  })

  it('returns summaries sorted by numeric id', async () => {
    const io = createMemoryIo()
    await seedTask(io, 'TASK-010', { title: 'ten', phase: 'PLAN', updated_at: '2026-10-09T10:00:00.000Z' })
    await seedTask(io, 'TASK-002', { title: 'two' })
    await seedTask(io, 'TASK-1000', { title: 'thousand' })
    await seedTask(io, 'TASK-999', { title: 'nine nine nine', phase: 'DONE' })
    assert.deepEqual(await listTasks(io, ROOT), [
      { id: 'TASK-002', title: 'two', phase: 'INTAKE', updated_at: AT },
      { id: 'TASK-010', title: 'ten', phase: 'PLAN', updated_at: '2026-10-09T10:00:00.000Z' },
      { id: 'TASK-999', title: 'nine nine nine', phase: 'DONE', updated_at: AT },
      { id: 'TASK-1000', title: 'thousand', phase: 'INTAKE', updated_at: AT },
    ])
  })

  it('skips unreadable tasks and junk entries', async () => {
    const io = createMemoryIo({
      '/repo/.ewm/tasks/TASK-002/task.json': '{ not json',
      '/repo/.ewm/tasks/TASK-003/audit.jsonl': '',
      '/repo/.ewm/tasks/TASK-004/task.json': '[]',
      '/repo/.ewm/tasks/junk/task.json': '{}',
    })
    await seedTask(io, 'TASK-001')
    await seedTask(io, 'TASK-005')
    assert.deepEqual(
      (await listTasks(io, ROOT)).map(t => t.id),
      ['TASK-001', 'TASK-005'],
    )
  })

  it('lists only the given root', async () => {
    const io = createMemoryIo()
    await seedTask(io, 'TASK-001')
    await saveTask(io, '/other', makeTask({ id: 'TASK-007' }))
    assert.deepEqual(
      (await listTasks(io, '/other')).map(t => t.id),
      ['TASK-007'],
    )
  })
})

describe('writeArtifact and readArtifact', () => {
  it('round-trips content and returns the absolute path', async () => {
    const io = createMemoryIo()
    const path = await writeArtifact(io, ROOT, 'TASK-001', 'plan.md', '# Plan\n\n1. Step\n')
    assert.equal(path, '/repo/.ewm/tasks/TASK-001/plan.md')
    assert.equal(io.files.get(path), '# Plan\n\n1. Step\n')
    assert.equal(await readArtifact(io, ROOT, 'TASK-001', 'plan.md'), '# Plan\n\n1. Step\n')
  })

  it('overwrites, and an empty artifact reads back as an empty string', async () => {
    const io = createMemoryIo()
    await writeArtifact(io, ROOT, 'TASK-001', 'questions.md', 'old')
    await writeArtifact(io, ROOT, 'TASK-001', 'questions.md', '')
    assert.equal(await readArtifact(io, ROOT, 'TASK-001', 'questions.md'), '')
  })

  it('reads null for an artifact that was never written', async () => {
    const io = createMemoryIo()
    await seedTask(io, 'TASK-001')
    assert.equal(await readArtifact(io, ROOT, 'TASK-001', 'handoff.md'), null)
  })

  it('accepts every name in ARTIFACT_NAMES', async () => {
    const io = createMemoryIo()
    for (const name of ARTIFACT_NAMES) {
      const path = await writeArtifact(io, ROOT, 'TASK-001', name, name)
      assert.equal(path, `/repo/.ewm/tasks/TASK-001/${name}`)
      assert.equal(await readArtifact(io, ROOT, 'TASK-001', name), name)
    }
  })

  it('rejects names that are not artifacts', async () => {
    const io = createMemoryIo()
    for (const name of ['task.json', 'audit.jsonl', '../plan.md', 'notes.md', 'PLAN.md', 'plan.md/../task.json', '']) {
      const error = await assertEwmError(() => writeArtifact(io, ROOT, 'TASK-001', name as ArtifactName, 'x'), 'invalid_input')
      assert.match(error.message, /plan\.md/)
      await assertEwmError(() => readArtifact(io, ROOT, 'TASK-001', name as ArtifactName), 'invalid_input')
    }
    assert.equal(io.files.size, 0)
  })

  it('rejects invalid task ids', async () => {
    const io = createMemoryIo()
    for (const id of INVALID_IDS) {
      await assertEwmError(() => writeArtifact(io, ROOT, id, 'plan.md', 'x'), 'invalid_id')
      await assertEwmError(() => readArtifact(io, ROOT, id, 'plan.md'), 'invalid_id')
    }
    assert.equal(io.files.size, 0)
  })
})

describe('appendAudit', () => {
  const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({ at: AT, kind: 'transition', phase: 'EXPLORE', detail: 'INTAKE -> EXPLORE', ...overrides })
  const AUDIT = '/repo/.ewm/tasks/TASK-001/audit.jsonl'

  it('writes one JSON line for the first entry', async () => {
    const io = createMemoryIo()
    await appendAudit(io, ROOT, 'TASK-001', entry())
    assert.equal(io.files.get(AUDIT), JSON.stringify(entry()) + '\n')
  })

  it('appends one line per call and preserves earlier lines', async () => {
    const io = createMemoryIo()
    const entries = [
      entry(),
      entry({ kind: 'tool_denied', phase: 'EXPLORE', detail: 'Write denied', tool: 'Write' }),
      entry({ kind: 'validation_run', phase: 'VALIDATE', detail: 'npm test exit 0', commit: 'abc1234' }),
    ]
    let previous = ''
    for (const [index, item] of entries.entries()) {
      await appendAudit(io, ROOT, 'TASK-001', item)
      const text = io.files.get(AUDIT) ?? ''
      assert.ok(text.startsWith(previous), 'earlier lines must be preserved byte for byte')
      assert.equal(text.split('\n').length, index + 2, 'one line per call plus the trailing newline')
      previous = text
    }
    assert.deepEqual(
      (io.files.get(AUDIT) ?? '')
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line)),
      entries,
    )
  })

  it('redacts secrets in the detail and leaves the other fields alone', async () => {
    const io = createMemoryIo()
    await appendAudit(io, ROOT, 'TASK-001', entry({ kind: 'tool_denied', detail: `curl -H "Authorization: Bearer abcdefghij12345" API_KEY=hunter2hunter2 ${AWS_KEY}`, tool: 'Bash' }))
    const written = JSON.parse((io.files.get(AUDIT) ?? '').trim())
    assert.equal(written.detail, 'curl -H "Authorization: Bearer [REDACTED]" API_KEY=[REDACTED] [REDACTED]')
    assert.equal(written.tool, 'Bash')
    assert.equal(written.kind, 'tool_denied')
    assert.doesNotMatch(io.files.get(AUDIT) ?? '', /hunter2|abcdefghij12345|AKIA/)
  })

  it('does not mutate the entry it is given', async () => {
    const io = createMemoryIo()
    const frozen = deepFreeze(entry({ detail: 'TOKEN=abc123' }))
    await appendAudit(io, ROOT, 'TASK-001', frozen)
    assert.equal(frozen.detail, 'TOKEN=abc123')
  })

  it('never glues a new entry onto an unterminated last line', async () => {
    const io = createMemoryIo({ [AUDIT]: '{"at":"x"}' })
    await appendAudit(io, ROOT, 'TASK-001', entry())
    assert.equal(io.files.get(AUDIT), '{"at":"x"}\n' + JSON.stringify(entry()) + '\n')
  })

  it('keeps audit logs per task and rejects invalid ids', async () => {
    const io = createMemoryIo()
    await appendAudit(io, ROOT, 'TASK-001', entry())
    await appendAudit(io, ROOT, 'TASK-002', entry({ detail: 'other' }))
    assert.equal((io.files.get(AUDIT) ?? '').trim().split('\n').length, 1)
    assert.equal((io.files.get('/repo/.ewm/tasks/TASK-002/audit.jsonl') ?? '').trim().split('\n').length, 1)
    for (const id of INVALID_IDS) await assertEwmError(() => appendAudit(io, ROOT, id, entry()), 'invalid_id')
    assert.equal(io.files.size, 2)
  })
})

describe('redactSecrets', () => {
  const redacted = '[REDACTED]'

  it('masks KEY=value for every sensitive name word', () => {
    const names = ['MY_SECRET', 'GITHUB_TOKEN', 'DB_PASSWORD', 'DB_PASSWD', 'OPENAI_API_KEY', 'api-key', 'apikey', 'AUTH_HEADER', 'AWS_CREDENTIALS', 'PRIVATE_KEY', 'private-key', 'Token']
    for (const name of names) {
      assert.equal(redactSecrets(`${name}=s3cr3tvalue`), `${name}=${redacted}`, name)
    }
  })

  it('masks quoted and flag-style assignments and keeps the rest of the line', () => {
    assert.equal(redactSecrets('API_KEY=abc123 npm test'), `API_KEY=${redacted} npm test`)
    assert.equal(redactSecrets('export DB_PASSWORD="two words" && run'), `export DB_PASSWORD=${redacted} && run`)
    assert.equal(redactSecrets("TOKEN='single quoted' next"), `TOKEN=${redacted} next`)
    assert.equal(redactSecrets('cli --password=hunter2 --user=bob'), `cli --password=${redacted} --user=bob`)
    assert.equal(redactSecrets('GET /x?access_token=abc.def&page=2'), `GET /x?access_token=${redacted}&page=2`)
    assert.equal(redactSecrets('spring.datasource.password=pw1\nOTHER=1'), `spring.datasource.password=${redacted}\nOTHER=1`)
  })

  it('masks "key": "value" pairs with sensitive names, JSON or Python style', () => {
    assert.equal(redactSecrets('{"api_key": "abc", "name": "ewm"}'), `{"api_key": "${redacted}", "name": "ewm"}`)
    assert.equal(redactSecrets('{"password":"p\\"q","user":"u"}'), `{"password":"${redacted}","user":"u"}`)
    assert.equal(redactSecrets("{'client_secret': 'xyz'}"), `{'client_secret': '${redacted}'}`)
    assert.equal(redactSecrets('{"Authorization" = "Basic dXNlcjpwdw=="}'), `{"Authorization" = "${redacted}"}`)
    // The redacted output is still valid JSON.
    assert.deepEqual(JSON.parse(redactSecrets('{"token": "t", "n": 1}')), { token: redacted, n: 1 })
  })

  it('masks bearer tokens', () => {
    assert.equal(redactSecrets('Authorization: Bearer eyJhbGciOi.payload.sig'), `Authorization: Bearer ${redacted}`)
    assert.equal(redactSecrets('curl -H "authorization: bearer abcDEF1234567890=="'), `curl -H "authorization: bearer ${redacted}"`)
  })

  it('masks AWS access keys', () => {
    assert.equal(redactSecrets(`found ${AWS_KEY} in env`), `found ${redacted} in env`)
    assert.equal(redactSecrets(`aws_access_key_id ${fake('AS', 'IA', 'ABCDEFGHIJKLMNOP')}`), `aws_access_key_id ${redacted}`)
  })

  it('masks GitHub tokens', () => {
    assert.equal(redactSecrets(`git clone https://x:${GITHUB_TOKEN}@github.com/o/r`), `git clone https://x:${redacted}@github.com/o/r`)
    assert.equal(redactSecrets(`pat ${GITHUB_PAT}.`), `pat ${redacted}.`)
    for (const kind of ['o', 'u', 's', 'r']) {
      assert.equal(redactSecrets(fake('gh', kind, '_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6')), redacted, `gh${kind}_`)
    }
  })

  it('masks sk- API keys', () => {
    assert.equal(redactSecrets(`key is ${SK_KEY}!`), `key is ${redacted}!`)
    assert.equal(redactSecrets(fake('s', 'k-', 'abcdefghijklmnopqrstuvwx')), redacted)
  })

  it('masks a whole PEM private key block and keeps the surrounding text', () => {
    const block = `${PEM_BEGIN}\nMIIEowIBAAKCAQEA\nabcdefg+/==\n${PEM_END}`
    assert.equal(redactSecrets(`before\n${block}\nafter`), `before\n${redacted}\nafter`)
    assert.equal(redactSecrets(`${fake('-----BEGIN ', 'PRIVATE KEY-----')}\nabc\n${fake('-----END ', 'PRIVATE KEY-----')}`), redacted)
    assert.equal(redactSecrets(`${fake('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')}\nabc\n${fake('-----END ', 'OPENSSH PRIVATE KEY-----')}!`), `${redacted}!`)
  })

  it('masks a PEM block whose end was cut off', () => {
    assert.equal(redactSecrets(`log\n${PEM_BEGIN}\nMIIEowIBAAKCAQEA\nabc`), `log\n${redacted}`)
  })

  it('masks several secrets in one string', () => {
    const input = `TOKEN=a1 ${AWS_KEY} {"password": "p"} Bearer abcdefgh123 ${GITHUB_TOKEN}`
    assert.equal(redactSecrets(input), `TOKEN=${redacted} ${redacted} {"password": "${redacted}"} Bearer ${redacted} ${redacted}`)
  })

  it('is idempotent', () => {
    const input = `API_KEY=abc "token": "t" Bearer abcdefgh123 ${AWS_KEY} ${PEM_BEGIN}\nx\n${PEM_END} PASSWORD="a b"`
    const once = redactSecrets(input)
    assert.equal(redactSecrets(once), once)
  })

  it('leaves ordinary commands and prose unchanged', () => {
    for (const text of [
      'ls -la /repo && git status --short',
      'npm test -- --grep "sum adds"',
      'The token ring protocol passes a token around; Bearer tokens are short.',
      'The password policy is documented in docs/security.md.',
      '',
    ]) {
      assert.equal(redactSecrets(text), text)
    }
  })

  it('leaves assignments and pairs with harmless names unchanged', () => {
    for (const text of [
      'NODE_ENV=production PORT=8080 CI=true',
      '{"name": "ewm", "version": "1.0.0", "nested": {"debug": "yes"}}',
      'user.name=Jane email=jane@example.com --max-depth=3 ?page=2&sort=asc',
    ]) {
      assert.equal(redactSecrets(text), text)
    }
  })

  it('leaves near-miss secret shapes unchanged', () => {
    for (const text of [
      'task-abcdefghijklmnopqrstuvwxyz0123',
      `${fake('AK', 'IA')}123 is too short and ${fake('gh', 'p_')}short too, as is ${fake('s', 'k-')}short`,
      'Bearer abc',
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      '"token_count": 5, "tokens": 12',
    ]) {
      assert.equal(redactSecrets(text), text)
    }
  })

  it('keeps long runs of ordinary text fast', () => {
    const long = 'a=b '.repeat(20000) + 'x'.repeat(100000)
    const started = Date.now()
    assert.equal(redactSecrets(long), long)
    assert.ok(Date.now() - started < 2000, 'redaction should be linear-ish')
  })
})

describe('gate ledger', () => {
  const approval = (overrides: Partial<Approval> = {}): Approval => ({
    gate: 'plan_approval',
    decision: 'approved',
    by: 'user',
    via: 'command',
    at: AT,
    plan_hash: 'abc12345',
    ...overrides,
  })
  const run = (overrides: Partial<ValidationRun> = {}): ValidationRun => ({
    id: 'V-001',
    command: 'npm test',
    exit_code: 0,
    ok: true,
    duration_ms: 1200,
    output_tail: 'pass',
    commit: 'aaaaaaa',
    at: AT,
    ...overrides,
  })
  const init = { profile: makeProfile(), profile_source: '.ewm/project.yaml' as string | null }
  const identity = (entry: LedgerEntry): LedgerEntry => entry

  describe('loadLedger and saveLedger', () => {
    it('uses the key "ledger:<root>"', () => {
      assert.equal(ledgerKey('/repo'), 'ledger:/repo')
      assert.equal(ledgerKey('/a/b'), 'ledger:/a/b')
    })

    it('returns an empty ledger for the root when nothing is stored', async () => {
      const io = createMemoryIo()
      assert.deepEqual(await loadLedger(io, ROOT), { version: 1, root: ROOT, active_task: null, tasks: {} })
      assert.deepEqual(await loadLedger(io, '/other'), { version: 1, root: '/other', active_task: null, tasks: {} })
      assert.equal(io.kv.size, 0, 'loading must not write')
    })

    it('treats a stored null like a missing ledger', async () => {
      const io = createMemoryIo()
      await io.kvSet(ledgerKey(ROOT), null)
      assert.deepEqual(await loadLedger(io, ROOT), { version: 1, root: ROOT, active_task: null, tasks: {} })
    })

    it('round-trips through kvSet and kvGet', async () => {
      const io = createMemoryIo()
      const ledger = updateLedgerEntry(
        { version: 1, root: ROOT, active_task: 'TASK-001', tasks: {} },
        'TASK-001',
        entry => ({
          ...entry,
          approvals: [approval()],
          validations: [{ id: 'V-001', command: 'npm test', exit_code: 0, ok: true, at: AT }],
        }),
        init,
      )
      await saveLedger(io, ROOT, ledger)
      assert.deepEqual(await io.kvGet(ledgerKey(ROOT)), ledger)
      assert.deepEqual(await loadLedger(io, ROOT), ledger)
    })

    it('keeps ledgers of different roots apart', async () => {
      const io = createMemoryIo()
      await saveLedger(io, ROOT, { version: 1, root: ROOT, active_task: 'TASK-001', tasks: {} })
      assert.equal((await loadLedger(io, '/other')).active_task, null)
      assert.equal((await loadLedger(io, ROOT)).active_task, 'TASK-001')
    })

    it('does not touch the task files', async () => {
      const io = createMemoryIo()
      await saveLedger(io, ROOT, { version: 1, root: ROOT, active_task: null, tasks: {} })
      assert.equal(io.files.size, 0)
    })

    const goodEntry = (): LedgerEntry => ({ approvals: [approval()], validations: [{ id: 'V-001', command: 'npm test', exit_code: 0, ok: true, at: AT }], profile: makeProfile(), profile_source: null })
    const base = (): Record<string, unknown> => ({ version: 1, root: ROOT, active_task: null, tasks: {} })
    const malformed: [string, unknown][] = [
      ['a string', 'garbage'],
      ['a number', 7],
      ['an array', []],
      ['an unsupported version', { ...base(), version: 2 }],
      ['a missing version', { root: ROOT, active_task: null, tasks: {} }],
      ['another root', { ...base(), root: '/other' }],
      ['a path-like active task', { ...base(), active_task: '../x' }],
      ['a numeric active task', { ...base(), active_task: 1 }],
      ['tasks that is an array', { ...base(), tasks: [] }],
      ['a task key that is not an id', { ...base(), tasks: { 'task-1': goodEntry() } }],
      ['an entry that is not an object', { ...base(), tasks: { 'TASK-001': 'x' } }],
      ['an entry without a profile', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), profile: undefined } } }],
      ['an entry with an incomplete profile', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), profile: { ...makeProfile(), policies: {} } } } }],
      ['an entry with an unknown network policy', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), profile: { ...makeProfile(), policies: { ...makeProfile().policies, external_network: 'sometimes' } } } } }],
      ['approvals that is not a list', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), approvals: {} } } }],
      ['an approval for an unknown gate', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), approvals: [{ ...approval(), gate: 'merge' }] } } }],
      ['an approval by the model', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), approvals: [{ ...approval(), by: 'model' }] } } }],
      ['a null approval', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), approvals: [null] } } }],
      ['a validation without an exit code', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), validations: [{ id: 'V-001', command: 'x', ok: true, at: AT }] } } }],
      ['a profile_source that is a number', { ...base(), tasks: { 'TASK-001': { ...goodEntry(), profile_source: 3 } } }],
    ]
    for (const [label, value] of malformed) {
      it(`rejects a malformed ledger: ${label}`, async () => {
        const io = createMemoryIo()
        await io.kvSet(ledgerKey(ROOT), value)
        const error = await assertEwmError(() => loadLedger(io, ROOT), 'parse_error')
        assert.match(error.message, /ledger/)
        assert.match(error.message, /fails closed/)
      })
    }

    it('accepts a well-formed ledger with several tasks', async () => {
      const io = createMemoryIo()
      await io.kvSet(ledgerKey(ROOT), { ...base(), active_task: 'TASK-002', tasks: { 'TASK-001': goodEntry(), 'TASK-002': { ...goodEntry(), profile_source: '.ewm/project.yaml' } } })
      const ledger = await loadLedger(io, ROOT)
      assert.equal(ledger.active_task, 'TASK-002')
      assert.deepEqual(Object.keys(ledger.tasks), ['TASK-001', 'TASK-002'])
    })
  })

  describe('updateLedgerEntry', () => {
    const empty = (): Ledger => ({ version: 1, root: ROOT, active_task: null, tasks: {} })

    it('creates the entry from the profile when it does not exist', () => {
      const updated = updateLedgerEntry(empty(), 'TASK-001', identity, init)
      assert.deepEqual(updated.tasks['TASK-001'], { approvals: [], validations: [], profile: makeProfile(), profile_source: '.ewm/project.yaml' })
    })

    it('passes the created entry to fn', () => {
      const updated = updateLedgerEntry(empty(), 'TASK-001', entry => ({ ...entry, approvals: [...entry.approvals, approval()] }), init)
      assert.deepEqual(updated.tasks['TASK-001']?.approvals, [approval()])
      assert.deepEqual(updated.tasks['TASK-001']?.profile, makeProfile())
    })

    it('updates an existing entry and ignores init for it', () => {
      const first = updateLedgerEntry(empty(), 'TASK-001', entry => ({ ...entry, approvals: [approval()] }), init)
      const other = { profile: makeProfile({ name: 'Other' }), profile_source: null }
      const second = updateLedgerEntry(first, 'TASK-001', entry => ({ ...entry, validations: [{ id: 'V-001', command: 'npm test', exit_code: 0, ok: true, at: AT }] }), other)
      const entry = second.tasks['TASK-001']
      assert.deepEqual(entry?.approvals, [approval()])
      assert.equal(entry?.validations.length, 1)
      assert.equal(entry?.profile.name, 'Default')
      assert.equal(entry?.profile_source, '.ewm/project.yaml')
    })

    it('can replace the profile snapshot through fn', () => {
      const first = updateLedgerEntry(empty(), 'TASK-001', identity, init)
      const second = updateLedgerEntry(first, 'TASK-001', entry => ({ ...entry, profile: makeProfile({ name: 'Reloaded' }), profile_source: null }), init)
      assert.equal(second.tasks['TASK-001']?.profile.name, 'Reloaded')
      assert.equal(second.tasks['TASK-001']?.profile_source, null)
    })

    it('does not mutate its input, even when fn modifies the entry it receives', () => {
      const original = deepFreeze(updateLedgerEntry({ version: 1, root: ROOT, active_task: 'TASK-001', tasks: {} }, 'TASK-001', entry => ({ ...entry, approvals: [approval()] }), init))
      const snapshot = JSON.parse(JSON.stringify(original))
      const updated = updateLedgerEntry(original, 'TASK-001', entry => ({ ...entry, validations: [{ id: 'V-001', command: 'x', exit_code: 0, ok: true, at: AT }] }), init)
      assert.deepEqual(original, snapshot)
      assert.notEqual(updated, original)
      assert.equal(updated.tasks['TASK-001']?.validations.length, 1)

      // A fn that mutates in place must not leak into the input either.
      const loose: Ledger = JSON.parse(JSON.stringify(snapshot))
      updateLedgerEntry(
        loose,
        'TASK-001',
        entry => {
          entry.approvals.push(approval({ decision: 'rejected' }))
          entry.profile.name = 'Mutated'
          return entry
        },
        init,
      )
      assert.deepEqual(loose, snapshot)
    })

    it('does not mutate or alias init', () => {
      const frozenInit = deepFreeze({ profile: makeProfile(), profile_source: null as string | null })
      const updated = updateLedgerEntry(empty(), 'TASK-001', identity, frozenInit)
      const profile = updated.tasks['TASK-001']?.profile
      assert.ok(profile)
      assert.notEqual(profile, frozenInit.profile)
      profile.domains.push('x')
      assert.deepEqual(frozenInit.profile.domains, [])
    })

    it('keeps other entries and the active pointer', () => {
      const a = updateLedgerEntry({ version: 1, root: ROOT, active_task: 'TASK-002', tasks: {} }, 'TASK-001', identity, init)
      const b = updateLedgerEntry(a, 'TASK-002', entry => ({ ...entry, approvals: [approval()] }), init)
      assert.equal(b.active_task, 'TASK-002')
      assert.equal(b.root, ROOT)
      assert.deepEqual(Object.keys(b.tasks), ['TASK-001', 'TASK-002'])
      assert.deepEqual(b.tasks['TASK-001'], a.tasks['TASK-001'])
    })

    it('rejects ids that are not task ids', async () => {
      for (const id of ['__proto__', 'constructor', '../x', 'TASK-1', '']) {
        await assertEwmError(() => updateLedgerEntry(empty(), id, identity, init), 'invalid_id')
      }
    })
  })

  describe('trustedTask', () => {
    const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
      approvals: [],
      validations: [],
      profile: makeProfile(),
      profile_source: null,
      ...overrides,
    })

    it('replaces the approvals of the task with the ledger approvals', () => {
      const task = makeTask({ approvals: [approval({ at: 'task-copy' })] })
      const trusted = trustedTask(task, entry({ approvals: [approval({ gate: 'done_acceptance', plan_hash: undefined })] }))
      assert.deepEqual(trusted.approvals, [approval({ gate: 'done_acceptance', plan_hash: undefined })])
    })

    it('drops a forged approval that only the task file claims', () => {
      const forged = makeTask({ approvals: [approval(), approval({ gate: 'done_acceptance' })] })
      assert.deepEqual(trustedTask(forged, entry()).approvals, [])
      assert.deepEqual(trustedTask(forged, undefined).approvals, [])
    })

    it('keeps only validations whose id and exit code are in the ledger', () => {
      const genuine = run({ id: 'V-001' })
      const failed = run({ id: 'V-002', exit_code: 1, ok: false })
      const forgedId = run({ id: 'V-003' })
      const forgedExit = run({ id: 'V-004', exit_code: 0, ok: true })
      const task = makeTask({ validations: [genuine, failed, forgedId, forgedExit] })
      const trusted = trustedTask(
        task,
        entry({
          validations: [
            { id: 'V-001', command: 'npm test', exit_code: 0, ok: true, at: AT },
            { id: 'V-002', command: 'npm test', exit_code: 1, ok: false, at: AT },
            { id: 'V-004', command: 'npm test', exit_code: 2, ok: false, at: AT },
          ],
        }),
      )
      assert.deepEqual(trusted.validations, [genuine, failed])
    })

    it('trusts nothing without a ledger entry', () => {
      const task = makeTask({ approvals: [approval()], validations: [run()] })
      const trusted = trustedTask(task, undefined)
      assert.deepEqual(trusted.approvals, [])
      assert.deepEqual(trusted.validations, [])
    })

    it('keeps every other field of the task', () => {
      const task = makeTask({ phase: 'VALIDATE', title: 'Keep me', approvals: [approval()], validations: [run()] })
      const trusted = trustedTask(task, entry({ validations: [{ id: 'V-001', command: 'npm test', exit_code: 0, ok: true, at: AT }] }))
      assert.deepEqual({ ...trusted, approvals: [], validations: [] }, { ...task, approvals: [], validations: [] })
      assert.deepEqual(trusted.validations, [run()])
    })

    it('does not mutate the task or the ledger entry, and shares no approval objects', () => {
      const task = deepFreeze(makeTask({ approvals: [approval()], validations: [run()] }))
      const ledgerEntry = deepFreeze(entry({ approvals: [approval()], validations: [{ id: 'V-001', command: 'npm test', exit_code: 0, ok: true, at: AT }] }))
      const trusted = trustedTask(task, ledgerEntry)
      assert.notEqual(trusted, task)
      assert.notEqual(trusted.approvals[0], ledgerEntry.approvals[0])
      assert.equal(task.approvals.length, 1)
      assert.equal(ledgerEntry.approvals.length, 1)
    })
  })
})
