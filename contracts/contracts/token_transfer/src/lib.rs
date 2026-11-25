#![no_std]

mod storage;
mod test;
mod token_interface;

use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env, Symbol};
use storage::{DataKey, TransferEvent};
use token_interface::TokenClient;

#[contract]
pub struct TokenTransferContract;

#[contractimpl]
impl TokenTransferContract {
    /// One-time initialisation. Sets the admin and the SEP-41 token this
    /// contract will route transfers through.
    pub fn initialize(env: Env, admin: Address, token_contract: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TokenContract, &token_contract);
    }

    /// Transfer `amount` of the configured token from `from` to `to`.
    /// `memo` is an optional opaque byte string (e.g. a message UUID) that is
    /// stored in the emitted event so the backend can correlate the transfer
    /// with a chat message.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128, memo: Bytes) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        // Require the sender's authorisation
        from.require_auth();

        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenContract)
            .expect("not initialized");

        let token = TokenClient::new(&env, &token_id);
        token.transfer(&from, &to, &amount);

        let event = TransferEvent {
            from: from.clone(),
            to: to.clone(),
            amount,
            memo,
        };

        env.events()
            .publish((Symbol::new(&env, "transfer"),), event);
    }

    /// Read the token balance of any address.
    pub fn balance(env: Env, address: Address) -> i128 {
        let token_id: Address = env
            .storage()
            .instance()
            .get(&DataKey::TokenContract)
            .expect("not initialized");

        TokenClient::new(&env, &token_id).balance(&address)
    }

    /// Returns the configured contract administrator address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Returns the configured token contract address.
    pub fn token_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::TokenContract)
            .expect("not initialized")
    }

    /// Admin-only: update the token contract (e.g. after a token migration).
    pub fn set_token_contract(env: Env, new_token: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TokenContract, &new_token);
    }

    /// Admin-only contract upgrade (#44). Swaps the contract's wasm in-place
    /// to the binary identified by `new_wasm_hash` (typically produced by
    /// `soroban contract install --wasm <new.wasm>`).
    ///
    /// Mirrors the canonical Soroban upgrade pattern; any non-admin caller
    /// is rejected at `admin.require_auth()`.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}
