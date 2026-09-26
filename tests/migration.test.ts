// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

const accountA = '11111111-1111-4111-8111-111111111111'
const accountB = '22222222-2222-4222-8222-222222222222'
const noteId = '33333333-3333-4333-8333-333333333333'
const mutationId = '44444444-4444-4444-8444-444444444444'

describe('PostgreSQL migration contract', () => {
  it('applies, enforces account ownership, and makes retries idempotent', async () => {
    const pg = new PGlite()
    try {
      await pg.exec(`
        create role anon;
        create role authenticated;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema auth to authenticated;
      `)
      const path = fileURLToPath(new URL('../supabase/migrations/202609250001_init.sql', import.meta.url))
      await pg.exec(await readFile(path, 'utf8'))
      const functionModes = await pg.query<{ schema: string; name: string; privileged: boolean }>(`
        select n.nspname as schema, p.proname as name, p.prosecdef as privileged
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname in ('apply_mutation', 'apply_mutation_core')
      `)
      expect(functionModes.rows).toEqual(expect.arrayContaining([
        { schema: 'public', name: 'apply_mutation', privileged: false },
        { schema: 'app_private', name: 'apply_mutation_core', privileged: true }
      ]))

      await pg.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', accountA])
      await pg.exec('set role authenticated')
      const payload = {
        title: '本地测试', doc: { type: 'doc', content: [{ type: 'paragraph' }] }, docVersion: 1,
        plainText: '正文', folderId: null, isPinned: false, deletedAt: null
      }
      const apply = (id: string, base: number, body: object) => pg.query<{ result: { status: string; seq?: string; record?: { version: number } } }>(
        'select public.apply_mutation($1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb) as result',
        [id, 'note', noteId, base, JSON.stringify(body)]
      )
      const first = (await apply(mutationId, 0, payload)).rows[0].result
      expect(first).toMatchObject({ status: 'ok', seq: '1', record: { version: 1 } })
      await expect(pg.query('insert into public.notes (id, owner_id, doc, version) values ($1::uuid, $2::uuid, $3::jsonb, 1)',
        ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountA, JSON.stringify(payload.doc)])).rejects.toThrow('permission denied')
      expect((await apply(mutationId, 0, payload)).rows[0].result).toEqual(first)
      await expect(apply(mutationId, 0, { ...payload, title: '篡改' })).rejects.toThrow('Mutation ID reused')
      await expect(apply('77777777-7777-4777-8777-777777777777', 1, { ...payload, title: '字'.repeat(256) })).rejects.toThrow('Invalid note')
      const conflict = (await apply('55555555-5555-4555-8555-555555555555', 0, payload)).rows[0].result
      expect(conflict).toMatchObject({ status: 'conflict', record: { version: 1 } })

      const rejectedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      await expect(apply(rejectedId, 1, { ...payload, plainText: '字'.repeat(100_000) })).rejects.toThrow('Mutation too large')
      expect((await apply(rejectedId, 1, { ...payload, plainText: '已缩短' })).rows[0].result)
        .toMatchObject({ status: 'ok', record: { version: 2 } })

      const folderId = '88888888-8888-4888-8888-888888888888'
      const folderApply = (mutation: string, base: number, deletedAt: string | null) => pg.query(
        'select public.apply_mutation($1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb) as result',
        [mutation, 'folder', folderId, base, JSON.stringify({ name: '已删除的分类', sortOrder: 0, deletedAt })]
      )
      await folderApply('99999999-9999-4999-8999-999999999999', 0, null)
      await folderApply('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, new Date().toISOString())
      await expect(pg.query(
        'select public.apply_mutation($1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb) as result',
        ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'note', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0,
          JSON.stringify({ ...payload, folderId })]
      )).rejects.toThrow('Folder does not belong to account')

      const pulled = await pg.query<{ result: { items: unknown[]; next: string } }>(
        'select public.pull_changes($1, $2) as result', ['0', 100]
      )
      expect(pulled.rows[0].result).toMatchObject({ next: '4' })
      expect(pulled.rows[0].result.items).toHaveLength(4)
      await pg.exec('reset role')
      await pg.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', accountB])
      await pg.exec('set role authenticated')
      const otherPull = await pg.query<{ result: { items: unknown[] } }>(
        'select public.pull_changes($1, $2) as result', ['0', 100]
      )
      expect(otherPull.rows[0].result.items).toHaveLength(0)
      const otherRead = await pg.query('select id from public.notes')
      expect(otherRead.rows).toHaveLength(0)
      expect((await pg.query('select id from public.folders')).rows).toHaveLength(0)
      expect((await pg.query('select seq from public.sync_changes')).rows).toHaveLength(0)
      expect((await pg.query('select version from public.note_history')).rows).toHaveLength(0)
      const deniedMutation = (await apply('66666666-6666-4666-8666-666666666666', 1, payload)).rows[0].result
      expect(deniedMutation).toMatchObject({ status: 'conflict', record: null })
      await expect(pg.query('update public.notes set title = $1 where id = $2::uuid', ['越权', noteId])).rejects.toThrow('permission denied')
      await expect(pg.query('delete from public.notes where id = $1::uuid', [noteId])).rejects.toThrow('permission denied')
      await expect(pg.query('select * from public.processed_mutations')).rejects.toThrow('permission denied')
      await pg.exec('reset role')
      await pg.exec('set role anon')
      await expect(apply('ffffffff-ffff-4fff-8fff-ffffffffffff', 0, payload)).rejects.toThrow('permission denied')
      await expect(pg.query('select id from public.notes')).rejects.toThrow('permission denied')
      await expect(pg.query('select app_private.apply_mutation_core($1::uuid, $2, $3::uuid, $4::bigint, $5::jsonb)',
        ['ffffffff-ffff-4fff-8fff-ffffffffffff', 'note', noteId, 0, JSON.stringify(payload)])).rejects.toThrow('permission denied')
    } finally {
      await pg.close()
    }
  })
})

