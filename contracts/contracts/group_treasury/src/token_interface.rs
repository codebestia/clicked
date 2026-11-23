use soroban_sdk::{contractclient, Address, Env};

/// Minimal SEP-41 token interface used to invoke external token contracts.
#[contractclient(name = "TokenClient")]
#[allow(dead_code)] // Trait is used to generate TokenClient via macro
pub trait TokenInterface {
    fn transfer(env: Env, from: Address, to: Address, amount: i128);
    fn balance(env: Env, id: Address) -> i128;
}
