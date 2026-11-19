import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/storage/memory.js';
import { State } from '../src/core/state.js';

function setupState() {
  const store = new MemoryStore();
  const state = new State(store);
  return { store, state };
}

test('State: createPm initializes teamIds with all currently active teams', async () => {
  const { state } = setupState();

  // 1. Create two active teams
  const t1 = await state.createTeam({ name: 'Frontend', roleId: 'role_front' });
  const t2 = await state.createTeam({ name: 'Backend', roleId: 'role_back' });

  // 2. Create a new PM
  const pm = await state.createPm({ name: 'Alice Walker', discordUserId: 'user_alice' });

  // 3. Verify the PM's teamIds contains both active teams
  assert.equal(pm.teamIds.length, 2);
  assert.ok(pm.teamIds.includes(t1.id));
  assert.ok(pm.teamIds.includes(t2.id));

  // Verify persistence in store
  const storedPm = await state.getPm(pm.id);
  assert.deepEqual(storedPm.teamIds, [t1.id, t2.id]);
});

test('State: createPm handles case when no teams exist yet', async () => {
  const { state } = setupState();

  const pm = await state.createPm({ name: 'Bob Stone', discordUserId: 'user_bob' });
  assert.ok(Array.isArray(pm.teamIds));
  assert.equal(pm.teamIds.length, 0);
});

test('State: assignTeamToAllPms adds teamId to all active PMs preserving existing attributes', async () => {
  const { state } = setupState();

  // Create active PMs before the team exists
  const pm1 = await state.createPm({ name: 'PM One', discordUserId: 'user_1' });
  const pm2 = await state.createPm({ name: 'PM Two', discordUserId: 'user_2' });

  // Set custom attributes on PM1
  await state.updatePm(pm1.id, { repo: { owner: 'ipdc', name: 'proj1' } });

  // Assign team manually via assignTeamToAllPms
  const teamId = 'team_ai_ml';
  const updatedList = await state.assignTeamToAllPms(teamId);

  assert.equal(updatedList.length, 2);

  const fresh1 = await state.getPm(pm1.id);
  const fresh2 = await state.getPm(pm2.id);

  assert.ok(fresh1.teamIds.includes(teamId));
  assert.ok(fresh2.teamIds.includes(teamId));

  // Check preservation of existing fields
  assert.equal(fresh1.name, 'PM One');
  assert.equal(fresh1.discordUserId, 'user_1');
  assert.equal(fresh1.repo.name, 'proj1');
});

test('State: assignTeamToAllPms is idempotent and does not create duplicate entries', async () => {
  const { state } = setupState();

  const pm = await state.createPm({ name: 'PM Idempotent', discordUserId: 'user_idem' });
  const teamId = 'team_testing';

  // Call assignTeamToAllPms multiple times
  await state.assignTeamToAllPms(teamId);
  await state.assignTeamToAllPms(teamId);
  await state.assignTeamToAllPms(teamId);

  const fresh = await state.getPm(pm.id);
  const occurrences = fresh.teamIds.filter((id) => id === teamId).length;
  assert.equal(occurrences, 1, 'teamId appears exactly once');
});

test('State: assignTeamToAllPms ignores removed PMs', async () => {
  const { state } = setupState();

  const activePm = await state.createPm({ name: 'Active PM', discordUserId: 'user_act' });
  const removedPm = await state.createPm({ name: 'Removed PM', discordUserId: 'user_rem' });
  await state.updatePm(removedPm.id, { status: 'removed' });

  await state.assignTeamToAllPms('team_new');

  const freshActive = await state.getPm(activePm.id);
  const freshRemoved = await state.getPm(removedPm.id);

  assert.ok(freshActive.teamIds.includes('team_new'));
  assert.ok(!freshRemoved.teamIds.includes('team_new'), 'removed PM was untouched');
});

test('State: ensureGlobalTeamRoleAssignments backfills missing teams and prunes obsolete ones', async () => {
  const { state } = setupState();

  // Create teams
  const t1 = await state.createTeam({ name: 'Cloud' });
  const t2 = await state.createTeam({ name: 'DevOps' });

  // Create a PM with desynchronized team assignments
  const pm = await state.createPm({ name: 'Desynced PM', discordUserId: 'user_desync' });
  // Manually corrupt assignments: include a non-existent obsolete team, exclude t2
  await state.updatePm(pm.id, { teamIds: ['obsolete_team_999', t1.id] });

  const beforeSync = await state.getPm(pm.id);
  assert.ok(beforeSync.teamIds.includes('obsolete_team_999'));
  assert.ok(!beforeSync.teamIds.includes(t2.id));

  // Run backfill / reconciliation helper
  await state.ensureGlobalTeamRoleAssignments();

  const afterSync = await state.getPm(pm.id);
  assert.equal(afterSync.teamIds.length, 2);
  assert.ok(afterSync.teamIds.includes(t1.id));
  assert.ok(afterSync.teamIds.includes(t2.id));
  assert.ok(!afterSync.teamIds.includes('obsolete_team_999'), 'obsolete team pruned');
});

test('State: ensureGlobalTeamRoleAssignments is fully idempotent', async () => {
  const { state } = setupState();

  const t1 = await state.createTeam({ name: 'Team Alpha' });
  const pm = await state.createPm({ name: 'PM Alpha', discordUserId: 'user_alpha' });

  await state.ensureGlobalTeamRoleAssignments();
  const snap1 = await state.getPm(pm.id);

  await state.ensureGlobalTeamRoleAssignments();
  const snap2 = await state.getPm(pm.id);

  await state.ensureGlobalTeamRoleAssignments();
  const snap3 = await state.getPm(pm.id);

  assert.deepEqual(snap1.teamIds, snap2.teamIds);
  assert.deepEqual(snap2.teamIds, snap3.teamIds);
});

test('State: createTeam automatically assigns new team to existing PMs', async () => {
  const { state } = setupState();

  const pm1 = await state.createPm({ name: 'Leader One', discordUserId: 'lead_1' });
  const pm2 = await state.createPm({ name: 'Leader Two', discordUserId: 'lead_2' });

  // Creating a team should automatically update all PMs in the state
  const t = await state.createTeam({ name: 'Cybersecurity', roleId: 'role_cyber' });

  const p1 = await state.getPm(pm1.id);
  const p2 = await state.getPm(pm2.id);

  assert.ok(p1.teamIds.includes(t.id));
  assert.ok(p2.teamIds.includes(t.id));
});

test('State: concurrent createTeam calls are deduplicated safely', async () => {
  const { state } = setupState();

  // Fire 3 concurrent createTeam calls with same name and roleId
  const [t1, t2, t3] = await Promise.all([
    state.createTeam({ name: 'Concurrent Team', roleId: 'role_conc' }),
    state.createTeam({ name: 'Concurrent Team', roleId: 'role_conc' }),
    state.createTeam({ name: 'Concurrent Team', roleId: 'role_conc' }),
  ]);

  assert.equal(t1.id, t2.id);
  assert.equal(t2.id, t3.id);

  const teams = await state.teams();
  const matches = teams.filter((t) => t.name === 'Concurrent Team');
  assert.equal(matches.length, 1, 'only one team created in store');
});

