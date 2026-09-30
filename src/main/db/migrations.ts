import type { Database } from 'better-sqlite3'
import { newId } from './ids'

export interface Migration {
  id: number
  name: string
  up: (db: Database) => void
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('google', 'resend')),
          email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          color TEXT NOT NULL,
          resend_domain_id TEXT,
          resend_region TEXT,
          receiving_enabled INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'ok',
          history_id TEXT,
          initial_sync_done INTEGER NOT NULL DEFAULT 0,
          notifications_enabled INTEGER NOT NULL DEFAULT 1,
          last_synced_at INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE (kind, email)
        );

        CREATE TABLE labels (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          remote_id TEXT NOT NULL,
          name TEXT NOT NULL,
          parent_id TEXT,
          type TEXT NOT NULL CHECK (type IN ('system', 'user')),
          color TEXT,
          UNIQUE (account_id, remote_id)
        );
        CREATE INDEX idx_labels_account ON labels(account_id);

        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          remote_id TEXT,
          subject TEXT NOT NULL DEFAULT '',
          last_message_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_threads_account_date ON threads(account_id, last_message_at DESC);

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          remote_id TEXT NOT NULL,
          message_id_header TEXT,
          in_reply_to TEXT,
          refs TEXT NOT NULL DEFAULT '',
          subject TEXT NOT NULL DEFAULT '',
          from_name TEXT,
          from_email TEXT NOT NULL DEFAULT '',
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          reply_to_json TEXT NOT NULL DEFAULT '[]',
          date INTEGER NOT NULL,
          snippet TEXT NOT NULL DEFAULT '',
          has_attachments INTEGER NOT NULL DEFAULT 0,
          direction TEXT NOT NULL DEFAULT 'incoming',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (account_id, remote_id)
        );
        CREATE INDEX idx_messages_thread ON messages(thread_id, date);
        CREATE INDEX idx_messages_date ON messages(date DESC);
        CREATE INDEX idx_messages_msgid ON messages(account_id, message_id_header);

        CREATE TABLE bodies (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          html TEXT,
          text TEXT
        );

        CREATE TABLE message_labels (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          label_id TEXT NOT NULL,
          PRIMARY KEY (message_id, label_id)
        );
        CREATE INDEX idx_message_labels_label ON message_labels(label_id);

        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          remote_attachment_id TEXT,
          content_id TEXT,
          inline INTEGER NOT NULL DEFAULT 0,
          file_path TEXT,
          downloaded INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_attachments_message ON attachments(message_id);

        CREATE TABLE identities (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          signature_html TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'user',
          UNIQUE (account_id, email)
        );

        CREATE TABLE mutation_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          op TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          state TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_queue_state ON mutation_queue(state, id);

        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          identity_name TEXT NOT NULL,
          identity_email TEXT NOT NULL,
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          html TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '',
          attachments_json TEXT NOT NULL DEFAULT '[]',
          reply_to_message_id TEXT,
          state TEXT NOT NULL DEFAULT 'undoable',
          send_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          sent_message_id TEXT
        );
        CREATE INDEX idx_outbox_state ON outbox(state, send_at);

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE sync_cursors (
          account_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          cursor TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, kind)
        );

        CREATE VIRTUAL TABLE messages_fts USING fts5(
          message_id UNINDEXED,
          account_id UNINDEXED,
          subject,
          participants,
          body,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE message_id = old.id;
        END;
      `)
    }
  },
  {
    id: 2,
    name: 'account error detail',
    up: (db) => {
      // A failing account used to show only a coloured dot. Keeping the last
      // cause lets the sidebar say *why* an account stopped syncing.
      db.exec(`ALTER TABLE accounts ADD COLUMN last_error TEXT`)
    }
  },
  {
    id: 3,
    name: 'message addresses',
    up: (db) => {
      // `from:`/`to:` used to be substring tests against the JSON blobs, which
      // matched across field boundaries and could not use an index. Normalising
      // the addresses makes those operators exact and gives the search box a
      // sender list to autocomplete from.
      db.exec(`
        CREATE TABLE message_addresses (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('from', 'to', 'cc', 'bcc', 'reply_to')),
          email TEXT NOT NULL,
          name TEXT,
          PRIMARY KEY (message_id, kind, email)
        ) WITHOUT ROWID;
        CREATE INDEX idx_message_addresses_email ON message_addresses(email, kind);
      `)

      db.exec(`
        INSERT OR IGNORE INTO message_addresses (message_id, kind, email, name)
        SELECT id, 'from', LOWER(from_email), from_name
        FROM messages WHERE from_email <> ''
      `)
      // The recipient columns are JSON arrays of {name, email}; json_each walks
      // them without pulling every message through JavaScript.
      for (const [kind, column] of [
        ['to', 'to_json'],
        ['cc', 'cc_json'],
        ['bcc', 'bcc_json'],
        ['reply_to', 'reply_to_json']
      ]) {
        db.exec(`
          INSERT OR IGNORE INTO message_addresses (message_id, kind, email, name)
          SELECT m.id, '${kind}', LOWER(json_extract(v.value, '$.email')),
                 json_extract(v.value, '$.name')
          FROM messages m, json_each(m.${column}) v
          WHERE json_extract(v.value, '$.email') IS NOT NULL
            AND json_extract(v.value, '$.email') <> ''
        `)
      }
    }
  },
  {
    id: 4,
    name: 'local drafts',
    up: (db) => {
      // A compose window used to live only in the renderer, so closing it threw
      // the text away. Drafts are editing state, not mail: recipients are kept
      // as typed, and the body keeps the signature the editor shows.
      db.exec(`
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'reply', 'forward')),
          identity_id TEXT,
          identity_name TEXT NOT NULL DEFAULT '',
          identity_email TEXT NOT NULL DEFAULT '',
          to_text TEXT NOT NULL DEFAULT '',
          cc_text TEXT NOT NULL DEFAULT '',
          bcc_text TEXT NOT NULL DEFAULT '',
          subject TEXT NOT NULL DEFAULT '',
          html TEXT NOT NULL DEFAULT '',
          attachments_json TEXT NOT NULL DEFAULT '[]',
          reply_to_message_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_drafts_account_updated ON drafts(account_id, updated_at DESC);
      `)
    }
  },
  {
    id: 5,
    name: 'draft mirroring',
    up: (db) => {
      // Gmail keeps drafts under their own id, separate from the message inside
      // them — editing one replaces the message and its id. Both are tracked, so
      // a remote edit is recognised without fetching the body every sync.
      db.exec(`
        ALTER TABLE drafts ADD COLUMN remote_id TEXT;
        ALTER TABLE drafts ADD COLUMN remote_message_id TEXT;
        ALTER TABLE drafts ADD COLUMN remote_updated_at INTEGER;
        ALTER TABLE drafts ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX idx_drafts_remote ON drafts(account_id, remote_id);
      `)
    }
  },
  {
    id: 6,
    name: 'drop imported drafts',
    up: (db) => {
      // Gmail lists drafts among a thread's messages, so the initial import
      // pulled them in as mail. They showed up as the newest message of their
      // conversation — an answer the user never sent. The drafts table is the
      // only place they belong; the sync skips them from now on.
      db.exec(`
        DELETE FROM messages WHERE id IN (
          SELECT ml.message_id FROM message_labels ml
          JOIN labels l ON l.id = ml.label_id
          WHERE l.remote_id = 'DRAFT'
        );

        UPDATE threads SET last_message_at = COALESCE(
          (SELECT MAX(date) FROM messages WHERE thread_id = threads.id), last_message_at
        );
        DELETE FROM threads WHERE NOT EXISTS (
          SELECT 1 FROM messages WHERE thread_id = threads.id
        );
      `)
    }
  },
  {
    id: 7,
    name: 'identity signature override and verification',
    up: (db) => {
      // The sendAs list is re-read on every sync from now on. Gmail owns name,
      // address and verification state, but the signature is editable here —
      // its API exposes only one signature per alias, so a locally typed one is
      // the only way to keep the others. `gmail_signature_html` records what
      // Gmail last sent: it differs from `signature_html` exactly when the user
      // edited it, and only then does the local text survive the next sync.
      db.exec(`
        ALTER TABLE identities ADD COLUMN gmail_signature_html TEXT;
        ALTER TABLE identities ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;
        UPDATE identities SET gmail_signature_html = signature_html
        WHERE source = 'gmail_sendas';
      `)
    }
  },
  {
    id: 8,
    name: 'snoozes',
    up: (db) => {
      // Gmail's API has no snooze endpoint — snoozing is a web-only feature
      // there. So a snoozed conversation is simply archived and this table
      // remembers when to put it back; one row per thread, because that is the
      // unit the user acts on.
      db.exec(`
        CREATE TABLE snoozes (
          thread_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          wake_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          -- Highest message row the conversation held when it was put aside.
          -- A row above it means mail arrived since, which ends the snooze
          -- early. Insertion order rather than a timestamp: it needs no
          -- assumption about whose clock stamped the mail, and two mails
          -- stored in the same millisecond still tell each other apart.
          seen_message_row INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_snoozes_wake ON snoozes(wake_at);
        CREATE INDEX idx_snoozes_account ON snoozes(account_id);
      `)
    }
  },
  {
    id: 9,
    name: 'follow ups',
    up: (db) => {
      // The outbound mirror of the inbox: what was sent and is still waiting
      // for an answer. One open row per conversation — writing again into a
      // waiting thread moves that row rather than adding a second reminder,
      // which the partial unique index makes impossible to get wrong.
      //
      // `auto_reply` rides along because it is what keeps an out-of-office
      // notice from counting as the answer. Gmail's vacation responder keeps
      // the original subject and marks itself only in the headers, so without
      // this column the wait would end on a mail nobody wrote.
      db.exec(`
        ALTER TABLE messages ADD COLUMN auto_reply INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE outbox ADD COLUMN follow_up_days INTEGER;

        CREATE TABLE follow_ups (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL DEFAULT '',
          message_id TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
          resolved_at INTEGER,
          resolved_reason TEXT,
          nudge_count INTEGER NOT NULL DEFAULT 0,
          notified_at INTEGER
        );
        CREATE UNIQUE INDEX idx_follow_ups_open_thread
          ON follow_ups(thread_id) WHERE state = 'open' AND thread_id <> '';
        CREATE INDEX idx_follow_ups_due ON follow_ups(state, due_at);
        CREATE INDEX idx_follow_ups_account ON follow_ups(account_id);
      `)
    }
  },
  {
    id: 10,
    name: 'signature library',
    up: (db) => {
      // A signature stops belonging to one address. The same block is usually
      // wanted under several of them — and one address wants more than one: a
      // full one for a first mail, a short one for the fifth reply. So the
      // texts live on their own and an identity only points at the one it
      // starts a draft with; the draft may still pick another.
      db.exec(`
        CREATE TABLE signatures (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          html TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        ALTER TABLE identities
          ADD COLUMN signature_id TEXT REFERENCES signatures(id) ON DELETE SET NULL;
      `)

      // Identical texts become one entry, which is the whole point: editing the
      // company footer once has to reach every address that signs with it. The
      // address it came from is the only name we can give it.
      const rows = db
        .prepare(
          `SELECT signature_html AS html, min(email) AS email
             FROM identities
            WHERE signature_html IS NOT NULL AND trim(signature_html) <> ''
            GROUP BY signature_html`
        )
        .all() as Array<{ html: string; email: string }>
      const insert = db.prepare(
        'INSERT INTO signatures (id, name, html, created_at) VALUES (?, ?, ?, ?)'
      )
      const link = db.prepare('UPDATE identities SET signature_id = ? WHERE signature_html = ?')
      const now = Date.now()
      for (const row of rows) {
        const id = newId()
        insert.run(id, row.email, row.html, now)
        link.run(id, row.html)
      }

      // Dropped rather than kept in step: two places holding the same text is
      // how they drift apart. What Gmail last sent stays — it is what tells an
      // imported signature from one that was edited here.
      db.exec('ALTER TABLE identities DROP COLUMN signature_html;')
    }
  },
  {
    id: 11,
    name: 'snooze high-water mark by row',
    up: (db) => {
      // Migration 8 was rewritten after it had already run here: it once
      // stamped the moment a snooze started (`seen_message_at`) and now keeps
      // the highest message row instead. An applied migration never runs
      // again, so databases from before that rewrite need this step — and
      // those created after it already have the column, hence the check.
      const columns = db.prepare('PRAGMA table_info(snoozes)').all() as { name: string }[]
      if (columns.some((column) => column.name === 'seen_message_row')) return

      db.exec('ALTER TABLE snoozes ADD COLUMN seen_message_row INTEGER NOT NULL DEFAULT 0;')
      // The old timestamp still says what had arrived back then: everything
      // stored up to that moment counts as seen, so the snooze keeps waiting
      // for genuinely new mail instead of waking on the mail it was given.
      db.exec(`
        UPDATE snoozes SET seen_message_row = COALESCE((
          SELECT MAX(m.rowid) FROM messages m
          WHERE m.thread_id = snoozes.thread_id AND m.date <= snoozes.seen_message_at
        ), 0);
      `)
      db.exec('ALTER TABLE snoozes DROP COLUMN seen_message_at;')
    }
  },
  {
    id: 12,
    name: 'remote image trust',
    up: (db) => {
      db.exec(`
        CREATE TABLE remote_image_trust (
          kind TEXT NOT NULL CHECK (kind IN ('sender', 'domain')),
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (kind, value)
        ) WITHOUT ROWID;
      `)
      // Trust is also earned by having written to a domain, which means asking
      // for the host part of every stored address. An expression index answers
      // that without walking the table on every mail that gets opened.
      db.exec(`
        CREATE INDEX idx_message_addresses_domain
          ON message_addresses(substr(email, instr(email, '@') + 1), kind);
      `)
    }
  },
  {
    id: 13,
    name: 'mail templates',
    up: (db) => {
      db.exec(`
        CREATE TABLE templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          shortcut TEXT,
          subject TEXT NOT NULL DEFAULT '',
          html TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      // The shortcut is typed, so it is matched without regard to case — and
      // has to be unique the same way, or `/offerte` would have two answers.
      // A template without one is picker-only, and there may be any number of
      // those: a partial index leaves NULLs alone.
      db.exec(`
        CREATE UNIQUE INDEX idx_templates_shortcut
          ON templates(lower(shortcut)) WHERE shortcut IS NOT NULL;
      `)
    }
  },
  {
    id: 14,
    name: 'admin area',
    up: (db) => {
      // Mailboxes are views, not storage: Resend delivers a domain as one
      // catch-all, and a mailbox only names the addresses whose mail belongs
      // together. An address (or alias) can belong to one mailbox only, or a
      // message would show up under two names.
      db.exec(`
        CREATE TABLE mailboxes (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          address TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL DEFAULT '',
          identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
          sort INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_mailboxes_account ON mailboxes(account_id, sort);

        CREATE TABLE mailbox_aliases (
          mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
          address TEXT NOT NULL UNIQUE,
          PRIMARY KEY (mailbox_id, address)
        ) WITHOUT ROWID;
      `)

      db.exec(`
        CREATE TABLE routing_rules (
          id TEXT PRIMARY KEY,
          account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 0,
          match_field TEXT NOT NULL
            CHECK (match_field IN ('from', 'to', 'subject', 'body', 'any')),
          operator TEXT NOT NULL
            CHECK (operator IN ('contains', 'exact', 'starts_with', 'ends_with', 'regex')),
          value TEXT NOT NULL,
          action TEXT NOT NULL
            CHECK (action IN ('label', 'archive', 'mark_read', 'spam', 'trash', 'forward', 'drop')),
          action_arg TEXT,
          stop_processing INTEGER NOT NULL DEFAULT 1,
          match_count INTEGER NOT NULL DEFAULT 0,
          last_matched_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_routing_rules_priority ON routing_rules(priority);
      `)

      // Keyed by Resend's email id rather than the local message: mail sent
      // from a domain without receiving has no account and so no local
      // message, and its delivery status is exactly as interesting.
      db.exec(`
        CREATE TABLE deliveries (
          remote_id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          from_email TEXT NOT NULL DEFAULT '',
          to_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          sent_at INTEGER NOT NULL,
          last_event TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_deliveries_sent ON deliveries(sent_at DESC);
        CREATE INDEX idx_deliveries_event ON deliveries(last_event, sent_at DESC);
      `)

      db.exec(`
        CREATE TABLE activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          account_id TEXT,
          summary TEXT NOT NULL,
          meta_json TEXT NOT NULL DEFAULT '{}',
          count INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_activity_kind ON activity_log(kind, id DESC);
      `)

      // Resend keeps mail for 30 days and cannot delete it through the API.
      // A message a rule dropped locally would come straight back on the next
      // poll without a note that it was dropped on purpose.
      db.exec(`
        CREATE TABLE message_tombstones (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          remote_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, remote_id)
        ) WITHOUT ROWID;
      `)
    }
  }
]

export function migrate(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id)
  )
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
  let count = 0
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      migration.up(db)
      insert.run(migration.id, migration.name, Date.now())
    })()
    count += 1
  }
  return count
}
