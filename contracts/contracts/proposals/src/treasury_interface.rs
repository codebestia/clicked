use soroban_sdk::{contractclient, Address, Env};

/// Minimal interface for calling the group treasury contract.
#[contractclient(name = "TreasuryClient")]
pub trait TreasuryInterface {
    fn is_member(env: Env, member: Address) -> bool;
    fn balance(env: Env, token: Address) -> i128;
    fn withdraw(env: Env, to: Address, token: Address, amount: i128);
}
