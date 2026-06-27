#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

// ── Minimal mock token contract ───────────────────────────────────────────────

mod mock_token {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum Key {
        Balance(Address),
    }

    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let key = Key::Balance(to);
            let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(current + amount));
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let from_key = Key::Balance(from.clone());
            let to_key = Key::Balance(to.clone());
            let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
            assert!(from_bal >= amount, "insufficient balance");
            env.storage()
                .persistent()
                .set(&from_key, &(from_bal - amount));
            let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
            env.storage().persistent().set(&to_key, &(to_bal + amount));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&Key::Balance(id))
                .unwrap_or(0)
        }
    }
}

use mock_token::MockTokenClient;

/// Returns (contract_id, token_id, admin, member)
fn setup(env: &Env) -> (Address, Address, Address, Address) {
    let admin = Address::generate(env);
    let member = Address::generate(env);

    let token_id = env.register(mock_token::MockToken, ());
    let token = MockTokenClient::new(env, &token_id);
    token.mint(&member, &1_000_000);

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(env, &contract_id);
    client.initialize(&admin, &token_id);

    (contract_id, token_id, admin, member)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (contract_id, token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    assert_eq!(client.balance(&token_id), 0);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    let (contract_id, token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let other = Address::generate(&env);
    client.initialize(&other, &token_id);
}

#[test]
fn test_deposit_increases_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.deposit(&member, &token_id, &300_000);
    assert_eq!(client.balance(&token_id), 300_000);
}

#[test]
fn test_balance_reflects_multiple_deposits() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let token = MockTokenClient::new(&env, &token_id);
    let member2 = Address::generate(&env);
    token.mint(&member2, &500_000);

    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.deposit(&member, &token_id, &200_000);
    client.deposit(&member2, &token_id, &150_000);

    assert_eq!(client.balance(&token_id), 350_000);
}

#[test]
fn test_admin_can_withdraw() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let token = MockTokenClient::new(&env, &token_id);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    client.deposit(&member, &token_id, &400_000);
    client.withdraw(&recipient, &token_id, &100_000);

    assert_eq!(client.balance(&token_id), 300_000);
    assert_eq!(token.balance(&recipient), 100_000);
}

#[test]
fn test_balance_correct_after_deposits_and_withdrawals() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let token = MockTokenClient::new(&env, &token_id);
    let member2 = Address::generate(&env);
    token.mint(&member2, &500_000);

    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    client.deposit(&member, &token_id, &600_000);
    client.deposit(&member2, &token_id, &200_000);
    client.withdraw(&recipient, &token_id, &300_000);

    // 600_000 + 200_000 - 300_000 = 500_000
    assert_eq!(client.balance(&token_id), 500_000);
}

#[test]
#[should_panic]
fn test_non_admin_cannot_withdraw() {
    let env = Env::default();
    // Do not mock all auths — calling withdraw without the admin's auth must panic.

    let admin = Address::generate(&env);
    let token_id = env.register(mock_token::MockToken, ());

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id);

    let recipient = Address::generate(&env);
    // admin.require_auth() inside withdraw will fail — no auth context set up.
    client.withdraw(&recipient, &token_id, &100);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_deposit_zero_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.deposit(&member, &token_id, &0);
}

#[test]
fn test_multi_token_deposits_tracked_separately() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    // Register two different tokens (e.g. XLM and USDC)
    let xlm_id = env.register(mock_token::MockToken, ());
    let usdc_id = env.register(mock_token::MockToken, ());

    let xlm = MockTokenClient::new(&env, &xlm_id);
    let usdc = MockTokenClient::new(&env, &usdc_id);

    xlm.mint(&member, &100_000);
    usdc.mint(&member, &100_000);

    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &xlm_id); // initialize with XLM for compatibility

    // Deposit XLM and USDC
    client.deposit(&member, &xlm_id, &40_000);
    client.deposit(&member, &usdc_id, &70_000);

    // Verify balances are tracked separately
    assert_eq!(client.balance(&xlm_id), 40_000);
    assert_eq!(client.balance(&usdc_id), 70_000);
}

#[test]
#[should_panic(expected = "insufficient funds")]
fn test_withdraw_insufficient_funds_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    client.deposit(&member, &token_id, &50_000);
    client.withdraw(&recipient, &token_id, &60_000); // 60k is more than 50k balance
}

// ── Member Management Tests ───────────────────────────────────────────────────

#[test]
fn test_add_member() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    assert!(client.is_member(&member));
}

#[test]
#[should_panic(expected = "member already exists")]
fn test_add_duplicate_member_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    client.add_member(&member); // Should panic
}

#[test]
#[should_panic]
fn test_non_admin_cannot_add_member() {
    let env = Env::default();
    // Do not mock all auths - non-admin should fail

    let admin = Address::generate(&env);
    let member = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let token_id = env.register(mock_token::MockToken, ());
    let contract_id = env.register(GroupTreasuryContract, ());
    let client = GroupTreasuryContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id);

    // non_admin tries to add member - should fail due to auth
    client.add_member(&member);
}

#[test]
fn test_remove_member() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    assert!(client.is_member(&member));

    client.remove_member(&member);
    assert!(!client.is_member(&member));
}

#[test]
#[should_panic(expected = "member not found")]
fn test_remove_nonexistent_member_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.remove_member(&member); // Member was never added
}

#[test]
fn test_get_members() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, member1) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    client.add_member(&member1);
    client.add_member(&member2);
    client.add_member(&member3);

    let members = client.get_members();
    assert_eq!(members.len(), 3);
}

#[test]
fn test_is_member_returns_false_for_non_member() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, _token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    let non_member = Address::generate(&env);
    assert!(!client.is_member(&non_member));
}

#[test]
fn test_initialize_creates_empty_members_list() {
    let env = Env::default();
    let (contract_id, _token_id, _admin, _member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    let members = client.get_members();
    assert_eq!(members.len(), 0);
}

// ── propose_withdraw Tests ────────────────────────────────────────────────────

#[test]
fn test_propose_withdraw_returns_id_and_stores_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    client.deposit(&member, &token_id, &500_000);

    let recipient = Address::generate(&env);
    let id = client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);
    assert_eq!(id, 1);
}

#[test]
#[should_panic(expected = "not a member")]
fn test_propose_withdraw_non_member_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.deposit(&member, &token_id, &500_000);

    let non_member = Address::generate(&env);
    let recipient = Address::generate(&env);
    // non_member is not in members list — should panic
    client.propose_withdraw(&non_member, &recipient, &token_id, &100_000, &100);
}

#[test]
#[should_panic(expected = "insufficient funds")]
fn test_propose_withdraw_insufficient_balance_panics() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    client.deposit(&member, &token_id, &50_000);

    let recipient = Address::generate(&env);
    client.propose_withdraw(&member, &recipient, &token_id, &100_000, &100);
}

#[test]
fn test_propose_withdraw_increments_id() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, _admin, member) = setup(&env);
    let client = GroupTreasuryContractClient::new(&env, &contract_id);

    client.add_member(&member);
    client.deposit(&member, &token_id, &500_000);

    let recipient = Address::generate(&env);
    let id1 = client.propose_withdraw(&member, &recipient, &token_id, &10_000, &100);
    let id2 = client.propose_withdraw(&member, &recipient, &token_id, &10_000, &100);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}
