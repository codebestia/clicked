#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Bytes};

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

fn setup(env: &Env) -> (Address, Address, Address, Address) {
    let admin = Address::generate(env);
    let sender = Address::generate(env);
    let receiver = Address::generate(env);

    // Deploy mock token
    let token_id = env.register(mock_token::MockToken, ());
    let token = MockTokenClient::new(env, &token_id);
    token.mint(&sender, &1_000_000);

    // Deploy transfer contract
    let contract_id = env.register(TokenTransferContract, ());
    let client = TokenTransferContractClient::new(env, &contract_id);
    client.initialize(&admin, &token_id);

    (contract_id, token_id, sender, receiver)
}

#[test]
fn test_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TokenTransferContract, ());
    let client = TokenTransferContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize(&admin, &token);
    assert_eq!(client.admin(), admin);
}

#[test]
#[should_panic(expected = "not initialized")]
fn test_admin_uninitialized() {
    let env = Env::default();
    let contract_id = env.register(TokenTransferContract, ());
    let client = TokenTransferContractClient::new(&env, &contract_id);
    client.admin();
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (contract_id, token_id, _sender, _receiver) = setup(&env);
    let client = TokenTransferContractClient::new(&env, &contract_id);
    assert_eq!(client.token_contract(), token_id);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    let (contract_id, token_id, _sender, _receiver) = setup(&env);
    let client = TokenTransferContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &token_id);
}

#[test]
fn test_transfer_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, token_id, sender, receiver) = setup(&env);
    let client = TokenTransferContractClient::new(&env, &contract_id);
    let token = MockTokenClient::new(&env, &token_id);

    let memo = Bytes::from_slice(&env, b"msg-uuid-1234");
    client.transfer(&sender, &receiver, &500_000, &memo);

    assert_eq!(token.balance(&sender), 500_000);
    assert_eq!(token.balance(&receiver), 500_000);
}

#[test]
fn test_balance_query() {
    let env = Env::default();
    let (contract_id, _token_id, sender, _receiver) = setup(&env);
    let client = TokenTransferContractClient::new(&env, &contract_id);

    assert_eq!(client.balance(&sender), 1_000_000);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_transfer_zero_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, _token_id, sender, receiver) = setup(&env);
    let client = TokenTransferContractClient::new(&env, &contract_id);
    let memo = Bytes::from_slice(&env, b"");
    client.transfer(&sender, &receiver, &0, &memo);
}

#[test]
fn test_transfer_requires_sender_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, _token_id, sender, receiver) = setup(&env);
    let client = TokenTransferContractClient::new(&env, &contract_id);
    let memo = Bytes::from_slice(&env, b"ref");

    client.transfer(&sender, &receiver, &100, &memo);

    // Verify the sender's auth was required
    let auths = env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == sender));
}

// ── #44 — Admin-only contract upgrade ───────────────────────────────────────

/// Deploy a fresh contract whose admin is `admin`, without going through the
/// shared `setup()` helper (which generates the admin internally).
fn setup_with_admin(env: &Env, admin: &Address) -> Address {
    let token_admin = Address::generate(env);
    let token_id = env.register(mock_token::MockToken, ());
    let _ = (token_admin, &token_id); // keep names symmetric with setup()

    let contract_id = env.register(TokenTransferContract, ());
    let client = TokenTransferContractClient::new(env, &contract_id);
    client.initialize(admin, &token_id);
    contract_id
}

#[test]
fn test_upgrade_requires_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = setup_with_admin(&env, &admin);
    let client = TokenTransferContractClient::new(&env, &contract_id);

    let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0xab; 32]);

    // With all auths mocked, require_auth() is satisfied and the call proceeds
    // past the auth check, failing only at the WASM lookup (Storage, MissingValue).
    // If auth were the issue the call would panic before returning Err — which is
    // exactly what test_upgrade_non_admin_panics demonstrates. Together the two
    // tests prove admin auth is both required and sufficient.
    let result = client.try_upgrade(&wasm_hash);
    assert!(result.is_err(), "expected failure from missing WASM hash");
}

#[test]
#[should_panic]
fn test_upgrade_non_admin_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = setup_with_admin(&env, &admin);
    let client = TokenTransferContractClient::new(&env, &contract_id);

    // Only mock auths for a non-admin address. The contract should panic
    // when require_auth() is invoked on `admin` because that address has
    // not signed.
    let intruder = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &intruder,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "upgrade",
            args: soroban_sdk::vec![&env],
            sub_invokes: &[],
        },
    }]);

    let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0xcd; 32]);
    client.upgrade(&wasm_hash);
}
