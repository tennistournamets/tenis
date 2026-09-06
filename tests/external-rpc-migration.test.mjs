import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {createDatabase,fixture,asActor,matches,snapshot,winningSets} from './helpers/database.mjs'

test('external RPC migration is repeatable, clears older table/column grants and preserves tournament data',async()=>{
  const ctx=await createDatabase()
  try {
    const t=await fixture(ctx)
    await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
    const m=(await matches(ctx,t.id)).find(m=>m.status==='ready')
    await asActor(ctx,'owner','select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))',[m.id,winningSets])
    const before=await snapshot(ctx)
    // Historical migrations must be repeatable, even when later patches have
    // changed canonical function bodies. Compare this patch with its own result.
    let definitions
    await ctx.db.exec(`grant all on matches,match_sets,groups,group_entries,live_scores,entries to anon,authenticated;
      grant update(next_match_id),insert(tournament_id) on matches to public,anon,authenticated;
      grant update(tournament_id) on entries to public;
      grant update(entry_id),insert(entry_id) on group_entries to public;`)
    const migration=await readFile(new URL('../supabase/upgrades/20260905201035_harden_external_rpc_boundaries.sql',import.meta.url),'utf8')
    for (let pass=0;pass<2;pass++) {
      await ctx.db.exec(migration)
      assert.deepEqual(await snapshot(ctx),before)
      const applied=(await ctx.db.query("select proname,pg_get_functiondef(oid) as body from pg_proc where pronamespace='public'::regnamespace order by proname,oid")).rows
      if(pass===0)definitions=applied
      else assert.deepEqual(applied,definitions)
      const checks=await ctx.db.exec(await readFile(new URL('../supabase/checks/external_rpc_access.sql',import.meta.url),'utf8'))
      assert.equal(checks[0].rows.length,28)
      assert.ok(checks[0].rows.every(r=>r.passed===true),JSON.stringify(checks[0].rows.filter(r=>!r.passed)))
      assert.ok(checks[2].rows.every(r=>r.invalid_links===0))
      const functions=checks[3].rows
      assert.equal(functions.length,8)
      assert.ok(functions.every(r=>r.security_definer && r.authenticated_execute===!['propagate_winner','clear_downstream'].includes(r.proname)))
    }
  } finally {await ctx.db.close()}
})
