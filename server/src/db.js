import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const instances = new Map()

export function openDb(filename = process.env.FEEDBACK_DB || path.join(__dirname, '..', 'data', 'feedback.db')) {
  if (instances.has(filename)) return instances.get(filename)
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const schema = readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8')
  db.exec(schema)
  instances.set(filename, db)
  return db
}

export function resetDbInstance() {
  for (const db of instances.values()) {
    if (typeof db.close === 'function') db.close()
  }
  instances.clear()
}
