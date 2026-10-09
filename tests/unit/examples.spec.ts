import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROFILE, normalizeProfile, parseYamlSubset } from '../../src/profile.ts'
import { makeTask } from '../support/fixtures.ts'

type JsonObject = Record<string, unknown>

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readRepoFile(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8')
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonObject(relative: string): JsonObject {
  const value: unknown = JSON.parse(readRepoFile(relative))
  assert.ok(isObject(value), `${relative} must hold a JSON object`)
  return value
}

/** The names listed in a schema node's top-level "properties", sorted. */
function propertyNames(schema: JsonObject): string[] {
  assert.ok(isObject(schema.properties), 'schema node has no "properties"')
  return Object.keys(schema.properties).sort()
}

/** Every key of `value` is listed in the schema's "properties"; nested objects are checked the same way. */
function assertKeysDeclared(value: object, schema: JsonObject, path: string): void {
  const properties = schema.properties
  assert.ok(isObject(properties), `${path || 'root'}: schema node has no "properties"`)
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`
    assert.ok(Object.hasOwn(properties, key), `${childPath} is not declared in the schema "properties"`)
    if (isObject(child) && Object.keys(child).length > 0) {
      const childSchema = properties[key]
      assert.ok(isObject(childSchema), `${childPath}: schema node is missing`)
      assertKeysDeclared(child, childSchema, childPath)
    }
  }
}

/** Every key of `expected` (recursively for nested objects) is present in the parsed example. */
function assertHasEveryKey(actual: unknown, expected: object, path: string): void {
  assert.ok(isObject(actual), `${path || 'example'} must be a mapping`)
  for (const [key, value] of Object.entries(expected)) {
    const childPath = path === '' ? key : `${path}.${key}`
    assert.ok(Object.hasOwn(actual, key), `${childPath} is missing from the example`)
    if (isObject(value)) assertHasEveryKey(actual[key], value, childPath)
  }
}

const PROJECT_SCHEMA = 'schemas/project.schema.json'
const TASK_SCHEMA = 'schemas/task.schema.json'

describe('examples/project.yaml and examples/project.json', () => {
  it('project.yaml parses with zero warnings', () => {
    const { warnings } = normalizeProfile(parseYamlSubset(readRepoFile('examples/project.yaml')))
    assert.deepEqual(warnings, [])
  })

  it('project.json normalizes with zero warnings', () => {
    const { warnings } = normalizeProfile(JSON.parse(readRepoFile('examples/project.json')))
    assert.deepEqual(warnings, [])
  })

  it('project.yaml and project.json describe the same profile', () => {
    const fromYaml = normalizeProfile(parseYamlSubset(readRepoFile('examples/project.yaml'))).profile
    const fromJson = normalizeProfile(JSON.parse(readRepoFile('examples/project.json'))).profile
    assert.deepEqual(fromYaml, fromJson)
  })

  it('project.yaml sets every Profile field, so it doubles as a reference', () => {
    assertHasEveryKey(parseYamlSubset(readRepoFile('examples/project.yaml')), DEFAULT_PROFILE, '')
  })
})

describe('schemas/project.schema.json', () => {
  it('is JSON Schema draft 2020-12 with an $id', () => {
    const schema = readJsonObject(PROJECT_SCHEMA)
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(typeof schema.$id, 'string')
  })

  it('declares every DEFAULT_PROFILE key, recursively for nested objects', () => {
    assertKeysDeclared(DEFAULT_PROFILE, readJsonObject(PROJECT_SCHEMA), '')
  })

  it('lists exactly the top-level Profile fields', () => {
    assert.deepEqual(propertyNames(readJsonObject(PROJECT_SCHEMA)), Object.keys(DEFAULT_PROFILE).sort())
  })
})

describe('schemas/task.schema.json', () => {
  it('is JSON Schema draft 2020-12 with an $id', () => {
    const schema = readJsonObject(TASK_SCHEMA)
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(typeof schema.$id, 'string')
  })

  it('declares every makeTask() key', () => {
    assertKeysDeclared(makeTask(), readJsonObject(TASK_SCHEMA), '')
  })

  it('lists exactly the top-level Task fields', () => {
    assert.deepEqual(propertyNames(readJsonObject(TASK_SCHEMA)), Object.keys(makeTask()).sort())
  })
})
