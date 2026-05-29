#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

fn setup(env: &Env) -> (GroupTreasuryContractClient<'_>, Address, Address, Address) {
    let admin = Address::generate(env);
    let member1 = Address::generate(env);
    let member2 = Address::generate(env);
    let members = vec![&env, member1.clone(), member2.clone()];

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(env, &contract_id);
    client.initialize(&admin, &members);

    (client, admin, member1, member2)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, member1, member2) = setup(&env);

    assert_eq!(client.admin(), admin);
    let stored = client.members();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored.get(0).unwrap(), member1);
    assert_eq!(stored.get(1).unwrap(), member2);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _m1, _m2) = setup(&env);
    let empty = vec![&env];
    client.initialize(&admin, &empty);
}

#[test]
fn test_add_member() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _m1, _m2) = setup(&env);
    let new_member = Address::generate(&env);

    client.add_member(&new_member);
    assert_eq!(client.members().len(), 3);
}

#[test]
#[should_panic(expected = "already a member")]
fn test_add_duplicate_member_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, member1, _m2) = setup(&env);
    client.add_member(&member1);
}

#[test]
fn test_remove_member() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, member1, _m2) = setup(&env);

    client.remove_member(&member1);
    assert_eq!(client.members().len(), 1);

    // Remaining member is member2
    let remaining = client.members();
    assert_eq!(remaining.get(0).unwrap(), _m2);
}

#[test]
#[should_panic(expected = "cannot remove admin")]
fn test_remove_admin_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _m1, _m2) = setup(&env);
    client.remove_member(&admin);
}

#[test]
fn test_deposit_by_member() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, member1, _m2) = setup(&env);

    client.deposit(&member1, &1000);
    assert_eq!(client.balance(&member1), 1000);

    client.deposit(&member1, &500);
    assert_eq!(client.balance(&member1), 1500);
}

#[test]
#[should_panic(expected = "unauthorized: not a member")]
fn test_deposit_by_non_member_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _m1, _m2) = setup(&env);
    let non_member = Address::generate(&env);
    client.deposit(&non_member, &100);
}

#[test]
fn test_removed_member_balance_persists() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, member1, _m2) = setup(&env);

    client.deposit(&member1, &1000);
    assert_eq!(client.balance(&member1), 1000);

    client.remove_member(&member1);

    // Balance is preserved after removal
    assert_eq!(client.balance(&member1), 1000);
    // Member is no longer in the list
    let members = client.members();
    assert_eq!(members.len(), 1);
    assert_eq!(members.get(0).unwrap(), _m2);
}

#[test]
#[should_panic(expected = "unauthorized: not a member")]
fn test_removed_member_cannot_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, member1, _m2) = setup(&env);

    client.deposit(&member1, &1000);
    client.remove_member(&member1);

    // Former member cannot deposit
    client.deposit(&member1, &500);
}


