/** 创建最终业务表结构；不包含 app_settings。 */
export function createNotesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      note_type           TEXT    NOT NULL DEFAULT 'one_time'
                          CHECK(note_type IN ('one_time')),
      content             TEXT    NOT NULL DEFAULT '',
      status              TEXT    NOT NULL DEFAULT 'initialized'
                          CHECK(status IN ('initialized','in_progress','completed')),
      is_deleted          INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      is_pinned           INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      notify_enabled      INTEGER NOT NULL DEFAULT 0 CHECK(notify_enabled IN (0, 1)),
      effective_at        INTEGER NOT NULL,
      finished_at         INTEGER,
      remind_again_at     INTEGER,
      sort_order          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
    CREATE INDEX IF NOT EXISTS idx_notes_effective_at ON notes(effective_at);
    CREATE INDEX IF NOT EXISTS idx_notes_is_pinned ON notes(is_pinned);
    CREATE INDEX IF NOT EXISTS idx_notes_status_pinned_sort ON notes(status, is_pinned, sort_order);
    CREATE INDEX IF NOT EXISTS idx_notes_remind_again_at ON notes(remind_again_at);
    CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted);

    CREATE TABLE IF NOT EXISTS note_templates (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      content                 TEXT    NOT NULL DEFAULT '',
      recurrence_rule         TEXT    NOT NULL,
      is_pinned               INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      notify_enabled          INTEGER NOT NULL DEFAULT 1 CHECK(notify_enabled IN (0, 1)),
      is_paused               INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0, 1)),
      is_deleted              INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      deleted_at              INTEGER,
      schedule_anchor_at      INTEGER NOT NULL,
      next_run_at             INTEGER,
      last_generated_at       INTEGER,
      last_generated_note_id  INTEGER REFERENCES notes(id) ON DELETE SET NULL,
      consecutive_failures    INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
      last_error              TEXT,
      last_failed_at          INTEGER,
      pause_reason            TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('manual', 'error')),
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_templates_due
      ON note_templates(is_deleted, is_paused, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_templates_last_note
      ON note_templates(last_generated_note_id);

    CREATE TABLE IF NOT EXISTS note_attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      file_path   TEXT    NOT NULL,
      file_size   INTEGER,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON note_attachments(note_id);

    CREATE TABLE IF NOT EXISTS tags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      color       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_name  TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_name ON note_tags(tag_name);

    CREATE TABLE IF NOT EXISTS template_tags (
      template_id  INTEGER NOT NULL REFERENCES note_templates(id) ON DELETE CASCADE,
      tag_name     TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
      PRIMARY KEY (template_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_template_tags_tag_name ON template_tags(tag_name);
  `)
}
